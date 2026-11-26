'use strict';

const $ = (s, el = document) => el.querySelector(s);
const el = (tag, attrs = {}, ...enfants) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = typo(v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of enfants.flat()) if (c != null) e.append(c);
  return e;
};
const typo = s => String(s ?? '').replace(/« /g, '«\u00a0').replace(/ ([»:;?!])/g, '\u00a0$1');
const slug = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-');
const ko = n => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} Ko` : `${(n / 1048576).toFixed(1).replace('.', ',')} Mo`;

let DONNEES = null;
// préfixe des chemins : '' à l'accueil, '../../' sur la page d'un jeu (jeu/<id>/)
const BASE = document.documentElement.dataset.base || '';
const ACCUEIL = BASE || './';

/* ---------- Statistiques (GoatCounter : gratuit, sans cookies) ---------- */
const Stats = (() => {
  let code = null, pret = false;
  const attente = [], cache = new Map();
  function init(c) {
    if (!c || !/^[a-z0-9-]+$/i.test(c)) return;
    code = c.toLowerCase();
    window.goatcounter = { no_onload: true };
    const s = el('script', { async: true, src: 'https://gc.zgo.at/count.js', 'data-goatcounter': `https://${code}.goatcounter.com/count` });
    s.onload = () => { pret = true; attente.splice(0).forEach(a => compter(a)); };
    document.head.append(s);
  }
  function compter(a) {
    if (!code) return;
    if (!pret || !window.goatcounter.count) { attente.push(a); return; }
    try { window.goatcounter.count(a); } catch (e) { /* bloqueur de publicité : on ignore */ }
  }
  async function lire(chemin) {
    if (!code) return null;
    if (!cache.has(chemin)) {
      cache.set(chemin, fetch(`https://${code}.goatcounter.com/counter/${encodeURIComponent(chemin)}.json`)
        .then(r => r.status === 404 ? { count: '0' } : r.json())
        .then(j => parseInt(String(j.count).replace(/[^\d]/g, ''), 10) || 0)
        .catch(() => null));
    }
    return cache.get(chemin);
  }
  return {
    init,
    actif: () => !!code,
    vue: (path, title) => compter({ path, title }),
    evenement: (chemin, titre) => {
      compter({ path: chemin, title: titre, event: true });
      const c = cache.get(chemin);
      if (c) cache.set(chemin, c.then(n => (n || 0) + 1));
    },
    lire,
  };
})();
const estJeu = p => p.patch && p.patch.format === 'jeu';
const cheminCompteur = p => (estJeu(p) ? 'telechargement-' : 'patch-') + p.id;
const nbFois = (n, jeu) => `${jeu ? 'Téléchargé' : 'Patché'} ${n.toLocaleString('fr-FR')} fois`;
async function remplirCompteur(span, p) {
  const n = await Stats.lire(cheminCompteur(p));
  if (n == null) { span.remove(); return; }
  span.textContent = nbFois(n, estJeu(p));
  span.hidden = false;
}

async function charger() {
  try {
    // « no-store » : on récupère toujours la dernière version publiée des patchs
    const r = await fetch(BASE + 'data/projets.json', { cache: 'no-store' });
    DONNEES = await r.json();
    for (const p of DONNEES.projets) {
      (p.images || []).forEach(im => { im.src = BASE + im.src; });
      if (p.patch && p.patch.fichier && !/^https?:/.test(p.patch.fichier)) p.patch.fichier = BASE + p.patch.fichier;
      if (p.patch && Array.isArray(p.patch.variantes)) p.patch.variantes.forEach(v => { v.fichier = BASE + v.fichier; });
    }
  } catch (e) {
    $('#liste-vide').hidden = false;
    $('#liste-vide').textContent = "Impossible de charger la liste des projets. Recharge la page dans un instant.";
    return;
  }
  Stats.init(DONNEES.compteur);
  if (lienDiscord()) $('#zone-don').append(boutonDiscord('Rejoindre le Discord'), ' ');
  if (lienDon()) $('#zone-don').append(boutonDon('Faire un don à Player Time'));
  // boutons qui suivent l'écran en bas à droite : Discord au-dessus, don en dessous
  const flottants = el('div', { class: 'boutons-flottants' });
  if (lienDiscord()) flottants.append(boutonDiscord('Discord'));
  if (lienDon()) flottants.append(boutonDon('Faire un don'));
  if (flottants.children.length) document.body.append(flottants);
  dessinerListe();
  router();
  if (Stats.actif()) {
    Stats.lire('TOTAL').then(n => {
      if (n == null) return;
      const v = $('#visites');
      v.textContent = n === 1 ? '1 visite sur le site.' : `${n.toLocaleString('fr-FR')} visites sur le site.`;
      v.hidden = false;
    });
  }
}

