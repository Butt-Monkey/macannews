// Тянет новые посты канала через официальный Bot API Telegram
// (api.telegram.org) и добавляет их в news.json.
//
// Раньше скрипт читал t.me/s/<канал> напрямую, но с сети GitHub Actions этот
// конкретный домен устойчиво не резолвится (DNS-сбой) — похоже, именно t.me
// заблокирован на уровне сети GitHub Actions. api.telegram.org — другой
// домен, официальный API для ботов, резолвится нормально.
//
// Как это устроено:
// - Бот должен быть администратором канала — иначе он вообще не получает посты.
// - getUpdates отдаёт только НОВЫЕ посты с момента последнего запроса, поэтому
//   мы храним offset (id последнего обработанного апдейта) в
//   .github/state/telegram-offset.json и с каждым запуском продолжаем оттуда.
// - Новые посты добавляются в начало news.json, старые вытесняются за пределы
//   KEEP.
// - РЕДАКТИРОВАНИЕ: Telegram присылает отдельный тип апдейта
//   edited_channel_post — если пост, который уже есть в ленте, отредактировали
//   (текст и/или картинку), бот обновляет его на месте, не двигая позицию.
// - ПРОВЕРКА УДАЛЕНИЙ: Bot API не уведомляет об удалении постов напрямую, но
//   на каждом прогоне бот пробует скопировать (copyMessage) каждый уже
//   показанный пост себе в личку владельцу и сразу удаляет копию
//   (deleteMessage). Если пост ещё существует — копирование пройдёт, если
//   удалён из канала — Telegram вернёт ошибку, и пост убирается из ленты.
// - ДОБОР ДО KEEP: если после удаления в ленте осталось меньше KEEP постов,
//   бот пробует "дотянуться" за более старыми постами через forwardMessage
//   (тот же трюк, что при ручном бэкфилле, только теперь автоматически) —
//   идёт номерами назад от самого старого известного поста, пока не наберёт
//   KEEP или не упрётся в разумный предел попыток.
// - Для проверки удалений и добора бот должен знать chat_id личного чата с
//   владельцем — он сам запоминает его (.github/state/owner-chat.json), как
//   только владелец один раз напишет боту что угодно в личку.
// - Кнопка "Run workflow" в Actions запускает ровно эту же проверку вручную,
//   в любой момент, независимо от расписания.

const TOKEN = process.env.TG_BOT_TOKEN;
if (!TOKEN) throw new Error('Нет TG_BOT_TOKEN — секрет репозитория не задан или не передан в workflow');

const CHANNEL_FALLBACK = 'macan777macan777macan777';
const KEEP = 6;
const BACKFILL_MAX_ATTEMPTS = 25;   // сколько номеров назад пробовать, прежде чем сдаться
const IMG_DIR = 'assets/news';
const NEWS_FILE = 'news.json';
const STATE_FILE = '.github/state/telegram-offset.json';
const OWNER_FILE = '.github/state/owner-chat.json';

