// Player Time — enveloppe autour de blastem.js (le cœur BlastEm compilé, GPL v3).
//
// Pourquoi : pour garder la sauvegarde de la cartouche (SRAM) dans le téléphone, il faut la
// recopier régulièrement dans un fichier. La seule façon prévue est de demander à BlastEm
// (web_persist_save), mais il affiche alors « Saved SRAM to /save/save.sram » à l'écran.
//
// Ici, on charge le cœur nous-mêmes pour avoir accès à sa mémoire, on repère où se trouve la
// SRAM du jeu, puis on la recopie nous-mêmes dans le fichier : même résultat, sans message.
// - Repérage : au lancement, si une sauvegarde existe déjà, on cherche son contenu exact dans
//   la mémoire de l'émulateur (une seule place doit correspondre).
// - Pas encore de sauvegarde (jeu jamais sauvegardé) : on laisse BlastEm faire la recopie, mais
//   seulement quand l'appli est en arrière-plan (écran éteint, autre appli) ou en quittant le
//   jeu, jamais pendant que tu joues ; puis on repère la SRAM à partir de ce fichier.

import createBlastemOriginal from './blastem.js';

const DOSSIER = '/save';
const estSauvegarde = (nom) => nom !== '.' && nom !== '..' && !/^slot_/.test(nom);

export default async function createBlastem(options) {
  let memoire = null;
  const wasmUrl = options.locateFile ? options.locateFile('blastem.wasm') : 'blastem.wasm';
  const opts = {
    ...options,
    // On instancie le cœur nous-mêmes pour garder la main sur sa mémoire.
    instantiateWasm(imports, recevoir) {
      (async () => {
        const rep = await fetch(wasmUrl);
        let res;
        try {
          res = await WebAssembly.instantiateStreaming(rep.clone(), imports);
        } catch {
          res = await WebAssembly.instantiate(await rep.arrayBuffer(), imports);
        }
        memoire = res.instance.exports.memory;
        recevoir(res.instance, res.module);
      })().catch((e) => options.onAbort?.(e));
      return {};
    },
  };
  const Module = await createBlastemOriginal(opts);
  const FS = Module.FS;
  const reperees = new Map(); // nom du fichier -> { adresse, taille }

  const tas = () => new Uint8Array(memoire.buffer);

  // Cherche le contenu exact d'un fichier de sauvegarde dans la mémoire de l'émulateur.
  function reperer(nom) {
    if (!memoire || reperees.has(nom)) return;
    let octets;
    try { octets = FS.readFile(DOSSIER + '/' + nom); } catch { return; }
    const n = octets.length;
    if (n < 32) return;
    // contenu trop uniforme (vide, tout à 0 ou à FF) : impossible de savoir où il est
    if (new Set(octets.subarray(0, Math.min(n, 4096))).size < 4) return;
    // un repère de 16 octets variés à l'intérieur du fichier
    let k = 0;
    for (; k + 16 <= n; k++) if (new Set(octets.subarray(k, k + 16)).size >= 6) break;
    if (k + 16 > n) return;
    const h = tas();
    const trouvees = [];
    for (let i = h.indexOf(octets[k], k); i !== -1 && i + n - k <= h.length; i = h.indexOf(octets[k], i + 1)) {
      let ok = true;
      for (let j = 1; j < 16; j++) if (h[i + j] !== octets[k + j]) { ok = false; break; }
      if (!ok) continue;
      const debut = i - k;
      for (let j = 0; j < n; j++) if (h[debut + j] !== octets[j]) { ok = false; break; }
      if (ok) { trouvees.push(debut); if (trouvees.length > 1) break; }
    }
    if (trouvees.length === 1) reperees.set(nom, { adresse: trouvees[0], taille: n });
  }
  function repererTout() {
    try { for (const nom of FS.readdir(DOSSIER)) if (estSauvegarde(nom)) reperer(nom); } catch { /* pas encore de dossier */ }
  }

  // Recopie silencieuse : mémoire de l'émulateur -> fichier (le SDK l'envoie ensuite dans le téléphone)
  function recopier() {
    const h = tas();
    for (const [nom, { adresse, taille }] of reperees) {
      const chemin = DOSSIER + '/' + nom;
      const actuel = h.subarray(adresse, adresse + taille);
      let ancien = null;
      try { ancien = FS.readFile(chemin); } catch { /* */ }
      let pareil = ancien && ancien.length === taille;
      if (pareil) for (let j = 0; j < taille; j++) if (ancien[j] !== actuel[j]) { pareil = false; break; }
      if (!pareil) FS.writeFile(chemin, actuel.slice());
    }
  }

  const persistOriginal = Module._web_persist_save;
  Module._web_persist_save = () => {
    if (reperees.size) { recopier(); return; }
    repererTout(); // la sauvegarde chargée au départ n'a peut-être pas encore bougé : on réessaie
    if (reperees.size) { recopier(); return; }
    // Pas encore repérée : BlastEm fait la recopie (avec son message), mais seulement quand
    // personne ne regarde, ou quand on quitte le jeu.
    if (document.hidden || globalThis.ptForcerSauvegarde) {
      persistOriginal();
      repererTout();
    }
  };

  // Mega CD : la page prépare globalThis.ptDisque = { fichiers: [{ nom, octets }], principal, bios: { us, eu, jp } }
  // On range le disque et les BIOS dans le système de fichiers de BlastEm, on lui indique où
  // sont les BIOS (default.cfg, section system), puis on lui donne le disque au lieu de la ROM.
  function preparerDisque(args) {
    const d = globalThis.ptDisque;
    if (!d) return args;
    for (const dossier of ['/cd', '/bios']) { try { FS.mkdir(dossier); } catch { /* existe */ } }
    // canOwn : le système de fichiers garde le tableau tel quel, sans le recopier (un disque
    // pèse des centaines de Mo, une copie en plus peut faire tomber un téléphone)
    for (const f of d.fichiers) {
      const flux = FS.open('/cd/' + f.nom, 'w');
      FS.write(flux, f.octets, 0, f.octets.length, 0, true);
      FS.close(flux);
    }
    const lignes = [];
    for (const [region, cle] of [['us', 'scd_bios_us'], ['eu', 'scd_bios_eu'], ['jp', 'scd_bios_jp']]) {
      // une région sans BIOS prend celui d'une autre : mieux que rien (certains jeux le refusent)
      const octets = d.bios[region] || d.bios.eu || d.bios.us || d.bios.jp;
      if (!octets) continue;
      FS.writeFile('/bios/' + region + '.md', octets);
      lignes.push('\t' + cle + ' /bios/' + region + '.md');
    }
    const cfg = new TextDecoder().decode(FS.readFile('/default.cfg'));
    FS.writeFile('/default.cfg', new TextEncoder().encode(cfg.replace(/\nsystem \{\n/, (m) => m + lignes.join('\n') + '\n')));
    // l'avant-dernier trio d'arguments : chemin de la ROM, largeur, hauteur
    const a = [...args];
    a[a.length - 3] = '/cd/' + d.principal;
    globalThis.ptDisque = null; // la page n'en a plus besoin : la mémoire peut être libérée
    return a;
  }

  // Juste après le démarrage du jeu (la sauvegarde existante vient d'être chargée) : repérage.
  const callMainOriginal = Module.callMain;
  Module.callMain = (args, ...reste) => {
    const r = callMainOriginal(preparerDisque(args), ...reste);
    repererTout();
    return r;
  };

  Module.ptSauvegardes = { reperees, repererTout, memoire: () => memoire }; // pour le diagnostic
  globalThis.ptModule = Module;
  return Module;
}
