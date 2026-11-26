// Émulateur Mega Drive Player Time — page autour du cœur BlastEm (WebAssembly).
// Le cœur : BlastEm 1.0 de Michael Pavone (GPL v3), compilé par wasm-gaming/blastem-wasm.
// Ici : chargement léger du cœur (.wasm.gz décompressé dans le navigateur), manette tactile,
// dernière ROM gardée sur l'appareil, sauvegardes d'état, mode appli (PWA, hors ligne).

import BlastemSDK, { BLASTEM_CONTROLS } from './blastem/blastem.sdk.js';

const $ = (s) => document.querySelector(s);
const VERSION_COEUR = 'blastem-1.0.0+22';
// Version de l'appli : à changer à chaque mise à jour, en même temps que VERSION dans sw.js
export const VERSION_APPLI = '0.6';
const DATE_APPLI = '26/11/2026';
const OWNER = 'menu';

// ------------------------------------------------------------------ réglages
const DEFAUTS = { v: 2, region: 'auto', shader: 'standard', lisse: false, scan: false, six: false, vibre: false, diag: false, taille: 100, opacite: 75, disp: {} };
function lireReglages() {
  try {
    const lu = JSON.parse(localStorage.getItem('pt-emu-reglages') || '{}');
    // v2 : la vibration coupait le son sur Android, elle est désormais coupée par défaut
    if ((lu.v || 1) < 2) { delete lu.vibre; lu.v = 2; }
    return { ...DEFAUTS, ...lu };
  }
  catch { return { ...DEFAUTS }; }
}
function ecrireReglages() {
  try { localStorage.setItem('pt-emu-reglages', JSON.stringify(R)); } catch { /* navigation privée */ }
}
const R = lireReglages();

function appliquerReglagesVisuels() {
  document.documentElement.style.setProperty('--tr', R.taille / 100);
  document.documentElement.style.setProperty('--o', R.opacite / 100);
  document.body.classList.toggle('six', R.six);
  document.body.classList.toggle('diag', R.diag);
}
function brancherReglages() {
  const lien = [
    ['#r-region', 'region', 'value'], ['#r-shader', 'shader', 'value'],
    ['#r-lisse', 'lisse', 'checked'], ['#r-scan', 'scan', 'checked'],
    ['#r-six', 'six', 'checked'], ['#r-vibre', 'vibre', 'checked'], ['#r-diag', 'diag', 'checked'],
    ['#r-taille', 'taille', 'value'], ['#r-opacite', 'opacite', 'value'],
  ];
  for (const [sel, cle, prop] of lien) {
    const el = $(sel);
    el[prop] = R[cle];
    el.addEventListener('input', () => {
      R[cle] = prop === 'checked' ? el.checked : (typeof DEFAUTS[cle] === 'number' ? Number(el.value) : el.value);
      ecrireReglages();
      appliquerReglagesVisuels();
    });
  }
  appliquerReglagesVisuels();
}

// ------------------------------------------------------------------ messages
function message(texte, type = '') {
  const m = $('#message');
  m.textContent = texte;
  m.className = 'message ' + type;
}
let minuteurBulle = 0;
function bulle(texte) {
  const b = $('#bulle');
  b.textContent = texte;
  b.hidden = false;
  clearTimeout(minuteurBulle);
  minuteurBulle = setTimeout(() => (b.hidden = true), 1800);
}

// ------------------------------------------------------------------ le cœur (léger : 2,4 Mo)
// Le .wasm fait 31 Mo brut mais 2,4 Mo compressé : on télécharge la version .gz et on la
// décompresse dans le navigateur. Ça marche sur n'importe quel hébergeur (GitHub Pages compris).
let coeurPromesse = null;
function chargerCoeur() {
  if (coeurPromesse) return coeurPromesse;
  coeurPromesse = (async () => {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Navigateur trop ancien (il faut Chrome 80+, Safari 16.4+ ou Firefox 113+).');
    }
    const rep = await fetch('blastem/blastem.wasm.gz');
    if (!rep.ok) throw new Error('Cœur introuvable (' + rep.status + ').');
    const total = Number(rep.headers.get('content-length')) || 2368234;
    const lecteur = rep.body.getReader();
    const morceaux = [];
    let recu = 0;
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      morceaux.push(value);
      recu += value.length;
      $('#coeur-barre').style.width = Math.min(100, (recu / total) * 100) + '%';
      $('#coeur-texte').textContent = `Téléchargement du cœur BlastEm… ${(recu / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} Mo`;
    }
    $('#coeur-texte').textContent = 'Décompression du cœur…';
    const flux = new Blob(morceaux).stream().pipeThrough(new DecompressionStream('gzip'));
    const wasm = await new Response(flux).arrayBuffer();
    const url = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
    $('#coeur').classList.add('pret');
    $('#coeur-texte').textContent = 'Cœur BlastEm prêt ✔ (fonctionne aussi hors ligne)';
    return url;
  })();
  coeurPromesse.catch((e) => {
    $('#coeur-texte').textContent = e.message;
    message(e.message, 'erreur');
  });
  return coeurPromesse;
}

