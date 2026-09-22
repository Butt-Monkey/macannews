/* 87 · Macan News — Service Worker
   Стратегия:
   - HTML (навигация) — network-first: обновления сайта видны сразу,
     кэш используется только как офлайн-фолбэк;
   - ассеты (шрифты/картинки/аудио/видео) — cache-first: мгновенные
     повторные визиты, файлы контент-хэшированы именами и не меняются.
   При изменении списка ниже поднимай VERSION — старый кэш удалится сам. */
var VERSION = '87-v31';
var ASSET_RE = /\/assets\//;

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(VERSION).then(function (c) {
      /* прекэш только критического минимума; остальное доложится по мере запросов */
      return c.addAll([
        './',
        'index.html',
        'assets/fonts/schibsted-vf.woff2'
      ]).catch(function () {});
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== VERSION) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;   /* внешнее не трогаем */

  /* видео не трогаем: браузер тянет его кусками (Range → ответ 206), такие
     ответы нельзя положить в Cache API, а кэшировать целиком тяжело */
  if (/\.(mp4|webm|mov|m4v)$/i.test(url.pathname) || req.headers.has('range')) return;

  /* медиа постов из Telegram не кэшируем «навсегда»: бот может перезаписать файл
     под тем же именем (правка поста, перезагрузка альбома), и cache-first потом
     показывал бы старую картинку. Обычный HTTP-кэш браузера справится сам. */
  if (url.pathname.indexOf('/assets/news/') !== -1) return;

  /* навигация / HTML — сеть в приоритете, кэш как офлайн-фолбэк */
  if (req.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname === '/') {
    e.respondWith(
      fetch(req).then(function (res) {
        /* в офлайн-копию кладём только удачные ответы — страница 404/ошибка
           сервера не должна подменить сохранённую главную */
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) { return hit || caches.match('index.html'); });
      })
    );
    return;
  }

  /* ассеты — кэш в приоритете, доклад в кэш при первом запросе */
  if (ASSET_RE.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(VERSION).then(function (c) { c.put(req, copy); });
          }
          return res;
        });
      })
    );
  }
});