function etiquettes(p) {
  return el('div', { class: 'etiquettes' },
    el('span', { class: 'etiquette', text: p.plateforme }),
    el('span', { class: 'etiquette statut-' + slug(p.statut || ''), text: p.statut }),
    p.credit ? el('span', { class: 'etiquette etiquette-credit', text: p.credit }) : null,
    p.version ? el('span', { class: 'etiquette etiquette-version', text: 'Version ' + p.version }) : null,
    p.date_maj ? el('span', { class: 'etiquette', text: 'Mis à jour le ' + p.date_maj }) : null,
    compteur(p),
    barre(p));
}
/* barre d'avancement (avancement.json → « avancement » de 0 à 100) */
function barre(p) {
  if (typeof p.avancement !== 'number') return null;
  const a = Math.max(0, Math.min(100, Math.round(p.avancement)));
  const t = el('span', { class: 'avancement-texte', text: 'Avancement ' });
  t.append(el('b', { text: a + ' %' }));
  return el('div', { class: 'avancement', role: 'progressbar', 'aria-label': 'Avancement du projet',
                     'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(a) },
    t,
    el('span', { class: 'avancement-piste' }, el('span', { class: 'avancement-plein', style: 'width:' + a + '%' })));
}
function compteur(p) {
  if (!Stats.actif() || !p.patch || p.patch.format === 'lien') return null;
  const span = el('span', { class: 'etiquette etiquette-compteur', 'data-id': p.id, hidden: true });
  remplirCompteur(span, p);
  return span;
}

function vignette(p) {
  const img = p.images && p.images[0];
  return el('div', { class: 'vignette' },
    img ? el('img', { src: img.src, alt: '', loading: 'lazy', width: 512, height: 448 })
        : el('div', { class: 'vignette-vide', style: `--teinte:${p.couleur || ''}`, text: p.titre }));
}

function carte(p) {
  return el('li', { 'data-plateforme': p.plateforme || '', 'data-lettre': lettreDe(p.titre), 'data-id': p.id, 'data-fini': estFini(p) ? '1' : '' },
    el('a', { class: 'fenetre carte-jeu', href: BASE + 'jeu/' + p.id + '/' },
      vignette(p),
      el('div', { class: 'carte-corps' },
        el('h3', { text: p.titre }),
        p.sous_titre ? el('p', { class: 'sous', text: p.sous_titre }) : null,
        el('p', { class: 'resume', text: p.resume || '' }),
        etiquettes(p))));
}

function dessinerListe() {
  const zone = $('#listes');
  zone.replaceChildren();
  // un groupe par catégorie (« categorie » dans fiche.json), dans l'ordre d'apparition
  const groupes = new Map();
  for (const p of DONNEES.projets) {
    const c = p.categorie || 'Traductions et améliorations';
    if (!groupes.has(c)) groupes.set(c, []);
    groupes.get(c).push(p);
  }
  let i = 0;
  for (const [nom, liste] of groupes) {
    const id = 'groupe-' + (i++);
    const ul = el('ul', { class: 'grille' }, liste.map(carte));
    ul.querySelectorAll('li[data-plateforme]').forEach(li => { li._maison = ul; });
    zone.append(el('section', { 'aria-labelledby': id, class: 'groupe-categorie' },
      el('h2', { id, class: 'titre-section', text: nom }), ul));
  }
  // vue « récents » : une seule liste, du plus récemment ajouté ou mis à jour au plus ancien
  zone.append(el('section', { 'aria-labelledby': 'groupe-recents', class: 'groupe-recents', hidden: '' },
    el('h2', { id: 'groupe-recents', class: 'titre-section', text: 'Derniers ajouts et mises à jour' }),
    el('ul', { class: 'grille', id: 'liste-recents' })));
  $('#liste-vide').hidden = DONNEES.projets.length > 0;
  $('#liste-vide').textContent = 'Aucun projet pour le moment.';
  ongletsConsoles(zone);
}

/* ---------- Choix par console (grandes vignettes) + choix par lettre ---------- */
const ICONES = {
  // dessins pixel originaux : cartouche 16 bits, cartouche 8 bits, CD (remplaçables par console-<nom>.png)
  'Mega Drive': '<svg viewBox="0 0 32 32" shape-rendering="crispEdges"><path fill="#1b1b22" d="M6 4h20v2h2v20h-2v2H6v-2H4V6h2z"/><path fill="#2e2e3a" d="M8 6h16v12H8z"/><path fill="#e8c46a" d="M9 8h14v8H9z"/><path fill="#c0392b" d="M10 9h12v2H10z"/><path fill="#1d2f8f" d="M10 12h12v3H10z"/><path fill="#555566" d="M8 22h2v4H8zM12 22h2v4h-2zM16 22h2v4h-2zM20 22h2v4h-2z"/></svg>',
  'Master System': '<svg viewBox="0 0 32 32" shape-rendering="crispEdges"><path fill="#1b1b22" d="M8 3h16v26H8z"/><path fill="#f2f2f2" d="M10 5h12v15H10z"/><path fill="#d0312d" d="M10 5h12v3H10z"/><path fill="#3a7bd5" d="M11 10h10v7H11z"/><path fill="#f2c94c" d="M13 12h6v3h-6z"/><path fill="#555566" d="M10 24h2v3h-2zM14 24h2v3h-2zM18 24h2v3h-2z"/></svg>',
  'Mega CD': '<svg viewBox="0 0 32 32" shape-rendering="crispEdges"><path fill="#c9d3e6" d="M12 3h8v2h4v2h2v4h2v10h-2v4h-2v2h-4v2h-8v-2H8v-2H6v-4H4V11h2V7h2V5h4z"/><path fill="#9fb3d9" d="M12 5h8v2h4v4h2v4H6v-4h2V7h4z"/><path fill="#e8c46a" d="M8 17h16v2H8z"/><path fill="#7a4fc0" d="M8 19h16v2H8z"/><path fill="#1b1b22" d="M14 14h4v4h-4z"/><path fill="#f4f2ea" d="M15 15h2v2h-2z"/></svg>',
  'Game Gear': '<svg viewBox="0 0 32 32" shape-rendering="crispEdges"><path fill="#1b1b22" d="M3 9h26v14H3z"/><path fill="#7fbf7f" d="M11 11h10v10H11z"/><path fill="#d0312d" d="M24 14h2v2h-2zM26 16h2v2h-2z"/><path fill="#888" d="M5 14h4v2H5zM6 13h2v4H6z"/></svg>',
  'Windows': '<svg viewBox="0 0 32 32" shape-rendering="crispEdges"><path fill="#1b1b22" d="M3 5h26v18H3z"/><path fill="#1d2f8f" d="M5 7h22v14H5z"/><path fill="#e8c46a" d="M8 10h7v5H8z"/><path fill="#c0392b" d="M17 10h7v5h-7z"/><path fill="#f4f2ea" d="M8 17h16v2H8z"/><path fill="#555566" d="M13 23h6v3h-6zM9 26h14v2H9z"/></svg>',
  'Toutes': '<svg viewBox="0 0 32 32" shape-rendering="crispEdges"><path fill="#e8c46a" d="M4 4h10v10H4zM18 4h10v10H18zM4 18h10v10H4zM18 18h10v10H18z"/><path fill="#1d2f8f" d="M6 6h6v6H6zM20 6h6v6h-6zM6 20h6v6H6zM20 20h6v6h-6z"/></svg>',
};
/* date de dernier ajout ou de dernière mise à jour d'un jeu, pour le tri « Récents » (jj/mm/aaaa -> aaaammjj) */
const cleDate = d => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d || ''); return m ? m[3] + m[2] + m[1] : ''; };
const estFini = p => typeof p.avancement === 'number' && p.avancement >= 100;
const dateRecente = p => [cleDate(p.date_maj), cleDate(p.date_version)].sort().pop() || '';
const sansAccent = t => (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const lettreDe = titre => {
  const c = sansAccent(titre).trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
};
function iconeConsole(nom) {
  const fichier = (DONNEES.images_consoles || {})[nom];
  if (fichier) return el('img', { src: BASE + fichier, alt: '', class: 'icone-image' });
  const span = el('span', { class: 'icone-svg', 'aria-hidden': 'true' });
  span.innerHTML = ICONES[nom] || ICONES['Toutes'];
  return span;
}

function ongletsConsoles(zone) {
  const consoles = [...new Set(DONNEES.projets.map(p => p.plateforme).filter(Boolean))];
  let choix = { console: 'Toutes', lettre: 'Tout', tri: 'categorie', fini: false };
  try { choix = Object.assign(choix, JSON.parse(sessionStorage.getItem('filtre') || '{}')); } catch (e) { /* rien */ }
  if (choix.console !== 'Toutes' && !consoles.includes(choix.console)) choix.console = 'Toutes';

  const tuiles = el('div', { class: 'consoles', role: 'group', 'aria-label': 'Choisir une console' });
  const lettres = el('div', { class: 'alphabet', role: 'group', 'aria-label': 'Choisir une lettre' });
  const resultat = el('p', { class: 'resultat', 'aria-live': 'polite' });
  const tri = el('div', { class: 'tri', role: 'group', 'aria-label': 'Trier les jeux' },
    el('span', { class: 'tri-titre', text: 'Trier :' }),
    el('button', { type: 'button', class: 'touche-tri', 'data-tri': 'categorie', onclick: () => { choix.tri = 'categorie'; appliquer(); } }, 'Par catégorie'),
    el('button', { type: 'button', class: 'touche-tri', 'data-tri': 'recents', onclick: () => { choix.tri = 'recents'; appliquer(); } }, 'Ajouts et mises à jour récents'));
  // filtre « terminés » : seulement les jeux dont la barre d'avancement est à 100 %
  const nbFinis = DONNEES.projets.filter(estFini).length;
  const toucheFini = nbFinis ? el('button', { type: 'button', class: 'touche-tri touche-fini',
    onclick: () => { choix.fini = !choix.fini; appliquer(); } }, `✔ Terminés à 100 % (${nbFinis})`) : null;
  if (toucheFini) tri.append(el('span', { class: 'tri-separateur', 'aria-hidden': 'true' }), toucheFini);
  const ranger = () => {
    // les cartes sont déplacées (pas recopiées) entre les listes par catégorie et la liste « récents »
    const toutes = [...zone.querySelectorAll('li[data-plateforme]')];
    const recents = zone.querySelector('#liste-recents');
    if (choix.tri === 'recents') {
      const date = li => dateRecente(DONNEES.projets.find(p => p.id === li.dataset.id) || {});
      toutes.sort((a, b) => date(b).localeCompare(date(a)) || a.textContent.localeCompare(b.textContent, 'fr'));
      toutes.forEach(li => recents.append(li));
    } else {
      toutes.forEach(li => li._maison && li._maison.append(li));
      zone.querySelectorAll('.groupe-categorie ul').forEach(ul => {
        [...ul.children].sort((a, b) => (+a.dataset.rang) - (+b.dataset.rang)).forEach(li => ul.append(li));
      });
    }
    zone.querySelector('.groupe-recents').dataset.actif = choix.tri === 'recents' ? '1' : '';
    zone.querySelectorAll('.groupe-categorie').forEach(sec => { sec.dataset.actif = choix.tri === 'recents' ? '' : '1'; });
    tri.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.tri === choix.tri ? 'true' : 'false'));
  };

  const appliquer = () => {
    try { sessionStorage.setItem('filtre', JSON.stringify(choix)); } catch (e) { /* rien */ }
    ranger();
    tuiles.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.console === choix.console ? 'true' : 'false'));
    if (choix.fini && !nbFinis) choix.fini = false;
    if (toucheFini) toucheFini.setAttribute('aria-pressed', choix.fini ? 'true' : 'false');
    const dansConsole = p => (choix.console === 'Toutes' || p.plateforme === choix.console) && (!choix.fini || estFini(p));
    // lettres disponibles pour la console choisie
    const dispo = new Set(DONNEES.projets.filter(dansConsole).map(p => lettreDe(p.titre)));
    if (choix.lettre !== 'Tout' && !dispo.has(choix.lettre)) choix.lettre = 'Tout';
    lettres.querySelectorAll('button').forEach(b => {
      const l = b.dataset.lettre;
      b.disabled = l !== 'Tout' && !dispo.has(l);
      b.setAttribute('aria-pressed', l === choix.lettre ? 'true' : 'false');
    });
    let n = 0;
    zone.querySelectorAll('li[data-plateforme]').forEach(li => {
      const ok = (choix.console === 'Toutes' || li.dataset.plateforme === choix.console) &&
                 (choix.lettre === 'Tout' || li.dataset.lettre === choix.lettre) &&
                 (!choix.fini || li.dataset.fini === '1');
      li.hidden = !ok; if (ok) n++;
    });
    zone.querySelectorAll('section').forEach(sec => { sec.hidden = !sec.dataset.actif || !sec.querySelector('li[data-plateforme]:not([hidden])'); });
    const quoi = choix.console === 'Toutes' ? 'toutes consoles' : choix.console;
    resultat.textContent = `${n} jeu${n > 1 ? 'x' : ''}${choix.fini ? ' terminé' + (n > 1 ? 's' : '') + ' à 100 %' : ''} (${quoi}${choix.lettre !== 'Tout' ? ', lettre ' + choix.lettre : ''})`;
  };

  for (const c of ['Toutes', ...consoles]) {
    const nb = c === 'Toutes' ? DONNEES.projets.length : DONNEES.projets.filter(p => p.plateforme === c).length;
    tuiles.append(el('button', { type: 'button', class: 'tuile-console', 'data-console': c,
      onclick: () => { choix.console = c; choix.lettre = 'Tout'; appliquer(); } },
      iconeConsole(c),
      el('span', { class: 'nom-console', text: c === 'Toutes' ? 'Toutes les consoles' : c }),
      el('span', { class: 'nombre', text: c === 'Windows' ? `${nb} logiciel${nb > 1 ? 's' : ''}` : `${nb} jeu${nb > 1 ? 'x' : ''}` })));
  }
  for (const l of ['Tout', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#']) {
    lettres.append(el('button', { type: 'button', class: 'touche-lettre', 'data-lettre': l,
      'aria-label': l === 'Tout' ? 'Toutes les lettres' : l === '#' ? 'Chiffres et symboles' : 'Lettre ' + l,
      onclick: () => { choix.lettre = l; appliquer(); } }, l === 'Tout' ? 'Tout' : l));
  }
  // rang d'origine de chaque carte, pour revenir à l'ordre « par catégorie »
  zone.querySelectorAll('li[data-plateforme]').forEach((li, k) => { li.dataset.rang = k; });
  zone.prepend(el('div', { class: 'filtres' }, tuiles, lettres, tri, resultat));
  appliquer();
}