// ------------------------------------------------------------------ ROM : lecture, zip, mémoire
function nomPropre(nom) {
  return nom.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N} _\-().[\]!]/gu, '').trim().slice(0, 80) || 'jeu';
}
function espace(nom) { // dossier des sauvegardes de ce jeu
  return nomPropre(nom).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'jeu';
}

// .zip : on prend la première ROM du fichier (stockée ou « deflate »)
async function dezipper(octets) {
  const v = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  let fin = -1;
  for (let i = octets.length - 22; i >= Math.max(0, octets.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { fin = i; break; }
  }
  if (fin < 0) throw new Error('Fichier .zip illisible.');
  const nb = v.getUint16(fin + 10, true);
  let p = v.getUint32(fin + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < nb; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const methode = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const taille = v.getUint32(p + 24, true);
    const lnom = v.getUint16(p + 28, true), lext = v.getUint16(p + 30, true), lcom = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const nom = dec.decode(octets.subarray(p + 46, p + 46 + lnom));
    p += 46 + lnom + lext + lcom;
    if (!/\.(bin|gen|md|smd)$/i.test(nom)) continue;
    const debut = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const brut = octets.subarray(debut, debut + csize);
    if (methode === 0) return { octets: brut.slice(), nom: nom.split('/').pop() };
    if (methode === 8) {
      const flux = new Blob([brut]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const out = new Uint8Array(await new Response(flux).arrayBuffer());
      if (taille && out.length !== taille) throw new Error('Fichier .zip abîmé.');
      return { octets: out, nom: nom.split('/').pop() };
    }
    throw new Error('Compression .zip non gérée : décompresse la ROM d\'abord.');
  }
  throw new Error('Aucune ROM Mega Drive (.bin, .gen, .md, .smd) dans ce .zip.');
}

async function preparerRom(octets, nom) {
  if (octets[0] === 0x50 && octets[1] === 0x4b && octets[2] === 3 && octets[3] === 4) {
    ({ octets, nom } = await dezipper(octets));
  }
  if (octets.length < 0x200) throw new Error('Ce fichier est trop petit pour être une ROM.');
  if (octets.length > 10 * 1048576) throw new Error('Fichier trop gros pour une cartouche Mega Drive.');
  return { octets, nom };
}

// ------------------------------------------------------------------ traductions du site
// Le site range chaque traduction avec l'empreinte (CRC32) de la ROM officielle qu'elle attend
// (data/projets.json). L'émulateur calcule l'empreinte de la ROM choisie et propose la version
// française s'il y en a une : il télécharge le patch, l'applique ici, et lance le jeu.
const TABLE_CRC = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  TABLE_CRC[i] = c >>> 0;
}
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = TABLE_CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (~c >>> 0).toString(16).toUpperCase().padStart(8, '0');
}
function appliquerBPS(src, patch) {
  if (patch[0] !== 0x42 || patch[1] !== 0x50 || patch[2] !== 0x53 || patch[3] !== 0x31) throw new Error('Patch invalide.');
  let o = 4;
  const num = () => {
    let d = 0, s = 1;
    for (;;) { const x = patch[o++]; d += (x & 0x7F) * s; if (x & 0x80) return d; s *= 128; d += s; }
  };
  num(); const nt = num(), nm = num();
  o += nm;
  const dst = new Uint8Array(nt);
  let w = 0, sr = 0, tr = 0;
  const fin = patch.length - 12;
  while (o < fin) {
    const a = num(), m = a % 4, ln = Math.floor(a / 4) + 1;
    if (m === 0) { dst.set(src.subarray(w, w + ln), w); w += ln; }
    else if (m === 1) { dst.set(patch.subarray(o, o + ln), w); o += ln; w += ln; }
    else {
      const d = num(), dd = d & 1 ? -Math.floor(d / 2) : Math.floor(d / 2);
      if (m === 2) { sr += dd; dst.set(src.subarray(sr, sr + ln), w); sr += ln; w += ln; }
      else { tr += dd; for (let k = 0; k < ln; k++) dst[w++] = dst[tr++]; }
    }
  }
  return dst;
}
// ROM « propre » : sans l'en-tête de 512 octets des copieurs (.smd) si c'est lui qui gêne
function versionPropre(octets) {
  const crc = crc32(octets);
  if (octets.length % 1024 === 512) {
    const sans = octets.subarray(512);
    return { octets, crc, sans, crcSans: crc32(sans) };
  }
  return { octets, crc };
}

