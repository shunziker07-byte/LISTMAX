// Service worker LISTMAX — met en cache l'essentiel de l'app pour qu'elle
// fonctionne hors-ligne et s'installe comme une vraie application.
// Incrémente CACHE_NAME à chaque changement important pour forcer la mise à jour.
const CACHE_NAME = 'listmax-cache-v1';

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './assets/css/style.css',
  './assets/js/app.js',
  './assets/js/tailwind.config.js',
  './assets/icones/logo.svg',
  './assets/icones/nav-home.svg',
  './assets/icones/nav-todo.svg',
  './assets/icones/nav-calendar.svg',
  './assets/icones/nav-goals.svg',
  './assets/icones/nav-settings.svg',
  './assets/icones/icon-192.png',
  './assets/icones/icon-512.png',
  './assets/icones/apple-touch-icon.png'
];

// Ressources externes (police, Tailwind CDN) : mises en cache en best-effort,
// en mode no-cors pour ne pas dépendre des en-têtes CORS du serveur distant.
const EXTERNAL_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&display=swap',
  'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      const local = Promise.all(CORE_ASSETS.map((url) => cache.add(url).catch(() => {})));
      const external = Promise.all(EXTERNAL_ASSETS.map((url) =>
        fetch(url, { mode: 'no-cors' }).then((res) => cache.put(url, res)).catch(() => {})
      ));
      return Promise.all([local, external]);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// Stratégie : sert le cache immédiatement si disponible (rapide + fonctionne
// hors-ligne), tout en revalidant discrètement en arrière-plan depuis le réseau.
self.addEventListener('fetch', (event) => {
  if(event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request).then((response) => {
        if(response && (response.status === 200 || response.type === 'opaque')){
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
