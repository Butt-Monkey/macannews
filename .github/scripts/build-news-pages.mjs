// ═══════════════════════════════════════════════════════════════════════════
// Статические страницы постов: macannews.ru/n/<номер>/  (стенд 2026-09-30)
//
// Зачем. На сайте каждый пост и так открывается по адресу /#news/<номер>, но у
// таких адресов нет своего превью: ВКонтакте, WhatsApp, Telegram и поисковики
// видят только главную. Этот скрипт после каждого обновления ленты делает для
// каждого поста лёгкую отдельную страницу (~6 КБ + картинка): свой заголовок,
// текст, фото, превью для соцсетей (Open Graph) и разметку новости для Яндекса
// и Google. Страница сама по себе — полноценная статья (быстро открывается даже
// на слабом телефоне), кнопка «Открыть на сайте» ведёт в обычный сайт.
//
// Что делает:
//   1. читает news.json;
//   2. пишет n/<id>/index.html для каждого поста в ленте;
//   3. удаляет n/<id>/ постов, которых в ленте больше нет (их картинки
//      fetch-news.mjs тоже удаляет) — старые ссылки подхватит 404.html и
//      отправит на /#news/<id>, где сайт честно скажет «пост ушёл из ленты»;
//   4. пишет sitemap-news.xml (robots.txt на него ссылается);
//   5. дописывает каждой записи news.json поле page: "n/<id>/" — по нему
//      сайт понимает, что делиться можно этой страницей.
//
// Запуск — отдельным шагом в telegram-news.yml ПОСЛЕ fetch-news.mjs, с
// continue-on-error: если что-то пойдёт не так, лента всё равно обновится.
// Чистые функции (splitPost, renderPage, renderSitemap) не трогают диск —
// их можно проверить в браузере.
// ═══════════════════════════════════════════════════════════════════════════

export const SITE = 'https://macannews.ru';
const TG_CHANNEL = 'https://t.me/macan777macan777macan777';
const YM_ID = 112939024;
const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

// ── текст поста → заголовок + тело (тот же разбор, что на сайте) ──────────────
const EMO = '(?:[\\u2190-\\u21FF\\u2300-\\u23FF\\u2460-\\u27BF\\u2900-\\u297F\\u2B00-\\u2BFF\\u3030\\u303D\\uFE0F\\u200D\\u20E3]|\\uD83C[\\uDC00-\\uDFFF]|\\uD83D[\\uDC00-\\uDFFF]|\\uD83E[\\uDC00-\\uDFFF])';
const RE_LEAD = new RegExp('^(?:' + EMO + '|[\\s•·*_~|])+');
const RE_TAIL = new RegExp('(?:' + EMO + '|\\s)+$');
export function splitPost(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let i = 0, title = '';
  while (i < lines.length && !title) { title = lines[i].replace(RE_LEAD, '').replace(RE_TAIL, '').trim(); i++; }
  let body = lines.slice(i).join('\n').trim();
  if (title.length > 140) {
    const m = /^(.{20,130}?[.!?…])\s+(.+)$/.exec(title);
    if (m) { body = m[2] + (body ? '\n\n' + body : ''); title = m[1]; }
    else { const cut = title.lastIndexOf(' ', 120); body = title + (body ? '\n\n' + body : ''); title = title.slice(0, cut > 40 ? cut : 120).replace(/[,:;\s]+$/, '') + '…'; }
  }
  return { title, body };
}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pad2 = n => (n < 10 ? '0' : '') + n;
function cut(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); if (s.length <= n) return s; const c = s.lastIndexOf(' ', n); return s.slice(0, c > n * 0.6 ? c : n).replace(/[,:;\s]+$/, '') + '…'; }
// время поста — по Москве (UTC+3 круглый год): страница собирается на сервере GitHub, где UTC
function mskDate(iso) {
  const d = new Date(iso); if (isNaN(d)) return '';
  const m = new Date(d.getTime() + 3 * 3600e3);
  return m.getUTCDate() + ' ' + MONTHS[m.getUTCMonth()] + ' ' + m.getUTCFullYear() + ', ' + pad2(m.getUTCHours()) + ':' + pad2(m.getUTCMinutes());
}
const abs = p => /^https?:/.test(p || '') ? p : SITE + '/' + String(p || '').replace(/^\/+/, '');
function mediaOf(p) {
  const list = Array.isArray(p.media) && p.media.length ? p.media : (p.image ? [{ type: 'photo', src: p.image }] : []);
  return list.filter(i => i && (i.src || i.poster));
}

