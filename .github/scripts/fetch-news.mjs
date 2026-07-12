// Тянет последние посты из публичной страницы t.me/s/<канал> и сохраняет их
// в news.json. Без API-токенов и без бота — страница открыта всем, это
// обычный серверный HTTP-запрос (не браузерный iframe — блокировка встраивания
// тут вообще ни при чём, мы просто читаем страницу, а не показываем её).

const CHANNEL = 'macan777macan777macan777';
const KEEP = 6;

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
  const res = await fetch(`https://t.me/s/${CHANNEL}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MacanNewsBot/1.0)' }
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
      image: photo || null
    });
  }

  // на странице посты идут от старых к новым — берём последние KEEP и разворачиваем
  const latest = posts.slice(-KEEP).reverse();

  const fs = await import('node:fs/promises');
  await fs.writeFile('news.json', JSON.stringify(latest, null, 2) + '\n', 'utf8');
  console.log(`Сохранено постов: ${latest.length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
