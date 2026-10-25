/* Patcheur dans le navigateur : BPS (cartouches) et SFCDFR01 (Shining Force CD).
   Tout se passe sur l'ordinateur du visiteur : la ROM n'est jamais envoyée. */
'use strict';

const Patcheur = (() => {
  // ---------- CRC32 ----------
  const TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    TABLE[i] = c >>> 0;
  }
  function crc32(u8, crc = 0) {
    crc = ~crc >>> 0;
    for (let i = 0; i < u8.length; i++) crc = TABLE[(crc ^ u8[i]) & 0xFF] ^ (crc >>> 8);
    return (~crc) >>> 0;
  }
  const hex = n => n.toString(16).toUpperCase().padStart(8, '0');

  class ErreurPatch extends Error {}

  // ---------- ZIP (lecture de la première ROM d'une archive) ----------
  async function inflateRaw(u8) {
    const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  async function lireZip(file, extensions) {
    const fin = new Uint8Array(await file.slice(Math.max(0, file.size - 65558)).arrayBuffer());
    let e = -1;
    for (let i = fin.length - 22; i >= 0; i--) {
      if (fin[i] === 0x50 && fin[i + 1] === 0x4B && fin[i + 2] === 5 && fin[i + 3] === 6) { e = i; break; }
    }
    if (e < 0) throw new ErreurPatch("Cette archive .zip est illisible.");
    const dv = new DataView(fin.buffer, e);
    const n = dv.getUint16(10, true), cdTaille = dv.getUint32(12, true), cdOff = dv.getUint32(16, true);
    const cd = new Uint8Array(await file.slice(cdOff, cdOff + cdTaille).arrayBuffer());
    const v = new DataView(cd.buffer);
    let o = 0;
    const entrees = [];
    for (let i = 0; i < n; i++) {
      const meth = v.getUint16(o + 10, true), comp = v.getUint32(o + 20, true), brut = v.getUint32(o + 24, true);
      const ln = v.getUint16(o + 28, true), le = v.getUint16(o + 30, true), lc = v.getUint16(o + 32, true);
      const loc = v.getUint32(o + 42, true);
      const nom = new TextDecoder().decode(cd.subarray(o + 46, o + 46 + ln));
      entrees.push({ nom, meth, comp, brut, loc });
      o += 46 + ln + le + lc;
    }
    const ent = entrees.find(x => extensions.some(ext => x.nom.toLowerCase().endsWith(ext)));
    if (!ent) throw new ErreurPatch("Aucune ROM trouvée dans l'archive .zip.");
    const lh = new DataView(await file.slice(ent.loc, ent.loc + 30).arrayBuffer());
    const debut = ent.loc + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const data = new Uint8Array(await file.slice(debut, debut + ent.comp).arrayBuffer());
    if (ent.meth === 0) return { nom: ent.nom.split('/').pop(), data };
    if (ent.meth === 8) return { nom: ent.nom.split('/').pop(), data: await inflateRaw(data) };
    throw new ErreurPatch("Méthode de compression du .zip non prise en charge : décompresse-le d'abord.");
  }

  // ---------- BPS ----------
  function appliquerBPS(src, patch) {
    if (patch[0] !== 0x42 || patch[1] !== 0x50 || patch[2] !== 0x53 || patch[3] !== 0x31)
      throw new ErreurPatch('Fichier de patch invalide.');
    let o = 4;
    const num = () => {
      let d = 0, s = 1;
      for (;;) {
        const x = patch[o++];
        d += (x & 0x7F) * s;
        if (x & 0x80) return d;
        s *= 128;
        d += s;
      }
    };
    const ns = num(), nt = num(), nm = num();
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

  /* Prépare la ROM d'une cartouche : .zip, en-tête SMD de 512 octets, vérification du CRC. */
  async function patcherCartouche(file, patch, info, log) {
    let nom = file.name, data;
    if (nom.toLowerCase().endsWith('.zip')) {
      log("Lecture de l'archive .zip…");
      const z = await lireZip(file, ['.bin', '.md', '.gen', '.smd', '.68k', '.sms', '.gg', '.32x', '.sg']);
      nom = z.nom; data = z.data;
    } else {
      data = new Uint8Array(await file.arrayBuffer());
    }
    log('Vérification de la ROM…');
    let crc = crc32(data);
    if (crc !== parseInt(info.crc_source, 16) && data.length % 1024 === 512) {
      data = data.subarray(512);  // en-tête de copieur
      crc = crc32(data);
    }
    if (crc !== parseInt(info.crc_source, 16)) {
      const sortie = parseInt(info.crc_sortie, 16);
      if (crc === sortie) throw new ErreurPatch('Cette ROM est déjà patchée avec cette version.');
      throw new ErreurPatch(`Ce n'est pas la ROM attendue (CRC32 ${hex(crc)} au lieu de ${info.crc_source}). ` +
        'Choisis la ROM officielle sans modification.');
    }
    log('ROM reconnue. Application du patch…');
    const out = appliquerBPS(data, patch);
    if (crc32(out) !== parseInt(info.crc_sortie, 16)) throw new ErreurPatch('La vérification après le patch a échoué.');
    log('Patch appliqué et vérifié.');
    return [{ blob: new Blob([out], { type: 'application/octet-stream' }) }];
  }

  // ---------- SFCDFR01 (Mega CD) ----------
  const EDC = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let e = i;
    for (let k = 0; k < 8; k++) e = (e >>> 1) ^ (e & 1 ? 0xD8018001 : 0);
    EDC[i] = e >>> 0;
  }
  const FF = new Uint8Array(256), FB = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const j = (i << 1) ^ (i & 0x80 ? 0x11D : 0);
    FF[i] = j & 0xFF; FB[i ^ FF[i]] = i;
  }
  function edc(u8, n) {
    let e = 0;
    for (let i = 0; i < n; i++) e = (e >>> 8) ^ EDC[(e ^ u8[i]) & 0xFF];
    return e >>> 0;
  }
  function ecc(sec, major, minor, mmul, minc, dst) {
    const size = major * minor;
    for (let mj = 0; mj < major; mj++) {
      let idx = (mj >> 1) * mmul + (mj & 1), a = 0, b = 0;
      for (let mn = 0; mn < minor; mn++) {
        const t = idx < 2340 ? sec[12 + idx] : 0;
        idx += minc; if (idx >= size) idx -= size;
        a ^= t; b ^= t; a = FF[a];
      }
      a = FB[FF[a] ^ b];
      sec[dst + mj] = a; sec[dst + mj + major] = a ^ b;
    }
  }
  function fixer(sec) {
    const e = edc(sec, 2064);
    sec[2064] = e & 0xFF; sec[2065] = (e >>> 8) & 0xFF; sec[2066] = (e >>> 16) & 0xFF; sec[2067] = e >>> 24;
    sec.fill(0, 2068, 2076);
    ecc(sec, 86, 24, 2, 86, 2076);
    ecc(sec, 52, 43, 86, 88, 2076 + 172);
  }
  async function inflate(u8) {
    const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  const sha1 = async u8 => new Uint8Array(await crypto.subtle.digest('SHA-1', u8));
  const egal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  async function patcherSFCD(fichiers, patchBrut, nomSortie, log, progres) {
    const bin = fichiers.find(f => /\.(bin|iso|img)$/i.test(f.name));
    const cue = fichiers.find(f => /\.cue$/i.test(f.name));
    if (!bin) throw new ErreurPatch("Choisis l'image .bin (ou .iso) de Shining Force CD (USA).");
    const blob = await inflate(patchBrut);
    const dv = new DataView(blob.buffer);
    if (new TextDecoder().decode(blob.subarray(0, 8)) !== 'SFCDFR01') throw new ErreurPatch('Fichier de patch invalide.');
    let o = 8;
    const verifs = [];
    let n = dv.getUint32(o); o += 4;
    for (let i = 0; i < n; i++) {
      verifs.push({ lba: dv.getUint32(o), sz: dv.getUint32(o + 4), us: blob.subarray(o + 8, o + 28), fr: blob.subarray(o + 28, o + 48) });
      o += 48;
    }
    n = dv.getUint32(o); o += 4;
    const recs = [];
    for (let i = 0; i < n; i++) {
      const off = dv.getUint32(o), ln = dv.getUint32(o + 4); o += 8;
      recs.push({ off, data: blob.subarray(o, o + ln) }); o += ln;
    }

    const tete = new Uint8Array(await bin.slice(0, 16).arrayBuffer());
    const brut = tete[0] === 0 && tete.subarray(1, 11).every(x => x === 0xFF) && tete[11] === 0;
    const T = brut ? 2352 : 2048, B = brut ? 16 : 0;
    log(`Image : ${bin.name} (${brut ? 'BIN 2352' : 'ISO 2048'})`);

    // lecture des données utiles (2048 octets/secteur) dans une image ou un Blob
    async function lireISO(source, off, len) {
      const l0 = Math.floor(off / 2048), l1 = Math.floor((off + len - 1) / 2048);
      const raw = new Uint8Array(await source.slice(l0 * T, (l1 + 1) * T).arrayBuffer());
      const out = new Uint8Array(len);
      let w = 0;
      for (let l = l0; l <= l1; l++) {
        const r = l === l0 ? off % 2048 : 0;
        const k = Math.min(len - w, 2048 - r);
        out.set(raw.subarray((l - l0) * T + B + r, (l - l0) * T + B + r + k), w);
        w += k;
      }
      return out;
    }

    log("Vérification de l'image…");
    let deja = 0;
    for (const v of verifs) {
      const h = await sha1(await lireISO(bin, v.lba * 2048, v.sz));
      if (egal(h, v.fr)) deja++;
      else if (!egal(h, v.us)) throw new ErreurPatch(`Cette image ne correspond pas à Shining Force CD (USA) d'origine (fichier au secteur ${v.lba} différent).`);
    }
    if (deja === verifs.length) throw new ErreurPatch('Cette image est déjà patchée avec cette version.');
    if (deja) throw new ErreurPatch("Image déjà patchée (autre version) : repars de l'image US d'origine.");
    progres(10);

    // secteurs touchés
    const lbas = new Set();
    for (const r of recs) {
      for (let l = Math.floor(r.off / 2048); l <= Math.floor((r.off + r.data.length - 1) / 2048); l++) lbas.add(l);
    }
    const liste = [...lbas].sort((a, b) => a - b);
    const secteurs = new Map();
    log(`Lecture de ${liste.length} secteurs…`);
    for (let i = 0; i < liste.length;) {
      let j = i;
      while (j + 1 < liste.length && liste[j + 1] === liste[j] + 1 && j - i < 255) j++;
      const raw = new Uint8Array(await bin.slice(liste[i] * T, (liste[j] + 1) * T).arrayBuffer());
      for (let k = i; k <= j; k++) secteurs.set(liste[k], raw.slice((k - i) * T, (k - i + 1) * T));
      i = j + 1;
    }
    progres(40);
    log('Application du patch…');
    for (const r of recs) {
      let i = 0;
      while (i < r.data.length) {
        const pos = r.off + i, l = Math.floor(pos / 2048), rr = pos % 2048;
        const k = Math.min(r.data.length - i, 2048 - rr);
        secteurs.get(l).set(r.data.subarray(i, i + k), B + rr);
        i += k;
      }
    }
    if (brut) {
      let c = 0;
      for (const s of secteurs.values()) {
        fixer(s);
        if (++c % 400 === 0) { progres(40 + 40 * c / secteurs.size); await new Promise(r => setTimeout(r)); }
      }
    }
    // image de sortie = morceaux de l'image d'origine + secteurs modifiés (aucune copie complète en mémoire)
    const parts = [];
    let prev = 0;
    for (const l of liste) {
      if (l * T > prev) parts.push(bin.slice(prev, l * T));
      parts.push(secteurs.get(l));
      prev = (l + 1) * T;
    }
    if (prev < bin.size) parts.push(bin.slice(prev));
    const sortie = new Blob(parts, { type: 'application/octet-stream' });
    progres(85);
    log('Vérification du résultat…');
    for (const v of verifs) {
      if (!egal(await sha1(await lireISO(sortie, v.lba * 2048, v.sz)), v.fr))
        throw new ErreurPatch(`La vérification après le patch a échoué (secteur ${v.lba}).`);
    }
    const nomBin = brut ? nomSortie : nomSortie.replace(/\.bin$/i, '.iso');
    const res = [{ blob: sortie, nom: nomBin }];
    if (cue && brut) {
      const txt = await cue.text();
      const lignes = txt.split(/\r?\n/).map(l => (/^\s*FILE\s/i.test(l) && l.includes(bin.name)) ? l.replace(bin.name, nomBin) : l);
      res.push({ blob: new Blob([lignes.join('\r\n')], { type: 'text/plain' }), nom: nomBin.replace(/\.bin$/i, '.cue') });
      log('Fichier .cue créé.');
    } else if (brut) {
      log(`Pense à copier ton .cue et à remplacer le nom du .bin par « ${nomBin} ».`);
    }
    progres(100);
    log('Patch appliqué et vérifié.');
    return res;
  }

  return { crc32, appliquerBPS, patcherCartouche, patcherSFCD, ErreurPatch };
})();