let catalogue = null;
async function chargerCatalogue() {
  if (catalogue) return catalogue;
  try {
    const r = await fetch('../data/projets.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error();
    const d = await r.json();
    catalogue = (d.projets || []).filter((p) => p.patch && p.patch.format === 'bps'
      && /mega ?drive|genesis/i.test(p.plateforme || '') && p.patch.crc_source);
  } catch {
    catalogue = []; // hors ligne et jamais chargé : on joue sans proposer de traduction
  }
  return catalogue;
}
// Traductions qui s'appliquent à cette ROM (il peut y en avoir plusieurs : Dune et DuneRazorOpti…)
async function traductionsPour(octets) {
  const cat = await chargerCatalogue();
  const v = versionPropre(octets);
  const res = [];
  for (const p of cat) {
    if (p.patch.crc_source === v.crc) res.push({ p, source: v.octets });
    else if (v.sans && p.patch.crc_source === v.crcSans) res.push({ p, source: v.sans });
  }
  const dejaFr = cat.find((p) => p.patch.crc_sortie === v.crc);
  return { res, dejaFr };
}
async function patcher(p, source) {
  const r = await fetch('../' + p.patch.fichier + (p.revision ? '?r=' + p.revision : ''), { cache: 'no-cache' });
  if (!r.ok) throw new Error('patch introuvable sur le site (connexion internet ?)');
  const out = appliquerBPS(source, new Uint8Array(await r.arrayBuffer()));
  if (crc32(out) !== p.patch.crc_sortie) throw new Error('la vérification après le patch a échoué');
  return out;
}
async function jouerTraduction(p, source) {
  try {
    message('Téléchargement de la traduction « ' + p.titre + ' »…');
    const fr = await patcher(p, source);
    await lancer(fr, p.nom_sortie || p.id + '.bin', p.titre + ' (FR)', { pid: p.id, rev: p.revision || 0, origine: source });
  } catch (e) {
    message('Impossible d\'appliquer la traduction : ' + e.message, 'erreur');
  }
}
function libelleTrad(p) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'bouton bouton-or';
  b.textContent = '▶ Jouer en français : ' + p.titre;
  const sm = document.createElement('small');
  sm.textContent = [p.sous_titre, p.statut, p.version ? 'version ' + p.version : '', p.date_maj ? 'du ' + p.date_maj : '']
    .filter(Boolean).join(' · ');
  b.append(sm);
  return b;
}

// Dernière ROM gardée sur l'appareil (OPFS) pour la relancer d'un geste
async function dossierAppli() {
  const racine = await navigator.storage.getDirectory();
  return racine.getDirectoryHandle('playertime-emu', { create: true });
}
async function ecrireFichier(d, nom, octets) {
  const f = await (await d.getFileHandle(nom, { create: true })).createWritable();
  await f.write(octets); await f.close();
}
async function memoriserRom(octets, nom, titre, trad) {
  try {
    const d = await dossierAppli();
    await ecrireFichier(d, 'derniere.rom', octets);
    // pour une traduction, on garde aussi la ROM d'origine : si la traduction est mise à jour
    // sur le site, l'émulateur refait le patch tout seul au prochain lancement
    if (trad?.origine) await ecrireFichier(d, 'origine.rom', trad.origine);
    localStorage.setItem('pt-emu-derniere', nom);
    localStorage.setItem('pt-emu-derniere-info', JSON.stringify({ titre: titre || '', pid: trad?.pid || '', rev: trad?.rev || 0 }));
  } catch { /* stockage indisponible : tant pis, on joue quand même */ }
}
async function relireRom() {
  try {
    const nom = localStorage.getItem('pt-emu-derniere');
    if (!nom) return null;
    let info = {};
    try { info = JSON.parse(localStorage.getItem('pt-emu-derniere-info') || '{}'); } catch { /* */ }
    const d = await dossierAppli();
    const f = await (await d.getFileHandle('derniere.rom')).getFile();
    return { octets: new Uint8Array(await f.arrayBuffer()), nom, info, dossier: d };
  } catch { return null; }
}
// Reprendre la dernière partie ; si c'est une traduction mise à jour depuis, on la repatche
async function reprendre(derniere) {
  const { info } = derniere;
  if (info.pid) {
    const p = (await chargerCatalogue()).find((x) => x.id === info.pid);
    if (p && (p.revision || 0) !== info.rev) {
      try {
        const f = await (await derniere.dossier.getFileHandle('origine.rom')).getFile();
        const origine = new Uint8Array(await f.arrayBuffer());
        message('Nouvelle version de la traduction : mise à jour…');
        const fr = await patcher(p, origine);
        await lancer(fr, p.nom_sortie || derniere.nom, p.titre + ' (FR)', { pid: p.id, rev: p.revision || 0, origine });
        bulle('Traduction mise à jour ✔');
        return;
      } catch { /* pas possible maintenant : on joue l'ancienne version */ }
    }
  }
  lancer(derniere.octets, derniere.nom, info.titre || '');
}

