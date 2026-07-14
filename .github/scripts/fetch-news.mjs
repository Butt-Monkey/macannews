// Тянет новые посты канала через официальный Bot API Telegram
// (api.telegram.org) и добавляет их в news.json.
//
// Раньше скрипт читал t.me/s/<канал> напрямую, но с сети GitHub Actions этот
// конкретный домен устойчиво не резолвится (DNS-сбой, не лечится ни сменой
// User-Agent, ни ручным DNS через публичные сервера) — похоже, именно t.me
// заблокирован на уровне сети GitHub Actions. api.telegram.org — другой
// домен, официальный API для ботов, должен резолвиться нормально.
//
// Как это устроено:
// - Бот должен быть администратором канала — иначе он вообще не получает посты.
// - getUpdates отдаёт только НОВЫЕ посты с момента последнего запроса, поэтому
//   мы храним offset (id последнего обработанного апдейта) в
//   .github/state/telegram-offset.json и с каждым запуском продолжаем оттуда.
// - Новые посты добавляются в начало news.json, старые вытесняются за пределы
//   KEEP. Если пост удалили из канала — Bot API об этом не сообщает, так что
//   удалённый пост останется в ленте, пока сам не вытеснится новыми (не дольше,
//   чем на KEEP публикаций вперёд).

const TOKEN = process.env.TG_BOT_TOKEN;
if (!TOKEN) throw new Error('Нет TG_BOT_TOKEN — секрет репозитория не задан или не передан в workflow');

const CHANNEL_FALLBACK = 'macan777macan777macan777';
const KEEP = 6;
const IMG_DIR = 'assets/news';
const NEWS_FILE = 'news.json';
const STATE_FILE = '.github/state/telegram-offset.json';

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

async function main() {
  const fs = await import('node:fs/promises');

  let offset = 0;
  try {
    offset = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')).offset || 0;
  } catch (e) { /* состояния ещё нет — начинаем с нуля */ }

  let existing = [];
  try {
    existing = JSON.parse(await fs.readFile(NEWS_FILE, 'utf8'));
  } catch (e) { /* ленты ещё нет */ }

  const allowed = encodeURIComponent(JSON.stringify(['channel_post']));
  const url = `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${offset}&timeout=0&allowed_updates=${allowed}`;
  const res = await fetchWithRetry(url);
  const data = await res.json();
  if (!data.ok) throw new Error('getUpdates failed: ' + JSON.stringify(data));

  const updates = data.result;
  if (!updates.length) {
    console.log('Новых постов нет.');
    return;
  }

  await fs.mkdir(IMG_DIR, { recursive: true });

  const newPosts = [];
  for (const upd of updates) {
    const post = upd.channel_post;
    if (!post) continue;
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
        const localPath = `${IMG_DIR}/${id}.jpg`;
        await downloadTelegramFile(photoSize.file_id, localPath, fs);
        entry.image = localPath;
      } catch (e) {
        console.warn(`Не удалось скачать картинку поста ${id}:`, e.message);
      }
    }

    newPosts.push(entry);
  }

  // апдейты приходят от старых к новым; в ленте нужен обратный порядок (новые сверху)
  const merged = [...newPosts.reverse(), ...existing].slice(0, KEEP);

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

  const maxUpdateId = Math.max(...updates.map(u => u.update_id));
  await fs.mkdir('.github/state', { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify({ offset: maxUpdateId + 1 }, null, 2) + '\n', 'utf8');

  console.log(`Добавлено новых постов: ${newPosts.length}. Всего в ленте: ${merged.length}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
