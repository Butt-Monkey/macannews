// ОДНОРАЗОВЫЙ скрипт: собирает посты, которые ты вручную переслал (Forward)
// из канала в личку своему боту, и добавляет их в news.json — так лента сразу
// заполняется реальными постами, не дожидаясь новых публикаций.
//
// Важно: перед запуском —
//  1) напиши боту в личку любое сообщение (даже "привет"),
//  2) перешли (Forward) туда нужные посты из канала,
//  3) и только потом запускай этот workflow вручную.
//
// Скрипт НЕ трогает .github/state/telegram-offset.json — офсет обычного
// fetch-news.mjs остаётся как есть, регулярная лента не ломается.

const TOKEN = process.env.TG_BOT_TOKEN;
if (!TOKEN) throw new Error('Нет TG_BOT_TOKEN');

const CHANNEL_FALLBACK = 'macan777macan777macan777';
const KEEP = 6;
const IMG_DIR = 'assets/news';
const NEWS_FILE = 'news.json';
const STATE_FILE = '.github/state/telegram-offset.json';   // только читаем!

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
  return sizes[sizes.length - 1];
}

async function downloadTelegramFile(fileId, destPath, fs) {
  const infoRes = await fetchWithRetry(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`);
  const info = await infoRes.json();
  if (!info.ok) throw new Error('getFile failed: ' + JSON.stringify(info));
  const fileRes = await fetchWithRetry(`https://api.telegram.org/file/bot${TOKEN}/${info.result.file_path}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());
  await fs.writeFile(destPath, buf);
}

function extractForwardOrigin(msg) {
  // новый формат Bot API (7.0+)
  if (msg.forward_origin && msg.forward_origin.type === 'channel') {
    return {
      channel: msg.forward_origin.chat.username || null,
      messageId: msg.forward_origin.message_id,
      date: msg.forward_origin.date
    };
  }
  // старый формат (на случай другой версии API)
  if (msg.forward_from_chat) {
    return {
      channel: msg.forward_from_chat.username || null,
      messageId: msg.forward_from_message_id,
      date: msg.forward_date || msg.date
    };
  }
  return null;
}

async function main() {
  const fs = await import('node:fs/promises');

  let offset = 0;
  try {
    offset = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')).offset || 0;
  } catch (e) { /* нет состояния — ок, начнём с нуля */ }

  let existing = [];
  try {
    existing = JSON.parse(await fs.readFile(NEWS_FILE, 'utf8'));
  } catch (e) { /* ленты ещё нет */ }

  console.log(`Используемый offset: ${offset}`);

  // без фильтра allowed_updates — берём вообще всё, что есть в очереди,
  // чтобы точно увидеть, что реально прислал Telegram (для диагностики)
  const url = `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${offset}&timeout=0`;
  const res = await fetchWithRetry(url);
  const data = await res.json();
  if (!data.ok) throw new Error('getUpdates failed: ' + JSON.stringify(data));

  const updates = data.result;
  console.log(`Всего апдейтов в очереди: ${updates.length}`);
  console.log('Типы апдейтов:', updates.map(u => Object.keys(u).filter(k => k !== 'update_id')).flat());
  if (updates.length) console.log('Сырой пример первого апдейта:', JSON.stringify(updates[0]).slice(0, 800));

  const found = [];
  for (const upd of updates) {
    const msg = upd.message;
    if (!msg) continue;
    const origin = extractForwardOrigin(msg);
    if (!origin) { console.log('Пропущено (не пересланное сообщение из канала)'); continue; }

    const text = truncate(msg.text || msg.caption || '');
    if (!text) continue;

    const id = String(origin.messageId);
    const channel = origin.channel || CHANNEL_FALLBACK;
    found.push({
      id,
      url: `https://t.me/${channel}/${id}`,
      date: new Date(origin.date * 1000).toISOString(),
      text,
      _photo: bestPhoto(msg.photo) || (msg.video && (msg.video.thumbnail || msg.video.thumb)) || null
    });
  }

  if (!found.length) {
    console.log('Пересланных постов не найдено. Проверь: писал ли ты боту в личку, переслал ли посты именно туда, прошло ли хоть немного времени после пересылки.');
    return;
  }

  await fs.mkdir(IMG_DIR, { recursive: true });
  for (const post of found) {
    if (post._photo) {
      try {
        const localPath = `${IMG_DIR}/${post.id}.jpg`;
        await downloadTelegramFile(post._photo.file_id, localPath, fs);
        post.image = localPath;
      } catch (e) {
        console.warn(`Не удалось скачать картинку поста ${post.id}:`, e.message);
        post.image = null;
      }
    } else {
      post.image = null;
    }
    delete post._photo;
  }

  // объединяем с уже существующими, убираем дубликаты по id, сортируем по дате
  const byId = new Map();
  for (const p of [...found, ...existing]) {
    if (!byId.has(p.id)) byId.set(p.id, p);
  }
  const merged = [...byId.values()]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, KEEP);

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
  console.log(`Готово. В ленте теперь: ${merged.length} постов.`);
}

main().catch(err => { console.error(err); process.exit(1); });
