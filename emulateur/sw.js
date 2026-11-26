// Garde l'émulateur sur le téléphone : après la première visite, il marche hors ligne.
// Changer VERSION à chaque mise à jour des fichiers pour que les téléphones la récupèrent.
const VERSION = 'pt-emu-2';
const FICHIERS = [
  './', 'index.html', 'emu.css', 'emu.js', 'manifest.webmanifest', 'licences.html',
  'icone-192.png', 'icone-512.png', 'icone-maskable.png', 'icone-apple.png',
  'blastem/blastem.sdk.js', 'blastem/blastem.controls.js', 'blastem/blastem.options.js',
  'blastem/blastem.video.js', 'blastem/engine-specs.js', 'blastem/blastem.js',
  'blastem/blastem.wasm.gz',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((cles) => Promise.all(cles.filter((k) => k.startsWith('pt-emu-') && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (!url.pathname.startsWith(new URL('./', self.registration.scope).pathname)) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request))
  );
});