// ── страница поста ────────────────────────────────────────────────────────────
export function renderPage(post, posts) {
  const { title, body } = splitPost(post.text);
  const id = String(post.id);
  const url = SITE + '/n/' + encodeURIComponent(id) + '/';
  const desc = cut(body || title, 190);
  const image = post.image ? abs(post.image) : SITE + '/assets/og-87.png';
  const media = mediaOf(post).map(it => {
    const wh = it.w && it.h ? ` width="${it.w}" height="${it.h}"` : '';
    if (it.type === 'video' && it.src) {
      return `<video controls playsinline preload="none"${it.poster ? ` poster="/${esc(it.poster)}"` : ''}${wh}><source src="/${esc(it.src)}" type="video/mp4"></video>`;
    }
    if (it.type === 'video') {
      return `<a class="vid" href="${esc(post.url)}" target="_blank" rel="noopener">${it.poster ? `<img src="/${esc(it.poster)}" alt=""${wh} loading="lazy" decoding="async">` : ''}<span>▶ Видео — в Telegram</span></a>`;
    }
    return `<img src="/${esc(it.src || it.poster)}" alt="${esc(title)}"${wh} loading="lazy" decoding="async">`;
  }).join('\n');
  const paras = body ? body.split(/\n{2,}/).map(pp => `<p>${esc(pp).replace(/\n/g, '<br>')}</p>`).join('\n') : '';
  const others = posts.filter(p => String(p.id) !== id).slice(0, 5).map(p => {
    const t = splitPost(p.text).title;
    return `<li><a href="/n/${encodeURIComponent(String(p.id))}/"><span>${esc(mskDate(p.date).replace(/, \d\d:\d\d$/, ''))}</span>${esc(t)}</a></li>`;
  }).join('\n');
  const ld = {
    '@context': 'https://schema.org', '@type': 'NewsArticle',
    headline: cut(title, 110), datePublished: post.date, dateModified: post.date,
    image: [image], mainEntityOfPage: url,
    author: { '@type': 'Organization', name: '87 · Macan News', url: SITE + '/' },
    publisher: { '@type': 'NewsMediaOrganization', name: '87 · Macan News', logo: { '@type': 'ImageObject', url: SITE + '/assets/fav87-512.png' } }
  };
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"/>
<!-- собрано автоматически (.github/scripts/build-news-pages.mjs) — руками не править -->
<title>${esc(cut(title, 90))} — 87 · Macan News</title>
<meta name="description" content="${esc(desc)}"/>
<link rel="canonical" href="${url}"/>
<meta property="og:type" content="article"/>
<meta property="og:site_name" content="87 · Macan News"/>
<meta property="og:locale" content="ru_RU"/>
<meta property="og:title" content="${esc(cut(title, 100))}"/>
<meta property="og:description" content="${esc(desc)}"/>
<meta property="og:url" content="${url}"/>
<meta property="og:image" content="${esc(image)}"/>
<meta property="og:image:alt" content="${esc(cut(title, 100))}"/>
<meta property="article:published_time" content="${esc(post.date)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:image" content="${esc(image)}"/>
<meta name="theme-color" content="#050505"/>
<meta name="color-scheme" content="only light"/>
<link rel="icon" type="image/x-icon" href="/assets/fav87.ico"/>
<link rel="apple-touch-icon" sizes="180x180" href="/assets/fav87-apple.png"/>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
<style>
@font-face{font-family:'Schibsted Grotesk';font-style:normal;font-weight:400 800;font-display:swap;src:url(/assets/fonts/schibsted-vf.woff2) format('woff2');unicode-range:U+0000-00FF,U+2000-206F}
:root{color-scheme:only light;--bg:#F7F4EE;--card:#fff;--ink:#050505;--soft:rgba(5,5,5,.64);--line:rgba(5,5,5,.14);--pink:#FDA4C2;--pink-deep:#B8466F;--pad:clamp(16px,5vw,72px)}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--ink);font-family:'Schibsted Grotesk',sans-serif;font-size:17px;line-height:1.65;-webkit-font-smoothing:antialiased}
a{color:inherit}
img,video{display:block;max-width:100%;height:auto}
.wrap{max-width:820px;margin:0 auto;padding:0 var(--pad)}
.top{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1.5px solid var(--ink);padding-top:env(safe-area-inset-top,0px)}
.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-block:12px}
.mark{font-weight:800;font-size:24px;letter-spacing:-.04em;text-decoration:none}
.all{font-size:12px;letter-spacing:.16em;text-transform:uppercase;font-weight:700;text-decoration:none;border:1.5px solid var(--ink);padding:9px 14px}
.all:hover{background:var(--ink);color:var(--bg)}
main{padding-block:clamp(32px,6vw,72px) clamp(48px,8vw,96px)}
.date{font-size:12px;letter-spacing:.28em;text-transform:uppercase;font-weight:700;color:var(--pink-deep)}
h1{margin-top:12px;font-weight:800;font-size:clamp(30px,5vw,54px);line-height:1.04;letter-spacing:-.025em;text-wrap:balance}
.media{margin-top:clamp(20px,3vw,32px);display:grid;gap:14px}
.media img,.media video{width:100%;border:1.5px solid var(--ink);background:#e9e7e1}
.vid{position:relative;display:block;text-decoration:none}
.vid span{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);background:var(--bg);border:1.5px solid var(--ink);padding:10px 16px;font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;white-space:nowrap}
.text{margin-top:clamp(20px,3vw,32px);font-size:clamp(17px,2vw,20px);overflow-wrap:anywhere}
.text p+p{margin-top:1em}
.btns{display:flex;flex-wrap:wrap;gap:12px;margin-top:clamp(28px,4vw,44px);padding-top:clamp(20px,3vw,32px);border-top:1px solid var(--line)}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:50px;padding:12px 22px;border:1.5px solid var(--ink);background:none;font:700 13px/1 'Schibsted Grotesk',sans-serif;letter-spacing:.16em;text-transform:uppercase;text-decoration:none;cursor:pointer;color:var(--ink);transition:background .2s,color .2s}
.btn:hover{background:var(--ink);color:var(--bg)}
.btn-pink{background:var(--pink);border-color:var(--pink)}
@media (max-width:520px){.btn{flex:1 1 100%}}
.more{margin-top:clamp(40px,6vw,72px)}
.more h2{font-weight:800;font-size:clamp(22px,3vw,30px);text-transform:uppercase;letter-spacing:-.01em;padding-bottom:10px;border-bottom:1.5px solid var(--ink)}
.more ul{list-style:none}
.more li a{display:block;padding:14px 0;border-bottom:1px solid var(--line);text-decoration:none;font-weight:700;font-size:18px;line-height:1.3}
.more li a:hover{color:var(--pink-deep)}
.more li span{display:block;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--pink-deep);margin-bottom:4px}
.foot{border-top:1.5px solid var(--ink);padding-block:26px;font-size:14px;color:var(--soft)}
.foot a{font-weight:700;color:var(--ink)}
.toast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:12px 18px;font-size:14px;font-weight:700;opacity:0;pointer-events:none;transition:opacity .2s}
.toast.on{opacity:1}
</style>
<script>(function(){var Y=${YM_ID};if(/^(localhost|127\.0\.0\.1)$/.test(location.hostname))return;window.ym=window.ym||function(){(window.ym.a=window.ym.a||[]).push(arguments)};window.ym.l=1*new Date();window.ym(Y,'init',{ssr:true,clickmap:true,accurateTrackBounce:true,trackLinks:true});function go(){setTimeout(function(){var k=document.createElement('script');k.async=true;k.src='https://mc.yandex.ru/metrika/tag.js?id='+Y;document.head.appendChild(k);},600);}if(document.readyState==='complete')go();else window.addEventListener('load',go);})();</script>
</head>
<body>
<header class="top"><div class="wrap"><a class="mark" href="/" aria-label="87 · Macan News — главная">87</a><a class="all" href="/#news">Все новости</a></div></header>
<main class="wrap">
<article>
<div class="date">${esc(mskDate(post.date))}</div>
<h1>${esc(title)}</h1>
${media ? `<div class="media">\n${media}\n</div>` : ''}
${paras ? `<div class="text">\n${paras}\n</div>` : ''}
<div class="btns">
<a class="btn btn-pink" href="/#news/${encodeURIComponent(id)}">Открыть на сайте</a>
<button class="btn" type="button" id="share">Поделиться</button>
<a class="btn" href="${esc(post.url)}" target="_blank" rel="noopener">Пост в Telegram</a>
</div>
</article>
${others ? `<section class="more"><h2>Ещё новости</h2><ul>\n${others}\n</ul></section>` : ''}
</main>
<footer class="foot"><div class="wrap">87 · Macan News — мы определяем реальность · <a href="/">macannews.ru</a> · <a href="/87craft/">87CRAFT</a></div></footer>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>(function(){var b=document.getElementById('share'),t=document.getElementById('toast');if(!b)return;b.addEventListener('click',function(){var u=location.href.split('#')[0];if(navigator.share){navigator.share({title:document.title,url:u}).catch(function(){});return;}function done(ok){t.textContent=ok?'Ссылка скопирована':'Скопируй адрес из строки браузера';t.classList.add('on');setTimeout(function(){t.classList.remove('on');},2200);}if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(u).then(function(){done(true);},function(){done(false);});}else done(false);});})();</script>
</body>
</html>
`;
}

export function renderSitemap(posts) {
  const urls = posts.map(p => `  <url>\n    <loc>${SITE}/n/${encodeURIComponent(String(p.id))}/</loc>\n    <lastmod>${esc(String(p.date || '').slice(0, 10))}</lastmod>\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