async function fetchWithRetry(url, attempts = 3, delayMs = 4000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res;
    } catch (e) {
      lastErr = e;
      console.warn(`Попытка ${i + 1}/${attempts} не удалась: ${e.message}`);
      if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// более мягкий вызов: читает JSON независимо от HTTP-статуса (Telegram
// возвращает {ok:false,...} с кодом 400 для «сообщение не найдено» —
// это ОЖИДАЕМЫЙ ответ, а не сбой сети)
async function apiCallLenient(method, params, attempts = 2) {
  const qs = new URLSearchParams(params).toString();
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}?${qs}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

function truncate(s, max = 480) {
  s = (s || '').trim();
  return s.length > max ? s.slice(0, max).trim() + '…' : s;
}

function bestPhoto(sizes) {
  if (!sizes || !sizes.length) return null;
  return sizes[sizes.length - 1];   // последний размер — самый крупный
}

async function downloadTelegramFile(fileId, destPath, fs) {
  const infoRes = await fetchWithRetry(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`);
  const info = await infoRes.json();
  if (!info.ok) throw new Error('getFile failed: ' + JSON.stringify(info));
  const fileRes = await fetchWithRetry(`https://api.telegram.org/file/bot${TOKEN}/${info.result.file_path}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());
  await fs.writeFile(destPath, buf);
}

// пробуем скопировать пост владельцу в личку и сразу стереть копию —
// успех значит "пост ещё существует", явная ошибка Telegram — "удалён".
// Сбой сети (не смогли даже спросить) — не удаляем, безопаснее оставить.
async function checkStillExists(messageId, ownerChatId) {
  let copyRes;
  try {
    copyRes = await apiCallLenient('copyMessage', {
      chat_id: String(ownerChatId),
      from_chat_id: '@' + CHANNEL_FALLBACK,
      message_id: String(messageId),
      disable_notification: 'true'
    });
  } catch (e) {
    console.warn(`Не удалось проверить пост ${messageId} (сеть) — оставляю как есть:`, e.message);
    return true;
  }
  if (!copyRes.ok) return false;
  try {
    await apiCallLenient('deleteMessage', { chat_id: String(ownerChatId), message_id: String(copyRes.result.message_id) });
  } catch (e) { /* не критично, если копию не удалось подчистить */ }
  return true;
}

// добираем более старые посты, пока не наберём need штук или не кончится лимит
// попыток. forwardMessage (в отличие от copyMessage) возвращает содержимое
// пересланного сообщения прямо в ответе — этого достаточно, чтобы восстановить
// текст и картинку без обращения к getUpdates.
async function backfillOlder(startId, need, ownerChatId, fs) {
  const filled = [];
  let candidate = startId - 1;
  let attempts = 0;
  while (filled.length < need && attempts < BACKFILL_MAX_ATTEMPTS && candidate > 0) {
    attempts++;
    let fwdRes;
    try {
      fwdRes = await apiCallLenient('forwardMessage', {
        chat_id: String(ownerChatId),
        from_chat_id: '@' + CHANNEL_FALLBACK,
        message_id: String(candidate),
        disable_notification: 'true'
      });
    } catch (e) {
      console.warn('Добор остановлен (сбой сети):', e.message);
      break;
    }
    if (fwdRes.ok) {
      const msg = fwdRes.result;
      try {
        await apiCallLenient('deleteMessage', { chat_id: String(ownerChatId), message_id: String(msg.message_id) });
      } catch (e) { /* не критично */ }

      const text = truncate(msg.text || msg.caption || '');
      if (text) {
        const origin = msg.forward_origin;
        const date = origin ? origin.date : (msg.forward_date || msg.date);
        const entry = {
          id: String(candidate),
          url: `https://t.me/${CHANNEL_FALLBACK}/${candidate}`,
          date: new Date(date * 1000).toISOString(),
          text,
          image: null
        };
        let photoSize = bestPhoto(msg.photo);
        if (!photoSize && msg.video) photoSize = msg.video.thumbnail || msg.video.thumb;
        if (photoSize) {
          try {
            await fs.mkdir(IMG_DIR, { recursive: true });
            const localPath = `${IMG_DIR}/${candidate}.jpg`;
            await downloadTelegramFile(photoSize.file_id, localPath, fs);
            entry.image = localPath;
          } catch (e) {
            console.warn(`Не удалось скачать картинку добора ${candidate}:`, e.message);
          }
        }
        filled.push(entry);
        console.log(`Добрал более старый пост ${candidate}.`);
      }
    }
    // !ok — такого сообщения нет (удалено/никогда не было текстом/фото) — идём дальше
    candidate--;
  }
  return filled;
}

async function main() {
  const fs = await import('node:fs/promises');

  let offset = 0;
  try {
    offset = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')).offset || 0;
  } catch (e) { /* состояния ещё нет — начинаем с нуля */ }

  let ownerChatId = null;
  try {
    ownerChatId = JSON.parse(await fs.readFile(OWNER_FILE, 'utf8')).chatId || null;
  } catch (e) { /* ещё не запомнили — ок */ }

  let existing = [];
  try {
    existing = JSON.parse(await fs.readFile(NEWS_FILE, 'utf8'));
  } catch (e) { /* ленты ещё нет */ }

  const allowed = encodeURIComponent(JSON.stringify(['channel_post', 'edited_channel_post', 'message']));
  const url = `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${offset}&timeout=0&allowed_updates=${allowed}`;
  const res = await fetchWithRetry(url);
  const data = await res.json();
  if (!data.ok) throw new Error('getUpdates failed: ' + JSON.stringify(data));

  const updates = data.result;

  const newPosts = [];
  const edits = new Map();   // id -> { text, photoSize }

  for (const upd of updates) {
    if (upd.channel_post) {
      const post = upd.channel_post;
      const text = truncate(post.text || post.caption || '');
      if (!text) continue;

      const id = String(post.message_id);
      const channel = (post.chat && post.chat.username) || CHANNEL_FALLBACK;
      const entry = {
        id,
        url: `https://t.me/${channel}/${id}`,
        date: new Date(post.date * 1000).toISOString(),
        text,
        image: null
      };

      let photoSize = bestPhoto(post.photo);
      if (!photoSize && post.video) photoSize = post.video.thumbnail || post.video.thumb;
      if (photoSize) {
        try {
          await fs.mkdir(IMG_DIR, { recursive: true });
          const localPath = `${IMG_DIR}/${id}.jpg`;
          await downloadTelegramFile(photoSize.file_id, localPath, fs);
          entry.image = localPath;
        } catch (e) {
          console.warn(`Не удалось скачать картинку поста ${id}:`, e.message);
        }
      }

      newPosts.push(entry);
    } else if (upd.edited_channel_post) {
      const post = upd.edited_channel_post;
      const id = String(post.message_id);
      const text = truncate(post.text || post.caption || '');
      let photoSize = bestPhoto(post.photo);
      if (!photoSize && post.video) photoSize = post.video.thumbnail || post.video.thumb;
      edits.set(id, { text, photoSize });
    } else if (upd.message && upd.message.chat && upd.message.chat.type === 'private' && !ownerChatId) {
      // любое личное сообщение боту — запоминаем chat_id для проверки удалений и добора
      ownerChatId = upd.message.chat.id;
      await fs.mkdir('.github/state', { recursive: true });
      await fs.writeFile(OWNER_FILE, JSON.stringify({ chatId: ownerChatId }, null, 2) + '\n', 'utf8');
      console.log('Запомнил личный чат для проверки удалений:', ownerChatId);
    }
  }

  // апдейты приходят от старых к новым; в ленте нужен обратный порядок (новые сверху)
  let merged = [...newPosts.reverse(), ...existing];

  // применяем правки к уже показанным постам (не двигая их позицию в ленте)
  for (const post of merged) {
    if (!edits.has(post.id)) continue;
    const edit = edits.get(post.id);
    if (edit.text) post.text = edit.text;
    if (edit.photoSize) {
      try {
        await fs.mkdir(IMG_DIR, { recursive: true });
        const localPath = `${IMG_DIR}/${post.id}.jpg`;
        await downloadTelegramFile(edit.photoSize.file_id, localPath, fs);
        post.image = localPath;
      } catch (e) {
        console.warn(`Не удалось обновить картинку поста ${post.id}:`, e.message);
      }
    }
    console.log(`Пост ${post.id} отредактирован — обновил содержимое.`);
  }

  // проверяем, не удалили ли из канала уже показанные посты (не трогаем то,
  // что только что пришло этим же прогоном — оно точно ещё существует)
  let deletedCount = 0;
  if (ownerChatId) {
    const stillThere = [];
    for (const post of merged) {
      if (newPosts.some(p => p.id === post.id)) { stillThere.push(post); continue; }
      const exists = await checkStillExists(post.id, ownerChatId);
      if (exists) stillThere.push(post);
      else { deletedCount++; console.log(`Пост ${post.id} больше не существует в канале — убираю из ленты.`); }
    }
    merged = stillThere;
  } else {
    console.log('Проверка удалений пропущена: бот ещё не знает личный чат (напиши ему что-нибудь в Telegram).');
  }

  // если после удалений не хватает до KEEP — дотягиваемся за более старыми
  let backfilledCount = 0;
  if (ownerChatId && merged.length > 0 && merged.length < KEEP) {
    const oldestId = Math.min(...merged.map(p => parseInt(p.id, 10)));
    const filled = await backfillOlder(oldestId, KEEP - merged.length, ownerChatId, fs);
    backfilledCount = filled.length;
    merged = [...merged, ...filled];
  }

  merged = merged.slice(0, KEEP);

  // подчищаем картинки постов, которых больше нет в окне KEEP
  const keepFiles = new Set(merged.filter(p => p.image).map(p => `${p.id}.jpg`));
  try {
    const files = await fs.readdir(IMG_DIR);
    for (const file of files) {
      if (!keepFiles.has(file)) await fs.unlink(`${IMG_DIR}/${file}`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  await fs.writeFile(NEWS_FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8');

  if (updates.length) {
    const maxUpdateId = Math.max(...updates.map(u => u.update_id));
    await fs.mkdir('.github/state', { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify({ offset: maxUpdateId + 1 }, null, 2) + '\n', 'utf8');
  }

  console.log(`Новых постов: ${newPosts.length}. Правок: ${edits.size}. Удалено: ${deletedCount}. Добрано старых: ${backfilledCount}. Всего в ленте: ${merged.length}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