// ------------------------------------------------------------------ lancement
let partie = null;
let romCourante = null;

async function lancer(octets, nom, titre, trad) {
  message('');
  // Un seul BlastEm par page : pour changer de jeu, on recharge la page.
  if (partie) {
    await memoriserRom(octets, nom, titre, trad);
    sessionStorage.setItem('pt-emu-relancer', '1');
    location.reload();
    return;
  }
  romCourante = { octets, nom, titre };
  memoriserRom(octets, nom, titre, trad);
  $('#accueil').hidden = true;
  $('#jeu').hidden = false;
  document.title = (titre || nomPropre(nom)) + ' – Émulateur Player Time';
  pleinEcran(true);
  try {
    const wasmUrl = await chargerCoeur();
    partie = await new BlastemSDK()
      .config({
        region: R.region,
        shader: R.shader,
        scanlines: R.scan,
        renderFilter: R.lisse ? 'smooth' : 'pixelated',
        border: 'hidden',
        wasmUrl,
      })
      .assets({ rom: octets })
      .storage({ namespace: espace(nom) })
      .on('error', ({ detail }) => bulle('Erreur : ' + (detail?.message || detail)))
      .mount($('#ecran'))
      .start();
    garderEcranAllume();
    bulle(titre || nomPropre(nom));
  } catch (e) {
    console.error(e);
    $('#jeu').hidden = true;
    $('#accueil').hidden = false;
    message('Impossible de lancer le jeu : ' + e.message, 'erreur');
  }
}

let patchDemande = null; // emulateur/?patch=ristar : le joueur vient de la page d'une traduction

async function depuisFichier(fichier) {
  try {
    message('Lecture de ' + fichier.name + '…');
    const { octets, nom } = await preparerRom(new Uint8Array(await fichier.arrayBuffer()), fichier.name);
    message('Recherche d\'une traduction…');
    const { res, dejaFr } = await traductionsPour(octets);
    message('');
    if (patchDemande) {
      const bon = res.find((t) => t.p.id === patchDemande.id);
      if (bon) return jouerTraduction(bon.p, bon.source);
      if (dejaFr?.id === patchDemande.id) return lancer(octets, nom, patchDemande.titre + ' (FR)');
      return message('Ce n\'est pas la bonne ROM pour « ' + patchDemande.titre + ' » : il faut ' +
        (patchDemande.rom_attendue || 'la ROM officielle') + ' (CRC32 ' + patchDemande.patch.crc_source + ').', 'erreur');
    }
    if (!res.length) return lancer(octets, nom, dejaFr ? dejaFr.titre + ' (FR)' : '');
    // une ou plusieurs traductions pour ce jeu : on laisse choisir
    const liste = $('#choix-liste');
    liste.replaceChildren(...res.map(({ p, source }) => {
      const b = libelleTrad(p);
      b.addEventListener('click', () => jouerTraduction(p, source));
      return b;
    }));
    $('#choix-titre').textContent = res.length > 1
      ? 'Ce jeu a ' + res.length + ' versions françaises sur le site !'
      : 'Ce jeu existe en français sur le site !';
    $('#btn-origine').onclick = () => { $('#choix').hidden = true; lancer(octets, nom, ''); };
    $('#choix').hidden = false;
    $('#choix').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    message(e.message, 'erreur');
  }
}

async function depuisAdresse(url, titre) {
  try {
    message('Téléchargement du jeu…');
    const rep = await fetch(url);
    if (!rep.ok) throw new Error('jeu introuvable (' + rep.status + ')');
    const nom = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || 'jeu.bin');
    const { octets, nom: n } = await preparerRom(new Uint8Array(await rep.arrayBuffer()), nom);
    await lancer(octets, n, titre);
  } catch (e) {
    message('Impossible de charger le jeu : ' + e.message, 'erreur');
  }
}

