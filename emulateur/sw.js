// Garde l'émulateur sur le téléphone : après la première visite, il marche hors ligne.
// Changer VERSION à chaque mise à jour (et VERSION_APPLI dans emu.js) des fichiers pour que les téléphones la récupèrent.
const VERSION = 'pt-emu-10';
const FICHIERS = [
  './', 'index.html', 'emu.css', 'emu.js', 'manifest.webmanifest', 'licences.html',
  'icone-192.png', 'icone-512.png', 'icone-maskable.png', 'icone-apple.png',
  'blastem/blastem.sdk.js', 'blastem/blastem.controls.js', 'blastem/blastem.options.js',
  'blastem/blastem.video.js', 'blastem/engine-specs.js', 'blastem/blastem.js', 'blastem/blastem-pt.js',
  'blastem/blastem.wasm.gz',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((cles) => Promise.all(cles.filter((k) => k.startsWith('pt-emu-') && k !== VERSION && k !== 'pt-emu-donnees').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const racineSite = new URL('../', self.registration.scope).pathname;
  // Liste des traductions et patchs du site : on prend la version en ligne, et on garde une copie
  // pour pouvoir encore patcher et reconnaître les jeux sans connexion.
  if (url.pathname === racineSite + 'data/projets.json' || url.pathname.startsWith(racineSite + 'patchs/')) {
    e.respondWith(
      fetch(e.request).then((r) => {
        if (r.ok) { const copie = r.clone(); caches.open('pt-emu-donnees').then((c) => c.put(url.pathname, copie)); }
        return r;
      }).catch(() => caches.open('pt-emu-donnees').then((c) => c.match(url.pathname)).then((r) => r || Response.error()))
    );
    return;
  }
  if (!url.pathname.startsWith(new URL('./', self.registration.scope).pathname)) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request))
  );
});
