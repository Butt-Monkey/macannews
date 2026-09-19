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
// - МЕДИА: у записи всегда есть поле image (первая картинка или постер видео) —
//   по нему рисуются карточки, как раньше. Если в посте видео или больше одного
//   файла (альбом), добавляется массив media: [{type:'photo', src} |
//   {type:'video', src, poster}] — по нему страница показывает плеер/галерею.
//   Альбом Telegram присылает россыпью отдельных сообщений с общим
//   media_group_id — бот склеивает их в одну запись (поле group нужно, чтобы
//   дописать «опоздавшие» части альбома в следующем прогоне).
//   Видео скачивается в assets/news/, если влезает в лимит Bot API (20 МБ);
//   если не влезает — остаётся только постер и кнопка «Смотреть в Telegram».
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
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;   // потолок Bot API на скачивание файлов (getFile)
const IMG_DIR = 'assets/news';
const NEWS_FILE = 'news.json';
const STATE_FILE = '.github/state/telegram-offset.json';
const OWNER_FILE = '.github/state/owner-chat.json';

// «Золотые окна»: посты обычно выходят в 8:07 и 20:07 МСК (05:07 и 17:07 UTC).
// GitHub запускает расписание с большими задержками (в среднем раз в ~2 часа),
// поэтому прогон, попавший в окно, не уходит сразу, а ждёт появления свежего
// поста — так даже запуск за 10 минут до публикации подхватит её.
const PEAK_WINDOWS_UTC = [[4 * 60 + 50, 5 * 60 + 40], [16 * 60 + 50, 17 * 60 + 40]];   // минуты суток UTC
const PEAK_POLL_MS = 30000;

function currentPeakWindow(now = new Date()) {
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const w = PEAK_WINDOWS_UTC.find(([from, to]) => minutes >= from && minutes < to);
  if (!w) return null;
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { start: dayStart + w[0] * 60000, end: dayStart + w[1] * 60000 };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
      if (i < attempts - 1) await sleep(delayMs);
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
      if (i < attempts - 1) await sleep(3000);
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

// что за медиа в сообщении: фото, видео или GIF-анимация (её Telegram тоже
// хранит как mp4). Прочее (документы, аудио, кружки) на сайте не показываем.
function mediaOf(msg) {
  const photo = bestPhoto(msg.photo);
  if (photo) return { kind: 'photo', file: photo, thumb: null };
  const video = msg.video || msg.animation;
  if (video) return { kind: 'video', file: video, thumb: video.thumbnail || video.thumb || null };
  return null;
}

// Скачивает медиа одного сообщения в assets/news/ и возвращает элемент для
// news.json. index — порядковый номер в посте: 0 → <id>.jpg (как всегда),
// дальше <id>_1.jpg, <id>_2.mp4 и т.д. Если скачать нечего — null.
async function buildMediaItem(msg, id, index, fs) {
  const m = mediaOf(msg);
  if (!m) return null;
  await fs.mkdir(IMG_DIR, { recursive: true });
  const base = index === 0 ? String(id) : `${id}_${index}`;
  const item = { mid: msg.message_id, uid: m.file.file_unique_id || null };

  if (m.kind === 'photo') {
    const src = `${IMG_DIR}/${base}.jpg`;
    try {
      await downloadTelegramFile(m.file.file_id, src, fs);
    } catch (e) {
      console.warn(`Не удалось скачать картинку ${base}:`, e.message);
      return null;
    }
    return { ...item, type: 'photo', src };
  }

  item.type = 'video';
  if (m.thumb) {
    const poster = `${IMG_DIR}/${base}.jpg`;
    try {
      await downloadTelegramFile(m.thumb.file_id, poster, fs);
      item.poster = poster;
    } catch (e) {
      console.warn(`Не удалось скачать постер видео ${base}:`, e.message);
    }
  }
  if (m.file.file_size && m.file.file_size > MAX_VIDEO_BYTES) {
    console.log(`Видео ${base} весит ${(m.file.file_size / 1048576).toFixed(1)} МБ — больше лимита Bot API, оставляю только постер.`);
  } else {
    const src = `${IMG_DIR}/${base}.mp4`;
    try {
      await downloadTelegramFile(m.file.file_id, src, fs);
      item.src = src;
    } catch (e) {
      console.warn(`Не удалось скачать видео ${base}:`, e.message);
    }
  }
  return item;
}

// список медиа записи в единообразном виде (у обычного поста с одним фото
// массива media нет — восстанавливаем его из image)
function mediaListOf(entry) {
  if (Array.isArray(entry.media)) return entry.media;
  return entry.image ? [{ mid: Number(entry.id), uid: null, type: 'photo', src: entry.image }] : [];
}

// приводит запись к каноническому виду: image = первая картинка/постер,
// media — только если в посте видео или больше одного файла
function finalizeEntry(entry, items) {
  items = items.filter(Boolean);
  const first = items[0];
  entry.image = first ? (first.type === 'photo' ? first.src : (first.poster || null)) : null;
  if (items.length > 1 || items.some(i => i.type === 'video')) entry.media = items;
  else delete entry.media;
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
        finalizeEntry(entry, [await buildMediaItem(msg, candidate, 0, fs)]);
        filled.push(entry);
        console.log(`Добрал более старый пост ${candidate}.`);
      }
    }
    // !ok — такого сообщения нет (удалено/никогда не было текстом/фото) — идём дальше
    candidate--;
  }
  return filled;
}