// ------------------------------------------------------------------ manette tactile
const TOUCHES = Object.fromEntries(BLASTEM_CONTROLS.map((c) => [c.id, c]));
const CODES_CLAVIER = { Enter: 13, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
const enfonce = new Set();

function envoyerTouche(id, bas) {
  Diag.touche(id, bas);
  const c = TOUCHES[id];
  const canvas = $('#ecran canvas');
  if (!c || !canvas) return;
  // Même méthode que le SDK pour rejouer une touche : un vrai KeyboardEvent que SDL lit.
  const ev = new KeyboardEvent(bas ? 'keydown' : 'keyup', { code: c.code, key: c.key, bubbles: true, cancelable: true });
  const kc = CODES_CLAVIER[c.code] ?? c.key.toUpperCase().charCodeAt(0);
  Object.defineProperty(ev, 'keyCode', { get: () => kc });
  Object.defineProperty(ev, 'which', { get: () => kc });
  canvas.dispatchEvent(ev);
}

function directionsCroix(x, y) {
  const r = $('#croix').getBoundingClientRect();
  const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
  const rayon = r.width / 2;
  if (Math.hypot(dx, dy) < rayon * 0.18) return [];
  // 8 directions : secteurs de 45°, diagonales comprises
  const a = (Math.atan2(dy, dx) * 180) / Math.PI; // 0 = droite, 90 = bas
  const out = [];
  if (a > -67.5 && a < 67.5) out.push('right');
  if (a > 112.5 || a < -112.5) out.push('left');
  if (a > 22.5 && a < 157.5) out.push('down');
  if (a < -22.5 && a > -157.5) out.push('up');
  return out;
}

const doigts = new Map(); // pointerId -> {x, y, surCroix}
function touchesSousDoigt({ x, y, surCroix }) {
  if (surCroix) return directionsCroix(x, y);
  const el = document.elementFromPoint(x, y);
  const b = el?.closest?.('[data-k]');
  return b ? [b.dataset.k] : [];
}
// Une touche reste enfoncée au moins 4 images affichées. Sur téléphone, l'émulation avance par
// à-coups : avec une durée en millisecondes, l'appui et le relâché pouvaient arriver ensemble,
// entre deux lectures de la manette, et le jeu ne voyait rien. Compter les images du navigateur
// garantit que la boucle de l'émulateur a tourné plusieurs fois entre les deux.
const IMAGES_MINI = 4;
let image = 0;
const appuiImage = new Map(); // touche -> numéro d'image de l'appui
const relachesEnAttente = new Set();
function boucleImages() {
  image++;
  for (const k of relachesEnAttente) {
    if (image - (appuiImage.get(k) || 0) >= IMAGES_MINI) { relachesEnAttente.delete(k); envoyerTouche(k, false); }
  }
  Diag.image();
  requestAnimationFrame(boucleImages);
}
requestAnimationFrame(boucleImages);
function appuyer(k) {
  if (relachesEnAttente.delete(k)) return; // ré-appui avant la fin : la touche n'a jamais été relâchée
  appuiImage.set(k, image);
  envoyerTouche(k, true);
}
function relacher(k) {
  if (image - (appuiImage.get(k) || 0) >= IMAGES_MINI) envoyerTouche(k, false);
  else relachesEnAttente.add(k);
}
let boutonsManette = null;
function recalculer() {
  const voulu = new Set();
  for (const d of doigts.values()) for (const k of touchesSousDoigt(d)) voulu.add(k);
  let change = false, nouveau = false;
  for (const k of enfonce) if (!voulu.has(k)) { enfonce.delete(k); relacher(k); change = true; }
  for (const k of voulu) if (!enfonce.has(k)) { enfonce.add(k); appuyer(k); nouveau = change = true; }
  if (!change) return; // le doigt a bougé sans changer de touche : rien à faire
  if (nouveau && R.vibre && navigator.vibrate) navigator.vibrate(10);
  const croix = $('#croix');
  for (const dir of ['up', 'down', 'left', 'right']) croix.classList.toggle(dir, enfonce.has(dir));
  boutonsManette ??= [...document.querySelectorAll('#manette [data-k]')];
  for (const b of boutonsManette) b.classList.toggle('appui', enfonce.has(b.dataset.k));
}
function brancherManette() {
  const zone = $('#manette');
  // Pas de setPointerCapture : sur un vrai téléphone, le navigateur garde déjà le doigt sur
  // l'élément touché (et ses mouvements remontent jusqu'ici). Le reprendre envoyait un
  // « lostpointercapture » qui relâchait la touche aussitôt : rien n'arrivait au jeu.
  const debut = (e) => {
    if (document.body.classList.contains('placement')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const surCroix = !!e.target.closest('#croix');
    if (!surCroix && !e.target.closest('[data-k]')) return;
    e.preventDefault();
    doigts.set(e.pointerId, { x: e.clientX, y: e.clientY, surCroix });
    recalculer();
  };
  const bouge = (e) => {
    const d = doigts.get(e.pointerId);
    if (!d) return;
    e.preventDefault();
    d.x = e.clientX; d.y = e.clientY;
    recalculer();
  };
  const fin = (e) => {
    if (!doigts.delete(e.pointerId)) return;
    recalculer();
  };
  zone.addEventListener('pointerdown', debut);
  zone.addEventListener('pointermove', bouge);
  zone.addEventListener('pointerup', fin);
  zone.addEventListener('pointercancel', fin);
  // le doigt qui sort de l'écran ou part ailleurs : on relâche (pointerup peut ne pas arriver ici)
  addEventListener('pointerup', fin);
  addEventListener('pointercancel', fin);
  // aucun geste du navigateur (zoom, défilement, menu de sélection) sur la manette
  for (const t of ['touchstart', 'touchmove', 'touchend']) {
    zone.addEventListener(t, (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
  }
  zone.addEventListener('contextmenu', (e) => e.preventDefault());
  // Un écran tactile détecté : on montre la manette même sur une tablette / PC tactile
  addEventListener('touchstart', () => document.body.classList.add('tactile'), { once: true, passive: true });
}
function relacherTout() {
  doigts.clear();
  recalculer();
}

// ------------------------------------------------------------------ test des touches
// Panneau affiché par-dessus le jeu (menu ☰ → Test des touches, ou Réglages) :
// - les 12 commandes s'allument quand la page les envoie à l'émulateur ;
// - la durée de chaque appui, en millisecondes et en images ;
// - la vitesse de l'émulateur (images/s annoncées par BlastEm) et de l'écran du téléphone.
// Si une touche s'allume ici mais que le jeu ne réagit pas, le souci est du côté de l'émulateur.
const Diag = (() => {
  const ORDRE = ['up', 'down', 'left', 'right', 'a', 'b', 'c', 'start', 'x', 'y', 'z', 'mode'];
  const NOMS = { up: '↑', down: '↓', left: '←', right: '→', start: 'ST', mode: 'MD' };
  let cases = null, journal = null, ligne = null;
  const debut = new Map();
  let images = 0, t0 = performance.now(), hz = 0, pire = 0, dernier = performance.now();
  function monter() {
    const p = $('#diag');
    p.querySelector('.diag-touches').replaceChildren(...ORDRE.map((k) => {
      const c = document.createElement('span'); c.dataset.d = k; c.textContent = NOMS[k] || k.toUpperCase(); return c;
    }));
    cases = Object.fromEntries([...p.querySelectorAll('.diag-touches span')].map((c) => [c.dataset.d, c]));
    journal = p.querySelector('.diag-journal');
    ligne = p.querySelector('.diag-ligne');
  }
  function touche(k, bas) {
    if (!R.diag) return;
    if (!cases) monter();
    cases[k]?.classList.toggle('on', bas);
    const maintenant = performance.now();
    if (bas) { debut.set(k, { t: maintenant, i: image }); return; }
    const d = debut.get(k);
    if (!d) return;
    const li = document.createElement('li');
    li.textContent = `${NOMS[k] || k.toUpperCase()} : ${Math.round(maintenant - d.t)} ms, ${image - d.i} images`;
    journal.prepend(li);
    while (journal.children.length > 5) journal.lastChild.remove();
  }
  function image_() {
    const maintenant = performance.now();
    pire = Math.max(pire, maintenant - dernier);
    dernier = maintenant;
    images++;
    if (maintenant - t0 < 1000) return;
    hz = Math.round((images * 1000) / (maintenant - t0));
    if (R.diag && partie) {
      if (!cases) monter();
      const fps = (document.title.match(/([\d.]+)\s*fps/) || [])[1];
      ligne.textContent = `v${VERSION_APPLI} · jeu ${fps ? Math.round(fps) + ' im/s' : '…'} · écran ${hz} Hz · pire pause ${Math.round(pire)} ms`;
    }
    images = 0; t0 = maintenant; pire = 0;
  }
  return { touche, image: image_ };
})();

// ------------------------------------------------------------------ placer les touches
// Chaque bloc (croix, boutons A B C / X Y Z, START, MODE) peut être glissé au doigt.
// Position gardée en fraction de la zone de la manette, à part pour le portrait et le paysage.
const TRANSFORMS = { boutons: ' rotate(-18deg)' };
const orientation = () => (matchMedia('(orientation: landscape)').matches ? 'paysage' : 'portrait');
function placer(el, pos) {
  if (pos) {
    el.style.left = (pos.x * 100) + '%';
    el.style.top = (pos.y * 100) + '%';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.transform = 'translate(-50%, -50%)' + (TRANSFORMS[el.dataset.place] || '');
  } else {
    for (const p of ['left', 'top', 'right', 'bottom', 'transform']) el.style[p] = '';
  }
}
function appliquerDisposition() {
  const d = (R.disp || {})[orientation()] || {};
  for (const el of document.querySelectorAll('#manette [data-place]')) placer(el, d[el.dataset.place]);
}
addEventListener('resize', appliquerDisposition);
matchMedia('(orientation: landscape)').addEventListener?.('change', appliquerDisposition);

function brancherPlacement() {
  const zone = $('#manette');
  let tenu = null; // { el, id, dx, dy }
  zone.addEventListener('pointerdown', (e) => {
    if (!document.body.classList.contains('placement')) return;
    const el = e.target.closest('[data-place]');
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    const r = el.getBoundingClientRect();
    tenu = { el, id: el.dataset.place, pid: e.pointerId, dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - (r.top + r.height / 2) };
    el.classList.add('tenu');
  }, true);
  const bouge = (e) => {
    if (!tenu || e.pointerId !== tenu.pid) return;
    e.preventDefault();
    const z = zone.getBoundingClientRect();
    const x = Math.min(0.98, Math.max(0.02, (e.clientX - tenu.dx - z.left) / z.width));
    const y = Math.min(0.98, Math.max(0.02, (e.clientY - tenu.dy - z.top) / z.height));
    tenu.pos = { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
    placer(tenu.el, tenu.pos);
  };
  const lache = (e) => {
    if (!tenu || e.pointerId !== tenu.pid) return;
    tenu.el.classList.remove('tenu');
    if (tenu.pos) {
      const o = orientation();
      R.disp = R.disp || {};
      R.disp[o] = { ...(R.disp[o] || {}), [tenu.id]: tenu.pos };
      ecrireReglages();
    }
    tenu = null;
  };
  addEventListener('pointermove', bouge, { passive: false });
  addEventListener('pointerup', lache);
  addEventListener('pointercancel', lache);

  $('#p-taille').addEventListener('input', (e) => {
    R.taille = Number(e.target.value); $('#r-taille').value = R.taille;
    ecrireReglages(); appliquerReglagesVisuels();
  });
  $('#p-reset').addEventListener('click', () => {
    if (R.disp) delete R.disp[orientation()];
    ecrireReglages(); appliquerDisposition();
    bulle('Placement par défaut (' + orientation() + ')');
  });
  $('#p-ok').addEventListener('click', () => {
    document.body.classList.remove('placement');
    $('#placement').hidden = true;
    partie?.resume(OWNER);
    bulle('Placement enregistré');
  });
}
function ouvrirPlacement() {
  relacherTout();
  partie?.pause(OWNER); // déjà en pause par le menu : le jeu reste figé pendant le placement
  $('#p-taille').value = R.taille;
  document.body.classList.add('placement');
  $('#placement').hidden = false;
}

// ------------------------------------------------------------------ menu pause
function ouvrirMenu() {
  if (!partie) return;
  relacherTout();
  partie.pause(OWNER);
  $('#menu-titre').textContent = romCourante ? (romCourante.titre || nomPropre(romCourante.nom)) : 'Pause';
  majInfoSlot();
  $('#menu').showModal();
}
function fermerMenu() {
  $('#menu').close();
}
function majInfoSlot() {
  try {
    const s = partie.states.get(Number($('#slot').value));
    $('#menu-info').textContent = s.savedAt
      ? 'État sauvé le ' + s.savedAt.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
      : 'Emplacement vide';
  } catch { $('#menu-info').textContent = ''; }
}
async function action(nom) {
  const slot = Number($('#slot').value);
  try {
    switch (nom) {
      case 'menu': ouvrirMenu(); break;
      case 'reprendre': fermerMenu(); break;
      case 'sauver':
        $('#menu-info').textContent = 'Sauvegarde…';
        await partie.states.save(slot);
        fermerMenu(); bulle('État sauvé (emplacement ' + (slot + 1) + ')');
        break;
      case 'charger':
        if (partie.states.load(slot)) { fermerMenu(); bulle('État chargé (emplacement ' + (slot + 1) + ')'); }
        else $('#menu-info').textContent = 'Rien dans cet emplacement.';
        break;
      case 'reset': fermerMenu(); await partie.restart(); bulle('Reset'); break;
      case 'plein': fermerMenu(); pleinEcran(!document.fullscreenElement); break;
      case 'placer': ouvrirPlacement(); $('#menu').close(); break;
      case 'test':
        R.diag = !R.diag; ecrireReglages(); appliquerReglagesVisuels();
        $('#r-diag').checked = R.diag;
        fermerMenu(); bulle(R.diag ? 'Test des touches affiché' : 'Test des touches masqué');
        break;
      case 'changer':
        await partie.flushSaves?.();
        location.href = location.pathname; // retour à l'accueil (page neuve)
        break;
    }
  } catch (e) {
    $('#menu-info').textContent = e.message;
  }
}

// ------------------------------------------------------------------ confort téléphone
function pleinEcran(oui) {
  try {
    if (oui && !document.fullscreenElement) {
      const p = document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
      p?.then(() => screen.orientation?.lock?.('landscape').catch(() => {})).catch(() => {});
    } else if (!oui && document.fullscreenElement) {
      document.exitFullscreen?.();
    }
  } catch { /* iPhone : pas de plein écran pour les pages, l'appli installée en tient lieu */ }
}
let verrou = null;
async function garderEcranAllume() {
  try { verrou = await navigator.wakeLock?.request('screen'); } catch { /* */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    relacherTout();
    partie?.flushSaves?.();
  } else if (partie) {
    garderEcranAllume();
  }
});

// Installation en appli (Android / Chrome) et astuce iPhone
let invite = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  invite = e;
  $('#installer').hidden = false;
});
function brancherInstallation() {
  $('#btn-installer').addEventListener('click', async () => {
    if (!invite) return;
    invite.prompt();
    await invite.userChoice;
    invite = null;
    $('#installer').hidden = true;
  });
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installee = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (ios && !installee) $('#astuce-ios').hidden = false;
}

// ------------------------------------------------------------------ démarrage de la page
async function demarrer() {
  for (const e of document.querySelectorAll('.version-appli')) e.textContent = `Version ${VERSION_APPLI} du ${DATE_APPLI}`;
  brancherReglages();
  brancherManette();
  brancherPlacement();
  appliquerDisposition();
  brancherInstallation();

  if ('serviceWorker' in navigator) {
    // Nouvelle version publiée : dès qu'elle est prête, la page se recharge toute seule
    // (seulement depuis l'accueil, jamais pendant une partie).
    const avait = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (avait && !partie && !sessionStorage.getItem('pt-emu-maj')) {
        sessionStorage.setItem('pt-emu-maj', '1');
        location.reload();
      }
    });
    navigator.serviceWorker.register('sw.js').then((r) => r.update()).catch(() => {});
  }
  // On prépare le cœur tout de suite : le jeu démarrera sans attente.
  chargerCoeur().catch(() => {});

  $('#fichier').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) depuisFichier(f);
  });

  for (const b of document.querySelectorAll('[data-action]')) {
    b.addEventListener('click', () => action(b.dataset.action));
  }
  $('#slot').addEventListener('change', majInfoSlot);
  $('#menu').addEventListener('close', () => { if (!document.body.classList.contains('placement')) partie?.resume(OWNER); });
  $('#menu').addEventListener('click', (e) => { if (e.target === $('#menu')) fermerMenu(); });

  // Touche Échap / bouton retour de la manette : menu (au clavier BlastEm garde ses touches)
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && partie && !$('#menu').open) { e.preventDefault(); e.stopImmediatePropagation(); ouvrirMenu(); }
  }, true);

  // Venu de la page d'une traduction : emulateur/?patch=ristar
  const idPatch = new URLSearchParams(location.search).get('patch');
  if (idPatch) {
    const p = (await chargerCatalogue()).find((x) => x.id === idPatch);
    if (p) {
      patchDemande = p;
      $('#demande-patch-texte').textContent = 'Pour jouer à « ' + p.titre + ' » en français, choisis ta ROM officielle : '
        + (p.rom_attendue || 'le jeu d\'origine') + '. La traduction s\'applique toute seule.';
      $('#demande-patch').hidden = false;
      $('#btn-rom').firstChild.textContent = 'Choisir ma ROM de ' + p.titre + '…';
    }
  }
  chargerCatalogue(); // en avance, pour reconnaître les jeux sans attendre

  // Un jeu passé dans l'adresse : emulateur/?rom=../jeux/gem-assault.bin (même site uniquement)
  const param = new URLSearchParams(location.search).get('rom');
  const titreJeu = (new URLSearchParams(location.search).get('titre') || '').slice(0, 80);
  if (param) {
    try {
      const url = new URL(param, location.href);
      if (url.origin !== location.origin) throw new Error();
      const nom = decodeURIComponent(url.pathname.split('/').pop());
      $('#btn-url').textContent = '▶ Jouer à ' + (titreJeu || nomPropre(nom));
      $('#lancer-url').hidden = false;
      $('#btn-url').addEventListener('click', () => depuisAdresse(url.href, titreJeu));
    } catch { message('Adresse de jeu refusée (seuls les jeux de ce site).', 'erreur'); }
  }

  // Changement de jeu demandé avant le rechargement : un toucher pour relancer (le son l'exige)
  const derniere = await relireRom();
  if (sessionStorage.getItem('pt-emu-relancer') && derniere) {
    sessionStorage.removeItem('pt-emu-relancer');
    $('#accueil').hidden = true;
    $('#jeu').hidden = false;
    $('#toucher').hidden = false;
    $('#toucher').addEventListener('click', () => {
      $('#toucher').hidden = true;
      lancer(derniere.octets, derniere.nom, derniere.info.titre || '');
    }, { once: true });
    return;
  }
  if (derniere) {
    $('#btn-reprendre').textContent = '▶ Reprendre : ' + (derniere.info.titre || nomPropre(derniere.nom));
    $('#reprendre').hidden = false;
    $('#btn-reprendre').addEventListener('click', () => reprendre(derniere));
  }
}

demarrer();
