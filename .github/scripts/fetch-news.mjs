// Тянет последние посты из публичной страницы t.me/s/<канал> и сохраняет их
// в news.json. Без API-токенов и без бота — страница открыта всем, это
// обычный серверный HTTP-запрос (не браузерный iframe — блокировка встраивания
// тут вообще ни при чём, мы просто читаем страницу, а не показываем её).
//
// Картинки постов скачиваются сюда же, в assets/news/<id>.jpg, и в news.json
// попадает уже локальный путь, а не прямая ссылка на CDN Telegram — так
// картинки грузятся с самого macannews.ru и не зависят от того, доступен ли
// Telegram у посетителя напрямую (в РФ его CDN часто режут/блокируют).

const CHANNEL = 'macan777macan777macan777';
const KEEP = 6;
const IMG_DIR = 'assets/news';

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function htmlToText(html) {
  let s = html.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > 480) s = s.slice(0, 480).trim() + '…';
  return s;
}

function extract(re, html) {
  const m = html.match(re);
  return m ? m[1] : null;
}

async function main() {
  const fs = await import('node:fs/promises');

  // обычный браузерный User-Agent + метка времени в URL — иначе кэширующий слой
  // перед t.me иногда отдаёт бот-подобным запросам старый снимок страницы
  const res = await fetch(`https://t.me/s/${CHANNEL}?_=${Date.now()}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    }
  });
  if (!res.ok) throw new Error('Telegram HTTP ' + res.status);
  const html = await res.text();

  const marker = '<div class="tgme_widget_message ';
  const parts = html.split(marker).slice(1);

  const posts = [];
  for (const raw of parts) {
    const id = extract(new RegExp(`data-post="${CHANNEL}/(\\d+)"`), raw);
    if (!id) continue;
    const datetime = extract(/<time datetime="([^"]+)"/, raw);
    const textHtml = extract(/<div class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/, raw);
    const photo = extract(/tgme_widget_message_photo_wrap[^"]*"[^>]*style="[^"]*background-image:url\('([^']+)'\)/, raw)
               || extract(/tgme_widget_message_video_thumb"[^>]*style="[^"]*background-image:url\('([^']+)'\)/, raw);
    const text = textHtml ? htmlToText(textHtml) : '';
    if (!text) continue;
    posts.push({
      id,
      url: `https://t.me/${CHANNEL}/${id}`,
      date: datetime || null,
      text,
      imageSrc: photo || null   // временное поле, заменится ниже на локальный путь
    });
  }

  // на странице посты идут от старых к новым — берём последние KEEP и разворачиваем
  const latest = posts.slice(-KEEP).reverse();

  await fs.mkdir(IMG_DIR, { recursive: true });

  for (const post of latest) {
    if (!post.imageSrc) { post.image = null; continue; }
    try {
      const imgRes = await fetch(post.imageSrc);
      if (!imgRes.ok) throw new Error('HTTP ' + imgRes.status);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const localPath = `${IMG_DIR}/${post.id}.jpg`;
      await fs.writeFile(localPath, buf);
      post.image = localPath;
    } catch (e) {
      console.warn(`Не удалось скачать картинку поста ${post.id}:`, e.message);
      post.image = null;
    }
    delete post.imageSrc;
  }

  // подчищаем картинки постов, которых больше нет среди последних KEEP —
  // иначе assets/news будет бесконечно расти
  const keepFiles = new Set(latest.filter(p => p.image).map(p => `${p.id}.jpg`));
  try {
    const existing = await fs.readdir(IMG_DIR);
    for (const file of existing) {
      if (!keepFiles.has(file)) await fs.unlink(`${IMG_DIR}/${file}`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  await fs.writeFile('news.json', JSON.stringify(latest, null, 2) + '\n', 'utf8');
  console.log(`Сохранено постов: ${latest.length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
