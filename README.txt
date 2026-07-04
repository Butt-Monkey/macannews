87 · Macan News — файлы для хостинга
====================================

Содержимое:
  index.html        — сам сайт (открывается локально и на хостинге)
  404.html          — фирменная страница «не найдено»
  sw.js             — Service Worker: офлайн + мгновенные повторные визиты
  assets/           — всё медиа (картинки, аудио, видео, иконки)
  assets/fonts/     — шрифты самохостом (woff2): Bodoni/Schibsted (латиница)
                      + Playfair/Manrope (кириллица) — Google Fonts не нужен
  assets/og-cover.jpg — баннер для шаринга в TG/соцсетях (1200×630)
  site.webmanifest  — манифест PWA (иконка на телефоне)
  robots.txt        — для поисковиков
  sitemap.xml       — карта сайта

Домен уже прописан: macan-news.pages.dev
Если будешь хостить на другом адресе (свой домен или другое имя проекта),
сделай поиск-замену 'macan-news.pages.dev' на свой домен в:
index.html, robots.txt, sitemap.xml.

GOOGLE SEARCH CONSOLE:
В index.html в <head> есть meta google-site-verification —
замени content на код из Search Console (метод «HTML-тег») и перезалей.

ДЕПЛОЙ: загрузите ВСЮ папку целиком (вместе с assets/) в Cloudflare Pages,
Netlify Drop или GitHub Pages. index.html должен лежать в корне.

ОБНОВЛЕНИЕ САЙТА: index.html обновляется у посетителей сразу (network-first).
Если поменяешь файлы в assets/ НЕ меняя их имена — подними VERSION в sw.js
('87-v1' → '87-v2'), иначе у старых посетителей останется кэш.