function router() {
  if (!DONNEES) return;
  // anciens liens « #/jeu/<id> » : redirigés vers la vraie page du jeu
  const ancien = location.hash.match(/^#\/jeu\/([\w-]+)/);
  if (ancien) { location.replace(BASE + 'jeu/' + ancien[1] + '/'); return; }
  const m = location.pathname.match(/\/jeu\/([\w-]+)\/?(index\.html)?$/);
  const p = m && DONNEES.projets.find(x => x.id === m[1]);
  $('#vue-liste').hidden = !!p;
  $('#vue-jeu').hidden = !p;
  Stats.vue(p ? '/jeu/' + p.id : '/', p ? p.titre : 'Accueil');
  if (p) {
    dessinerJeu(p);
    document.title = titrePage(p);
  } else {
    document.title = DONNEES.titre_page || document.title;
  }
}

function titrePage(p) {
  const st = p.sous_titre || '';
  const nom = p.titre + (st && st.length < 40 && !/traduction/i.test(st) ? ' – ' + st : '');
  if (p.titre_page) return p.titre_page;
  return p.patch && p.patch.format === 'jeu'
    ? `${p.titre} : jeu ${p.plateforme} gratuit | Player Time`
    : `${nom} : patch de traduction française (${p.plateforme}) | Player Time`;
}

function galerie(p) {
  const imgs = p.images || [];
  if (!imgs.length) {
    return el('div', { class: 'fenetre galerie-vide' },
      el('p', { text: 'Les captures de ce projet arrivent bientôt.' }));
  }
  const grandeImg = el('img', { src: imgs[0].src, alt: imgs[0].legende || p.titre, width: 512, height: 448 });
  const legende = el('p', { class: 'legende', text: imgs[0].legende || '' });
  let courant = 0;
  const grande = el('button', { type: 'button', class: 'grande', 'aria-label': 'Afficher en grand', onclick: () => ouvrir(imgs[courant]) }, grandeImg);
  const minis = el('ul', { class: 'miniatures' });
  imgs.forEach((im, i) => {
    minis.append(el('li', {}, el('button', {
      type: 'button', 'aria-current': i === 0 ? 'true' : 'false', 'aria-label': im.legende || `Capture ${i + 1}`,
      onclick: e => {
        courant = i;
        grandeImg.src = im.src; grandeImg.alt = im.legende || p.titre; legende.textContent = im.legende || '';
        minis.querySelectorAll('button').forEach(b => b.setAttribute('aria-current', 'false'));
        e.currentTarget.setAttribute('aria-current', 'true');
      }
    }, el('img', { src: im.src, alt: '', loading: 'lazy' }))));
  });
  return el('div', { class: 'galerie' }, grande, legende, imgs.length > 1 ? minis : null);
}

function ouvrir(im) {
  const d = $('#visionneuse');
  $('img', d).src = im.src; $('img', d).alt = im.legende || '';
  $('.legende-grande', d).textContent = im.legende || '';
  d.showModal();
}

function notes(p) {
  const bloc = el('section', { class: 'fenetre notes', 'aria-labelledby': 'titre-notes' },
    el('h2', { id: 'titre-notes', text: p.titre_notes || (estJeu(p) ? 'À propos du jeu' : 'Modifications apportées') }));
  for (const partie of p.notes || []) {
    if (partie.titre) bloc.append(el('h3', { text: partie.titre }));
    let ul = null;
    for (const b of partie.blocs) {
      if (b.puce != null) {
        if (!ul) { ul = el('ul'); bloc.append(ul); }
        ul.append(el('li', { text: b.puce }));
      } else {
        ul = null;
        bloc.append(el('p', { text: b.texte }));
      }
    }
  }
  return bloc;
}

function panneau(p) {
  const info = p.patch;
  const box = el('section', { class: 'fenetre panneau', 'aria-labelledby': 'titre-patch' },
    el('h2', { id: 'titre-patch', text: 'Patcher la ROM' }));
  if (!info) {
    box.append(el('p', { text: 'Le patch de ce projet sera bientôt disponible ici.' }),
      el('p', { class: 'attendue', text: `ROM à prévoir : ${p.rom_attendue}.` }));
    return box;
  }
  if (info.format === 'jeu') return panneauJeu(p, box);
  if (info.format === 'lien') return panneauLien(p, box);
  const cd = info.format === 'sfcd';
  // Mega CD : un patch par console (le jeu traduit est le même, seul le démarrage change)
  const variantes = cd && Array.isArray(info.variantes) && info.variantes.length > 1 ? info.variantes : null;
  let variante = variantes ? variantes[0] : null;
  const blocCD = cd ? blocBpsCD(p, info) : null;
  const choixConsole = variantes ? el('fieldset', { class: 'choix-console' },
    el('legend', { text: '1. Ta console' }),
    ...variantes.map((v, k) => el('label', {},
      el('input', { type: 'radio', name: 'console-' + p.id, value: String(k), checked: k === 0 ? '' : null,
        onchange: () => { variante = variantes[k]; if (blocCD) blocCD.choisir(k); } }),
      ' ' + v.console))) : null;
  const journal = el('ul', { class: 'journal', 'aria-live': 'polite' });
  const barre = el('div', { class: 'barre', hidden: true }, el('div'));
  const sorties = el('div', { class: 'telechargements' });
  const input = el('input', { type: 'file', multiple: cd, accept: cd ? '.bin,.iso,.img,.cue' : '.bin,.md,.gen,.smd,.sms,.gg,.32x,.sg,.zip' });
  const depot = el('label', { class: 'depot' },
    input,
    el('strong', { text: cd ? (variantes ? '2. Choisir l’image du jeu (.bin et .cue)' : 'Choisir l’image du jeu (.bin et .cue)') : 'Choisir la ROM officielle' }),
    el('span', { text: 'ou la glisser ici' }));

  const log = (t, cls) => journal.append(el('li', { class: cls || '', text: t }));
  const progres = v => { barre.hidden = false; barre.firstChild.style.width = v + '%'; };

  async function traiter(fichiers) {
    if (!fichiers.length) return;
    journal.replaceChildren(); sorties.replaceChildren(); barre.hidden = true;
    try {
      log('Téléchargement du patch…');
      const r = await fetch((variante ? variante.fichier : info.fichier) + '?r=' + p.revision, { cache: 'no-store' });
      if (variante) log('Patch pour : ' + variante.console);
      if (!r.ok) throw new Patcheur.ErreurPatch('Le patch est introuvable sur le site. Réessaie plus tard.');
      const patch = new Uint8Array(await r.arrayBuffer());
      let res;
      if (cd) {
        res = await Patcheur.patcherSFCD([...fichiers], patch, p.nom_sortie, log, progres);
      } else {
        res = await Patcheur.patcherCartouche(fichiers[0], patch, info, log);
        res[0].nom = p.nom_sortie;
      }
      log('Ta ROM française est prête.', 'ok');
      Stats.evenement(cheminCompteur(p), 'Patch : ' + p.titre);
      document.querySelectorAll(`.etiquette-compteur[data-id="${p.id}"]`).forEach(sp => remplirCompteur(sp, p));
      for (const f of res) {
        const url = URL.createObjectURL(f.blob);
        sorties.append(el('a', { class: 'bouton', href: url, download: f.nom, text: 'Télécharger ' + f.nom }));
      }
      sorties.querySelector('a').click();
      const merci = encartDon('Merci ! Si la traduction te plaît, tu peux soutenir mon travail.');
      if (merci) { sorties.append(merci); box.querySelectorAll('.encart-don-fixe').forEach(x => x.remove()); }
    } catch (e) {
      console.error(e);
      log(e instanceof Patcheur.ErreurPatch ? e.message : 'Erreur inattendue : ' + e.message, 'erreur');
    }
  }

  input.addEventListener('change', () => traiter(input.files));
  depot.addEventListener('dragover', e => { e.preventDefault(); depot.classList.add('survol'); });
  depot.addEventListener('dragleave', () => depot.classList.remove('survol'));
  depot.addEventListener('drop', e => { e.preventDefault(); depot.classList.remove('survol'); traiter(e.dataTransfer.files); });

  box.append(
    el('p', { text: cd
      ? 'Sélectionne ton image de Shining Force CD (USA). Le patch vérifie le jeu puis crée la version française, que tu télécharges.'
        + (variantes ? ' Choisis d’abord la console sur laquelle tu vas jouer : le jeu traduit est le même, seul le démarrage du disque change.' : '')
      : 'Sélectionne ta ROM officielle. Le patch la vérifie puis crée la version française, que tu télécharges.' }),
    el('p', { class: 'attendue', text: `ROM attendue : ${p.rom_attendue}` + (info.crc_source ? ` (CRC32 ${info.crc_source}).` : '.') }),
    choixConsole, depot, barre, journal, sorties,
    // Mega Drive : on peut aussi jouer tout de suite en français dans l'émulateur en ligne
    (!cd && info.format === 'bps' && /mega ?drive|genesis/i.test(p.plateforme || ''))
      ? el('div', { class: 'telechargements' }, el('a', { class: 'bouton', href: BASE + 'emulateur/?patch=' + encodeURIComponent(p.id),
          text: '▶ Jouer en français dans l’émulateur (téléphone ou PC)',
          onclick: () => Stats.evenement(cheminCompteur(p) + '-emulateur', 'Partie en ligne : ' + p.titre) }))
      : null,
    (() => { const e = encartDon('Ce patch est gratuit. Si tu veux soutenir mon travail, tu peux faire un don.'); if (e) e.classList.add('encart-don-fixe'); return e; })(),
    el('p', { class: 'meta-patch', text:
      `Patch ${p.date_maj ? 'du ' + p.date_maj : ''}${p.revision ? ', révision ' + p.revision : ''}, ${ko(info.taille_patch)}. ` +
      'Le patch se fait dans ton navigateur : ta ROM ne quitte pas ton ordinateur.' }),
    cd ? blocCD : blocBps(p, info));
  return box;
}

/* ---------- Téléchargement du patch .bps, pour patcher soi-même ---------- */
function blocBps(p, info) {
  if (info.format !== 'bps') return null;
  const nom = (p.nom_sortie || p.id).replace(/\.[^.]+$/, '') + '.bps';
  return el('div', { class: 'bloc-bps' },
    el('h3', { text: 'Ou télécharger le patch' }),
    el('p', { text: 'Pour patcher toi-même avec Floating IPS (Flips), Beat, ou directement dans RetroArch, '
      + 'MiSTer ou une cartouche flash qui accepte les patchs. Format BPS : il vérifie que ta ROM est la bonne.' }),
    el('p', { class: 'attendue', text: `À appliquer sur : ${p.rom_attendue}` + (info.crc_source ? ` (CRC32 ${info.crc_source})` : '') + '.' }),
    el('a', { class: 'bouton bouton-secondaire', href: info.fichier + '?r=' + p.revision, download: nom,
      text: `Télécharger ${nom} (${ko(info.taille_patch)})`,
      onclick: () => {
        // compté avec les patchs faits en ligne : le compteur de la page reste le total des téléchargements
        Stats.evenement(cheminCompteur(p), 'Patch BPS : ' + p.titre);
        setTimeout(() => document.querySelectorAll(`.etiquette-compteur[data-id="${p.id}"]`).forEach(sp => remplirCompteur(sp, p)), 300);
      } }));
}

/* ---------- Mega CD : .bps à télécharger, pour la console choisie ---------- */
function blocBpsCD(p, info) {
  const liste = Array.isArray(info.bps_megacd) ? info.bps_megacd.filter(b => b.bps_piste || b.bps_image) : [];
  if (!liste.length) return null;
  const base = (p.nom_sortie || p.id).replace(/\.[^.]+$/, '');
  const zone = el('div');
  const bloc = el('div', { class: 'bloc-bps' },
    el('h3', { text: 'Ou télécharger le patch' }),
    el('p', { text: 'Pour patcher toi-même avec Floating IPS (Flips) ou Beat : ouvre le patch, puis choisis le fichier .bin '
      + 'de ton image Shining Force CD (USA) redump. Le format BPS vérifie que ton image est la bonne.' }),
    zone,
    el('p', { class: 'meta-patch', text: 'Garde ensuite ton .cue : renomme le .bin patché comme dans le .cue, '
      + 'ou change le nom du fichier dans la ligne FILE du .cue. Les pistes audio ne changent pas.' }));
  const lien = (fichier, nom, taille) => el('a', { class: 'bouton bouton-secondaire', href: BASE + fichier + '?r=' + p.revision, download: nom,
    text: `${nom} (${ko(taille)})`,
    onclick: () => {
      Stats.evenement(cheminCompteur(p), 'Patch BPS : ' + p.titre);
      setTimeout(() => document.querySelectorAll(`.etiquette-compteur[data-id="${p.id}"]`).forEach(sp => remplirCompteur(sp, p)), 300);
    } });
  bloc.choisir = k => {
    const b = liste[Math.min(k, liste.length - 1)];
    const suffixe = liste.length > 1 && b.console ? ` [${b.console}]` : '';
    zone.replaceChildren(
      b.console && liste.length > 1 ? el('p', { class: 'attendue', text: 'Console choisie : ' + b.console }) : null,
      b.bps_image ? el('div', { class: 'ligne-bps' },
        el('p', { text: 'Ton image est un seul fichier .bin (toutes les pistes) :' }),
        lien(b.bps_image, `${base}${suffixe} (image complete).bps`, b.taille_image)) : null,
      b.bps_piste ? el('div', { class: 'ligne-bps' },
        el('p', { text: 'Ton image est en pistes séparées : patch à appliquer sur « (Track 01).bin »'
          + (info.crc_piste01 ? ` (CRC32 ${info.crc_piste01})` : '') + ' :' }),
        lien(b.bps_piste, `${base}${suffixe} (Track 01).bps`, b.taille_piste)) : null);
  };
  bloc.choisir(0);
  return bloc;
}

/* ---------- Discord (lien_discord dans reglages_site.json) ---------- */
const lienDiscord = () => DONNEES && /^https:\/\/(discord\.gg|discord\.com)\//.test(DONNEES.discord || '') ? DONNEES.discord : null;
function boutonDiscord(texte) {
  return el('a', { class: 'bouton bouton-discord', href: lienDiscord(), target: '_blank', rel: 'noopener', text: texte,
    onclick: () => Stats.evenement('discord-clic', 'Clic sur le lien Discord') });
}

/* ---------- Don (lien_don dans config.json : PayPal, Ko-fi, Tipeee...) ---------- */
const lienDon = () => DONNEES && /^https:\/\//.test(DONNEES.don || '') ? DONNEES.don : null;
function boutonDon(texte) {
  return el('a', { class: 'bouton bouton-don', href: lienDon(), target: '_blank', rel: 'noopener', text: '♥ ' + texte,
    onclick: () => Stats.evenement('don-clic', 'Clic sur le lien de don') });
}
function encartDon(phrase) {
  if (!lienDon()) return null;
  return el('div', { class: 'encart-don' }, el('p', { text: phrase }), boutonDon('Faire un don'));
}

// outil en ligne (ex. l'émulateur) : pas de téléchargement, un gros bouton qui l'ouvre
function panneauLien(p, box) {
  const info = p.patch;
  $('h2', box).textContent = p.titre_panneau || 'Ouvrir';
  const lien = el('a', { class: 'bouton bouton-ouvrir', href: BASE + info.lien, text: p.texte_bouton || '▶ Ouvrir',
    onclick: () => Stats.evenement('ouverture-' + p.id, 'Ouverture : ' + p.titre) });
  const points = (p.points_lien || []).length
    ? el('ul', { class: 'points-lien' }, ...p.points_lien.map(t => el('li', { text: t }))) : null;
  box.append(
    p.texte_lien ? el('p', { text: p.texte_lien }) : null,
    el('div', { class: 'telechargements' }, lien),
    points,
    encartDon(p.texte_don || 'C\u2019est gratuit. Si tu veux m\u2019aider à continuer, tu peux faire un don.'),
    el('p', { class: 'meta-patch', text: `Version ${p.version || ''}${p.date_maj ? ' du ' + p.date_maj : ''}.` }));
  return box;
}

function panneauJeu(p, box) {
  const info = p.patch;
  $('h2', box).textContent = p.titre_panneau || 'Télécharger le jeu';
  const lien = el('a', { class: 'bouton', href: info.externe ? info.fichier : info.fichier + '?r=' + p.revision, download: p.nom_sortie,
    text: 'Télécharger ' + p.nom_sortie,
    onclick: () => {
      Stats.evenement(cheminCompteur(p), 'Téléchargement : ' + p.titre);
      setTimeout(() => document.querySelectorAll(`.etiquette-compteur[data-id="${p.id}"]`).forEach(sp => remplirCompteur(sp, p)), 300);
    } });
  // Jeu Mega Drive hébergé sur le site : on peut aussi y jouer tout de suite dans l'émulateur en ligne
  const jouer = (!info.externe && /mega ?drive|genesis/i.test(p.plateforme || 'Mega Drive'))
    ? el('a', { class: 'bouton', href: BASE + 'emulateur/?rom=' + encodeURIComponent('../' + info.fichier + (p.revision ? '?r=' + p.revision : '')) + '&titre=' + encodeURIComponent(p.titre),
        text: '▶ Jouer maintenant (téléphone ou PC)',
        onclick: () => Stats.evenement(cheminCompteur(p) + '-emulateur', 'Partie en ligne : ' + p.titre) })
    : null;
  box.append(
    el('p', { text: p.texte_telechargement || 'Jeu gratuit : télécharge la ROM et lance-la dans un émulateur Mega Drive ou sur une cartouche flash.' }),
    el('div', { class: 'telechargements' }, lien, jouer),
    encartDon(p.texte_don || 'Le jeu est gratuit. Si tu veux m\u2019aider à le continuer, tu peux faire un don.'),
    el('p', { class: 'meta-patch', text:
      `Version ${p.date_maj ? 'du ' + p.date_maj : ''}${p.revision ? ', révision ' + p.revision : ''}, ${ko(info.taille_patch)}.` }));
  return box;
}

function encartDiscord(p) {
  if (!lienDiscord()) return null;
  return el('section', { class: 'fenetre encart-discord' },
    el('h2', { text: 'Une question, un bug ?' }),
    el('p', { text: `Viens en parler sur le Discord de Player Time, en précisant « ${p.titre}${p.version ? ' ' + p.version : ''} ».` }),
    boutonDiscord('Rejoindre le Discord'));
}

function dessinerJeu(p) {
  const v = $('#vue-jeu');
  v.replaceChildren(
    el('a', { class: 'retour', href: ACCUEIL, text: '◂ Tous les projets' }),
    el('div', { class: 'jeu-tete' },
      el('h2', { class: 'jeu-titre', text: p.titre }),
      p.sous_titre ? el('p', { class: 'jeu-sous', text: p.sous_titre }) : null,
      etiquettes(p)),
    el('div', { class: 'jeu-grille' }, galerie(p), panneau(p)),
    notes(p),
    encartDiscord(p));
}

/* titre écrit lettre par lettre, comme une réplique */
function ecrireTitre() {
  const h = $('#titre-site');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const texte = h.textContent;
  h.setAttribute('aria-label', texte);
  const span = el('span', { class: 'ecrit', 'aria-hidden': 'true' });
  const lettres = [...texte].map(c => el('span', { class: 'lettre', text: c }));
  span.append(...lettres);
  h.replaceChildren(span);
  let i = 0;
  const t = setInterval(() => { if (i >= lettres.length) return clearInterval(t); lettres[i++].classList.add('vue'); }, 32);
}

$('#visionneuse').addEventListener('click', e => {
  if (e.target.matches('[data-fermer]') || e.target === e.currentTarget) e.currentTarget.close();
});
window.addEventListener('hashchange', router);
ecrireTitre();
charger();