async function getUpdatesOnce(url) {
  const res = await fetchWithRetry(url);
  const data = await res.json();
  if (!data.ok) throw new Error('getUpdates failed: ' + JSON.stringify(data));
  return data.result;
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

  // getUpdates без подтверждения offset ничего не «съедает» — можно спокойно
  // переспрашивать, пока в золотом окне не появится свежий пост
  const peak = currentPeakWindow();
  let updates;
  for (;;) {
    updates = await getUpdatesOnce(url);
    const hasFresh = updates.some(u => u.channel_post && u.channel_post.date * 1000 >= peak?.start);
    if (!peak || hasFresh || Date.now() + PEAK_POLL_MS >= peak.end) break;
    console.log('Золотое окно: свежего поста ещё нет — жду ' + PEAK_POLL_MS / 1000 + ' с…');
    await sleep(PEAK_POLL_MS);
  }

  // альбом прилетает россыпью сообщений — даём остальным частям долететь
  if (updates.some(u => u.channel_post && u.channel_post.media_group_id)) {
    await sleep(5000);
    updates = await getUpdatesOnce(url);
  }

  // раскладываем апдейты: сообщения одного альбома собираем в одну группу
  const groups = [];                 // от старых к новым
  const groupByKey = new Map();
  const edits = new Map();           // id сообщения -> само отредактированное сообщение

  for (const upd of updates) {
    if (upd.channel_post) {
      const post = upd.channel_post;
      const key = post.media_group_id ? 'g' + post.media_group_id : 'm' + post.message_id;
      let g = groupByKey.get(key);
      if (!g) {
        g = { groupId: post.media_group_id ? String(post.media_group_id) : null, msgs: [] };
        groupByKey.set(key, g);
        groups.push(g);
      }
      g.msgs.push(post);
    } else if (upd.edited_channel_post) {
      edits.set(String(upd.edited_channel_post.message_id), upd.edited_channel_post);
    } else if (upd.message && upd.message.chat && upd.message.chat.type === 'private' && !ownerChatId) {
      // любое личное сообщение боту — запоминаем chat_id для проверки удалений и добора
      ownerChatId = upd.message.chat.id;
      await fs.mkdir('.github/state', { recursive: true });
      await fs.writeFile(OWNER_FILE, JSON.stringify({ chatId: ownerChatId }, null, 2) + '\n', 'utf8');
      console.log('Запомнил личный чат для проверки удалений:', ownerChatId);
    }
  }

  const newPosts = [];
  for (const g of groups) {
    g.msgs.sort((a, b) => a.message_id - b.message_id);
    const first = g.msgs[0];
    const text = truncate(g.msgs.map(m => m.text || m.caption || '').find(t => t.trim()) || '');

    // альбом мог начаться в предыдущий прогон — тогда дописываем в готовую запись
    const owner = g.groupId && existing.find(p => p.group === g.groupId);
    if (owner) {
      const items = mediaListOf(owner);
      for (const m of g.msgs) {
        if (items.some(i => i.mid === m.message_id)) continue;
        const item = await buildMediaItem(m, owner.id, items.length, fs);
        if (item) items.push(item);
      }
      finalizeEntry(owner, items);
      console.log(`Дописал части альбома в пост ${owner.id}.`);
      continue;
    }

    if (!text) continue;

    const id = String(first.message_id);
    const channel = (first.chat && first.chat.username) || CHANNEL_FALLBACK;
    const entry = {
      id,
      url: `https://t.me/${channel}/${id}`,
      date: new Date(first.date * 1000).toISOString(),
      text,
      image: null
    };
    if (g.groupId) entry.group = g.groupId;

    const items = [];
    for (const m of g.msgs) {
      const item = await buildMediaItem(m, id, items.length, fs);
      if (item) items.push(item);
    }
    finalizeEntry(entry, items);
    newPosts.push(entry);
  }

  // апдейты приходят от старых к новым; в ленте нужен обратный порядок (новые сверху)
  let merged = [...newPosts.reverse(), ...existing];

  // применяем правки к уже показанным постам (не двигая их позицию в ленте)
  for (const [id, msg] of edits) {
    const post = merged.find(p => p.id === id || (Array.isArray(p.media) && p.media.some(i => String(i.mid) === id)));
    if (!post) continue;

    const text = truncate(msg.text || msg.caption || '');
    if (text) post.text = text;

    const m = mediaOf(msg);
    if (m) {
      const items = mediaListOf(post);
      let idx = items.findIndex(i => String(i.mid) === id);
      if (idx < 0) idx = 0;
      // файл не менялся (правили только подпись) — не перекачиваем
      if (!items[idx] || !items[idx].uid || items[idx].uid !== m.file.file_unique_id) {
        const item = await buildMediaItem(msg, post.id, idx, fs);
        if (item) items[idx] = item;
      }
      finalizeEntry(post, items);
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

  // подчищаем файлы (картинки, постеры, видео) постов, которых больше нет в окне KEEP
  const keepFiles = new Set();
  const addKeep = p => { if (typeof p === 'string' && p.startsWith(IMG_DIR + '/')) keepFiles.add(p.slice(IMG_DIR.length + 1)); };
  for (const p of merged) {
    addKeep(p.image);
    for (const i of (p.media || [])) { addKeep(i.src); addKeep(i.poster); }
  }
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