// ── запись на диск (только в GitHub Actions / Node) ───────────────────────────
async function main() {
  const fs = await import('node:fs/promises');
  const posts = JSON.parse(await fs.readFile('news.json', 'utf8'));
  if (!Array.isArray(posts)) throw new Error('news.json — не массив');
  const keep = new Set();
  let changed = false;
  for (const p of posts) {
    if (!p || !p.id || !/^[0-9A-Za-z_-]+$/.test(String(p.id))) continue;
    const id = String(p.id);
    keep.add(id);
    await fs.mkdir(`n/${id}`, { recursive: true });
    await fs.writeFile(`n/${id}/index.html`, renderPage(p, posts), 'utf8');
    const page = `n/${id}/`;
    if (p.page !== page) { p.page = page; changed = true; }
  }
  let removed = 0;
  try {
    for (const d of await fs.readdir('n')) {
      if (!keep.has(d)) { await fs.rm(`n/${d}`, { recursive: true, force: true }); removed++; }
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await fs.writeFile('sitemap-news.xml', renderSitemap(posts.filter(p => p && keep.has(String(p.id)))), 'utf8');
  if (changed) await fs.writeFile('news.json', JSON.stringify(posts, null, 2) + '\n', 'utf8');
  console.log(`Страниц постов: ${keep.size}. Удалено старых: ${removed}. news.json ${changed ? 'дополнен полем page' : 'без изменений'}.`);
}

if (typeof process !== 'undefined' && process.versions && process.versions.node) {
  main().catch(err => { console.error('Страницы постов не собрались (лента при этом обновлена):', err); process.exit(1); });
}
