/* ============================================================================
   theme-engine.js — Atelier adapter for the SA Path Lab Roster
   ----------------------------------------------------------------------------
   Drop-in. Does not touch the roster's own CSS or JS.

   How it works
   1. Generates a full tonal palette from one seed colour (OKLab maths).
   2. Writes the RESULT into the roster's existing variable names
      (--ink, --paper, --panel, --amber, --teal, ...) as INLINE styles on <html>.
      Inline styles outrank the html[data-theme="dark"] block, so both modes
      are driven from here without editing a single existing rule.
   3. Regenerates the ~40 hardcoded rgba() shift-column tints into a single
      injected stylesheet, so the roster grid follows the theme too.
   4. Swaps the Google Fonts <link> when the typeface pair changes.

   Everything is stored in localStorage, per device, alongside the roster's
   own prefs. Nothing syncs to Firebase — a colour choice is personal.
   ========================================================================== */
(function () {
'use strict';

/* ---------- 1. colour maths (OKLab / OKLCH) ------------------------------ */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const toLin = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const toSrgb = c => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

function hexToRgb(h) {
  h = String(h).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) h = '808080';
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
}
const rgbToHex = rgb => '#' + rgb.map(c =>
  clamp(Math.round(c * 255), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase();

function rgbToOklab([R, G, B]) {
  const r = toLin(R), g = toLin(G), b = toLin(B);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
          1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
function oklabToRgb([L, A, B]) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  return [toSrgb( 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
          toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
          toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)];
}
const inGamut = rgb => rgb.every(c => c >= -0.0008 && c <= 1.0008);
const lchToRgb = (L, C, H) => oklabToRgb([L, C * Math.cos(H * Math.PI / 180), C * Math.sin(H * Math.PI / 180)]);

function lchToHex(L, C, H) {
  L = clamp(L, 0, 1);
  let rgb = lchToRgb(L, C, H);
  if (!inGamut(rgb)) {                       // walk chroma down until sRGB can hold it
    let lo = 0, hi = C;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(lchToRgb(L, mid, H))) lo = mid; else hi = mid;
    }
    rgb = lchToRgb(L, lo, H);
  }
  return rgbToHex(rgb.map(c => clamp(c, 0, 1)));
}
function hexToLch(hex) {
  const [L, a, b] = rgbToOklab(hexToRgb(hex));
  let H = Math.atan2(b, a) * 180 / Math.PI;
  return { L, C: Math.hypot(a, b), H: H < 0 ? H + 360 : H };
}
/* Material tone (= CIE L*) -> OKLab lightness */
const toneToL = t => (t = clamp(t, 0, 100)) > 8 ? (t + 16) / 116 : Math.cbrt(t / 903.2963);
const paletteOf = (hue, chroma) => ({ hue, chroma, t: n => lchToHex(toneToL(n), chroma, hue) });

function lum(hex) { const [r, g, b] = hexToRgb(hex).map(toLin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

/* ---------- 2. themes ---------------------------------------------------- */
const VARIANTS = {
  tonalSpot : { pC: 0.13, sC: 0.05, tC: 0.10, tH:  60, sH:   0, nC: 0.008 },
  vibrant   : { pC: 0.21, sC: 0.10, tC: 0.15, tH:  45, sH: -15, nC: 0.012 },
  expressive: { pC: 0.17, sC: 0.11, tC: 0.14, tH: 135, sH: -40, nC: 0.010 },
  neutral   : { pC: 0.04, sC: 0.02, tC: 0.03, tH:  40, sH:   0, nC: 0.004 },
  fidelity  : { pC: null, sC: null, tC: null, tH:  25, sH: -10, nC: 0.009 },
  monochrome: { pC: 0,    sC: 0,    tC: 0,    tH:   0, sH:   0, nC: 0     }
};

const THEMES = [
  { id:'lab',        name:'Lab Notebook',  seed:'#B8863F', variant:'tonalSpot',  h:'Fraunces',            b:'IBM Plex Sans', m:'IBM Plex Mono' },
  { id:'afriklight', name:'Afriklight',    seed:'#B7642F', variant:'tonalSpot',  h:'Fraunces',            b:'Karla',         m:'IBM Plex Mono' },
  { id:'clinical',   name:'Clinical Teal', seed:'#0E7490', variant:'neutral',    h:'Public Sans',         b:'Public Sans',   m:'IBM Plex Mono' },
  { id:'nightshift', name:'Night Shift',   seed:'#7C6CF0', variant:'expressive', h:'Sora',                b:'DM Sans',       m:'JetBrains Mono' },
  { id:'lake',       name:'Lake Green',    seed:'#2E7D6E', variant:'tonalSpot',  h:'Bricolage Grotesque', b:'Figtree',       m:'Space Mono' },
  { id:'sun',        name:'Ochre Sun',     seed:'#D98324', variant:'vibrant',    h:'Bebas Neue',          b:'Work Sans',     m:'Roboto Mono' },
  { id:'paper',      name:'Sage Paper',    seed:'#6E8B5A', variant:'neutral',    h:'Young Serif',         b:'Karla',         m:'DM Mono' },
  { id:'carbon',     name:'Carbon',        seed:'#1A1A1A', variant:'monochrome', h:'Archivo',             b:'Archivo',       m:'Azeret Mono' },
  { id:'plum',       name:'Plum',          seed:'#7B3F72', variant:'tonalSpot',  h:'Playfair Display',    b:'Nunito Sans',   m:'DM Mono' },
  { id:'rust',       name:'Rust',          seed:'#A34A2A', variant:'vibrant',    h:'Alfa Slab One',       b:'Work Sans',     m:'Space Mono' },
  { id:'slate',      name:'Slate',         seed:'#42586E', variant:'neutral',    h:'Instrument Serif',    b:'Instrument Sans',m:'Red Hat Mono' },
  { id:'moss',       name:'Moss',          seed:'#4A6B32', variant:'tonalSpot',  h:'Newsreader',          b:'Figtree',       m:'Spline Sans Mono' },
  { id:'ink',        name:'Indigo Ink',    seed:'#2F3E8C', variant:'fidelity',   h:'Literata',            b:'Public Sans',   m:'IBM Plex Mono' },
  { id:'coral',      name:'Coral',         seed:'#E05A50', variant:'vibrant',    h:'Unbounded',           b:'Manrope',       m:'Martian Mono' },
  { id:'sand',       name:'Sandstone',     seed:'#C09A6B', variant:'neutral',    h:'Cormorant Garamond',  b:'Karla',         m:'Courier Prime' },
  { id:'forest',     name:'Deep Forest',   seed:'#1F5F4B', variant:'fidelity',   h:'Fraunces',            b:'Source Sans 3', m:'Fira Code' },
  { id:'mulberry',   name:'Mulberry',      seed:'#9B2C5A', variant:'expressive', h:'Syne',                b:'Epilogue',      m:'JetBrains Mono' },
  { id:'steel',      name:'Steel Blue',    seed:'#3C6E9F', variant:'tonalSpot',  h:'Archivo Black',       b:'Archivo',       m:'Roboto Mono' },
  { id:'olive',      name:'Olive Press',   seed:'#7A7A2E', variant:'tonalSpot',  h:'Domine',              b:'Cabin',         m:'Inconsolata' },
  { id:'graphite',   name:'Graphite',      seed:'#5A5F66', variant:'neutral',    h:'Lexend',              b:'Lexend',        m:'Geist Mono' },
  { id:'brick',      name:'Brick Lane',    seed:'#8C3B2E', variant:'tonalSpot',  h:'Zilla Slab',          b:'Barlow',        m:'Anonymous Pro' },
  { id:'mint',       name:'Cold Mint',     seed:'#2FA98C', variant:'vibrant',    h:'Outfit',              b:'Outfit',        m:'Victor Mono' }
];

/* Typeface pairings — one tap sets all three slots. */
const PAIRINGS = [
  { n:'Editorial',  h:'Fraunces',            b:'Karla',          m:'IBM Plex Mono' },
  { n:'Technical',  h:'Space Grotesk',       b:'Inter',          m:'JetBrains Mono' },
  { n:'Classic',    h:'Playfair Display',    b:'Nunito Sans',    m:'DM Mono' },
  { n:'Friendly',   h:'Bricolage Grotesque', b:'Figtree',        m:'Space Mono' },
  { n:'Poster',     h:'Bebas Neue',          b:'Work Sans',      m:'Roboto Mono' },
  { n:'One voice',  h:'Instrument Serif',    b:'Instrument Sans',m:'Red Hat Mono' },
  { n:'Heavyweight',h:'Archivo Black',       b:'Archivo',        m:'Azeret Mono' },
  { n:'Bookish',    h:'Literata',            b:'Source Sans 3',  m:'Courier Prime' },
  { n:'Handwritten',h:'Caveat',              b:'Nunito',         m:'DM Mono' },
  { n:'Multilingual',h:'Noto Serif',         b:'Noto Sans',      m:'Noto Sans Mono' }
];


/* Font catalogue. Every family here is SIL OFL or Apache 2.0.
   The weight fragment must match what the family actually ships — Google's API
   returns 400 and drops the whole stylesheet if you ask for a weight that
   doesn't exist, so add entries carefully rather than guessing. */
const CATALOG = [
  // ---- sans ----
  ['IBM Plex Sans','sans','wght@400;500;600;700'],['Inter','sans','wght@100..900'],
  ['Public Sans','sans','wght@100..900'],['Karla','sans','wght@200..800'],
  ['Figtree','sans','wght@300..900'],['Work Sans','sans','wght@100..900'],
  ['DM Sans','sans','wght@100..1000'],['Manrope','sans','wght@200..800'],
  ['Nunito Sans','sans','wght@200..1000'],['Nunito','sans','wght@200..1000'],
  ['Archivo','sans','wght@100..900'],['Lexend','sans','wght@100..900'],
  ['Outfit','sans','wght@100..900'],['Plus Jakarta Sans','sans','wght@200..800'],
  ['Rubik','sans','wght@300..900'],['Source Sans 3','sans','wght@200..900'],
  ['Urbanist','sans','wght@100..900'],['Sora','sans','wght@100..800'],
  ['Space Grotesk','sans','wght@300..700'],['Bricolage Grotesque','sans','wght@200..800'],
  ['Onest','sans','wght@100..900'],['Epilogue','sans','wght@100..900'],
  ['Schibsted Grotesk','sans','wght@400..900'],['Instrument Sans','sans','wght@400..700'],
  ['Wix Madefor Display','sans','wght@400..800'],['Mulish','sans','wght@200..1000'],
  ['Quicksand','sans','wght@300..700'],['Cabin','sans','wght@400..700'],
  ['Raleway','sans','wght@100..900'],['Montserrat','sans','wght@100..900'],
  ['Open Sans','sans','wght@300..800'],['Roboto','sans','wght@100..900'],
  ['Chivo','sans','wght@100..900'],['Asap','sans','wght@100..900'],
  ['Commissioner','sans','wght@100..900'],['Hanken Grotesk','sans','wght@100..900'],
  ['Be Vietnam Pro','sans','wght@100;200;300;400;500;600;700;800;900'],
  ['Red Hat Display','sans','wght@300..900'],['Red Hat Text','sans','wght@300..700'],
  ['Overpass','sans','wght@100..900'],['Anek Latin','sans','wght@100..800'],
  ['Geologica','sans','wght@100..900'],['Familjen Grotesk','sans','wght@400..700'],
  ['General Sans','sans','wght@200..700'],['Golos Text','sans','wght@400..900'],
  ['Gabarito','sans','wght@400..900'],['Darker Grotesque','sans','wght@300..900'],
  ['Barlow','sans','wght@300;400;500;600;700'],['Poppins','sans','wght@300;400;500;600;700'],
  ['Lato','sans','wght@300;400;700;900'],['PT Sans','sans','wght@400;700'],
  ['Fira Sans','sans','wght@300;400;500;600;700'],['Titillium Web','sans','wght@300;400;600;700'],
  ['Assistant','sans','wght@200..800'],['Heebo','sans','wght@100..900'],
  // ---- serif ----
  ['Fraunces','serif','opsz,wght@9..144,500;9..144,600;9..144,700'],
  ['Playfair Display','serif','wght@400..900'],['Lora','serif','wght@400..700'],
  ['Source Serif 4','serif','wght@200..900'],['Newsreader','serif','wght@200..800'],
  ['Literata','serif','wght@200..900'],['Bitter','serif','wght@100..900'],
  ['Crimson Pro','serif','wght@200..900'],['EB Garamond','serif','wght@400..800'],
  ['Young Serif','serif',''],['Instrument Serif','serif',''],
  ['DM Serif Display','serif',''],['DM Serif Text','serif',''],
  ['Roboto Slab','serif','wght@100..900'],['Zilla Slab','serif','wght@300;400;500;600;700'],
  ['Petrona','serif','wght@100..900'],['Vollkorn','serif','wght@400..900'],
  ['Spectral','serif','wght@200;300;400;500;600;700;800'],
  ['Cormorant Garamond','serif','wght@300;400;500;600;700'],
  ['Merriweather','serif','wght@300;400;700;900'],['Libre Baskerville','serif','wght@400;700'],
  ['Noto Serif','serif','wght@100..900'],['PT Serif','serif','wght@400;700'],
  ['Bodoni Moda','serif','opsz,wght@6..96,400;6..96,600;6..96,800'],
  ['Gloock','serif',''],['Rozha One','serif',''],['Eczar','serif','wght@400..800'],
  ['Faustina','serif','wght@300..800'],['Frank Ruhl Libre','serif','wght@300..900'],
  ['Alegreya','serif','wght@400..900'],['Cardo','serif','wght@400;700'],
  ['Domine','serif','wght@400..700'],['Arvo','serif','wght@400;700'],
  // ---- mono (roster grid) ----
  ['IBM Plex Mono','mono','wght@400;500;600;700'],['JetBrains Mono','mono','wght@100..800'],
  ['Roboto Mono','mono','wght@100..700'],['Space Mono','mono','wght@400;700'],
  ['DM Mono','mono','wght@300;400;500'],['Fira Code','mono','wght@300..700'],
  ['Source Code Pro','mono','wght@200..900'],['Azeret Mono','mono','wght@100..900'],
  ['Martian Mono','mono','wght@100..800'],['Red Hat Mono','mono','wght@300..700'],
  ['Geist Mono','mono','wght@100..900'],['Chivo Mono','mono','wght@100..900'],
  ['Noto Sans Mono','mono','wght@100..900'],['Inconsolata','mono','wght@200..900'],
  ['Ubuntu Sans Mono','mono','wght@400..700'],['Anonymous Pro','mono','wght@400;700'],
  ['Cousine','mono','wght@400;700'],['Overpass Mono','mono','wght@300..700'],
  ['Reddit Mono','mono','wght@200..900'],['Sometype Mono','mono','wght@400..700'],
  ['Spline Sans Mono','mono','wght@300..700'],['Syne Mono','mono',''],
  ['Nova Mono','mono',''],['Share Tech Mono','mono',''],
  ['PT Mono','mono',''],['Courier Prime','mono','wght@400;700'],
  ['Victor Mono','mono','wght@100..700'],['Recursive','mono','wght@300..1000'],
  // ---- display ----
  ['Bebas Neue','display',''],['Anton','display',''],['Archivo Black','display',''],
  ['Alfa Slab One','display',''],['Staatliches','display',''],
  ['Unbounded','display','wght@200..900'],['Syne','display','wght@400..800'],
  ['Fredoka','display','wght@300..700'],['Righteous','display',''],
  ['Abril Fatface','display',''],['Bungee','display',''],['Lilita One','display',''],
  ['Titan One','display',''],['Monoton','display',''],['Orbitron','display','wght@400..900'],
  ['Baloo 2','display','wght@400..800'],['Chango','display',''],['Rowdies','display','wght@300;400;700'],
  // ---- hand ----
  ['Caveat','hand','wght@400..700'],['Patrick Hand','hand',''],
  ['Architects Daughter','hand',''],['Kalam','hand','wght@300;400;700'],
  ['Dancing Script','hand','wght@400..700'],['Shadows Into Light','hand',''],
  ['Indie Flower','hand',''],['Gochi Hand','hand',''],['Sacramento','hand',''],
  // ---- global scripts ----
  ['Noto Sans','global','wght@100..900'],['Noto Sans Ethiopic','global','wght@100..900'],
  ['Noto Serif Ethiopic','global','wght@100..900'],['Noto Sans Adlam','global','wght@400..700'],
  ['Noto Kufi Arabic','global','wght@100..900'],['Noto Naskh Arabic','global','wght@400..700'],
  ['Noto Sans Devanagari','global','wght@100..900'],['Noto Sans JP','global','wght@100..900'],
  ['Noto Sans SC','global','wght@100..900'],['Noto Sans KR','global','wght@100..900'],
  ['Noto Sans Thai','global','wght@100..900'],['Noto Sans Hebrew','global','wght@100..900'],
  ['Noto Sans Tifinagh','global',''],['Noto Sans NKo','global',''],['Noto Sans Vai','global','']
].map(([n, c, w]) => ({ n, c, w }));

const FONT_Q = Object.fromEntries(CATALOG.map(f => [f.n, f.w]));

/* Roles the roster exposes. The grid is restricted to monospaced families
   because 48 rules use var(--mono) and the table depends on every character
   being the same width — a proportional face makes columns jump on render. */
const ROLES = [
  { key: 'h', label: 'Headings',  hint: 'Brand, day numbers, section titles', cats: null },
  { key: 'b', label: 'Interface', hint: 'Buttons, labels, body text',          cats: null },
  { key: 'm', label: 'Roster grid', hint: 'Fixed-width only, so columns stay aligned', cats: ['mono'] }
];

/* Roster grid density. Lets people trade rows-on-screen against legibility —
   useful when the same roster is read on a phone and on a bench monitor. */
const DENSITY = {
  compact:     { pad:'4px 4px',  cell:'11px',   chip:'10.5px', chipPad:'1px 4px', datePad:'5px 10px', day:'13px' },
  comfortable: { pad:'7px 6px',  cell:'12.5px', chip:'11.5px', chipPad:'2px 6px', datePad:'8px 14px', day:'14.5px' },
  large:       { pad:'10px 8px', cell:'14.5px', chip:'13.5px', chipPad:'3px 8px', datePad:'11px 16px',day:'17px' },
  xlarge:      { pad:'13px 10px',cell:'17px',   chip:'16px',   chipPad:'4px 9px', datePad:'14px 18px',day:'20px' }
};

/* ---------- 3. palette set ----------------------------------------------- */
function palettes(seed, variant) {
  const v = VARIANTS[variant] || VARIANTS.tonalSpot;
  const s = hexToLch(seed), H = s.H;
  const pC = v.pC === null ? s.C : v.pC;      // fidelity keeps the seed's own chroma
  const sC = v.sC === null ? s.C * 0.4 : v.sC;
  const tC = v.tC === null ? s.C * 0.75 : v.tC;
  return {
    accent : paletteOf(H, pC),                     // was --amber
    calm   : paletteOf((H + v.sH + 360) % 360, sC),// was --teal
    warm   : paletteOf((H + v.tH) % 360, tC),      // was --clay
    good   : paletteOf(148, pC ? 0.11 : 0),        // was --sage
    alert  : paletteOf(28,  pC ? 0.16 : 0),        // was --today / --danger
    other  : paletteOf((H + 210) % 360, tC),       // was #5b4a8a (transfusion)
    n      : paletteOf(H, v.nC),
    nv     : paletteOf(H, v.nC * 2.1)
  };
}

/* Map generated tones onto the roster's own variable names. */
function legacyVars(p, dark, c) {
  c = c || 0;                       // 0 standard, 1 more, 2 high
  const k = (lt, dk) => dark ? dk : lt;
  const d = c * 6;
  return {
    '--paper'      : p.n.t(k(97, 8)),
    '--panel'      : p.n.t(k(100, 13)),
    '--ink'        : p.n.t(k(15 - c * 5, 92 + c * 4)),
    '--ink-soft'   : p.nv.t(k(40 - c * 9, 74 + c * 8)),
    '--line'       : p.nv.t(k(88 - c * 7, 26 + c * 7)),
    '--grid-line'  : p.nv.t(k(78 - c * 9, 32 + c * 9)),
    '--navy'       : p.accent.t(k(28, 40)),
    '--navy-deep'  : p.accent.t(k(16, 10)),
    '--amber'      : p.accent.t(k(44 - d, 76 + d * 0.6)),
    '--teal'       : p.calm.t(k(40 - d, 70 + d * 0.6)),
    '--clay'       : p.warm.t(k(44 - d, 72 + d * 0.6)),
    '--sage'       : p.good.t(k(40 - d, 68 + d * 0.6)),
    '--today'      : p.alert.t(k(45 - d, 72 + d * 0.6)),
    '--danger'     : p.alert.t(k(45 - d, 72 + d * 0.6))
  };
}

/* The roster hardcodes ~40 rgba() tints for the shift columns. Rather than
   editing each rule, regenerate them all as one override sheet. */
const COLS = [['on','warm'],['lab','calm'],['trs','other'],['admin','good'],
              ['rdo','nv'],['hol','accent'],['sick','alert']];

function overrideCss(p, dark, c, dens) {
  c = c || 0;
  const k = (lt, dk) => dark ? dk : lt;
  const tint = c * 2;               // stronger contrast = deeper column tints
  let css = '';
  COLS.forEach(([cls, pal]) => {
    const P = p[pal];
    css += `td.col-${cls}{background:${P.t(k(95.5 - tint, 17 + tint))};}\n`;
    css += `td.col-${cls} .initial{background:${P.t(k(90, 25))};color:${P.t(k(32, 84))};}\n`;
  });
  css += `table.roster tbody td.datecell{background:linear-gradient(135deg,${p.n.t(k(100, 15))},${p.n.t(k(96, 11))});}\n`;
  css += `table.roster tbody tr.weekend td{background:${p.nv.t(k(93, 14))};}\n`;
  css += `table.roster tbody tr:hover td,table.roster tbody tr.weekend:hover td{background:${p.accent.t(k(90, 24))};}\n`;
  css += `table.roster tbody tr.today td{background:${p.alert.t(k(92, 22))};}\n`;
  css += `table.roster tbody tr.pubhol td{background:${p.accent.t(k(93, 20))};}\n`;
  css += `.slash{color:${p.nv.t(k(70, 40))};}\n`;
  css += `.edit-hint,.importbar{background:${p.accent.t(k(95, 17))};color:${p.accent.t(k(25, 88))};}\n`;
  css += `.initial.hi{box-shadow:0 0 0 2px ${p.n.t(k(100, 8))},0 4px 10px ${p.alert.t(k(60, 50))}88;}\n`;
  css += `header.top{background:radial-gradient(circle at 12% -25%,${p.accent.t(k(26, 20))} 0%,${p.accent.t(k(15, 8))} 58%);}\n`;
  css += `table.roster thead tr.h2 th:first-child{background:${p.accent.t(k(20, 14))};}\n`;

  /* The roster hardcodes #fff / #20180c as text on accent fills. That holds in
     light mode but fails once the accent lightens for dark mode, so pick the
     legible one against the actual generated fill. */
  const on = (P, tone) => {
    const bg = P.t(tone), lo = P.t(8), hi = P.t(100);
    return contrast(hi, bg) >= contrast(lo, bg) ? hi : lo;
  };
  const d = c * 6;
  const aT = k(44 - d, 76 + d * 0.6), cT = k(40 - d, 70 + d * 0.6), wT = k(44 - d, 72 + d * 0.6), eT = k(45 - d, 72 + d * 0.6);
  css += `nav.tabs button.active,.tabs-more-menu button.active,.import-btn,.fab-btn,.ph-badge{color:${on(p.accent, aT)};}\n`;
  css += `nav.tabs button.active{background:${p.accent.t(aT)};border-color:${p.accent.t(aT)};}\n`;
  css += `.month-select button.active,.ics-btn{color:${on(p.calm, cT)};}\n`;
  css += `.draft-tag{color:${on(p.warm, wT)};}\n`;
  css += `nav.tabs button .count-dot,.sync-badge.error .sync-dot{color:${on(p.alert, eT)};}\n`;
  css += `.save-btn{background:${p.accent.t(k(28, 40))};color:${on(p.accent, k(28, 40))};}\n`;

  /* Grid density. Only four rules, so scaling them here is safer than
     zooming the page, which breaks the sticky date column. */
  const D = DENSITY[dens] || DENSITY.comfortable;
  css += `table.roster tbody td{padding:${D.pad};font-size:${D.cell};}\n`;
  css += `.initial{font-size:${D.chip};padding:${D.chipPad};}\n`;
  css += `table.roster tbody td.datecell{padding:${D.datePad};}\n`;
  css += `table.roster tbody td.datecell .daynum{font-size:${D.day};}\n`;
  return css;
}

/* ---------- 4. fonts ----------------------------------------------------- */
function fontHref(list) {
  const uniq = [...new Set(list)];
  return 'https://fonts.googleapis.com/css2?' + uniq.map(n => {
    const q = FONT_Q[n];
    return 'family=' + encodeURIComponent(n).replace(/%20/g, '+') + (q ? ':' + q : '');
  }).join('&') + '&display=swap';
}
function loadFonts(t) {
  let link = document.getElementById('atelier-fonts');
  if (!link) {
    link = document.createElement('link');
    link.id = 'atelier-fonts'; link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  const href = fontHref([t.h, t.b, t.m]);
  if (link.href !== href) link.href = href;
}

/* ---------- 5. apply ----------------------------------------------------- */
const KEY = 'lab-roster-atelier';
let current = Object.assign({ c: 0, dens: 'comfortable' }, THEMES[0]);

function readPref() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    const base = THEMES.find(t => t.id === j.id) || THEMES[0];
    return Object.assign({ c: 0, dens: 'comfortable' }, base, j);
  } catch (e) { return null; }
}
function writePref(t) { try { localStorage.setItem(KEY, JSON.stringify(t)); } catch (e) {} }

function paint() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const p = palettes(current.seed, current.variant);
  const vars = legacyVars(p, dark, current.c);
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);

  root.setProperty('--display', '"' + current.h + '","' + current.b + '",serif');
  root.setProperty('--sans', '"' + current.b + '","Segoe UI",system-ui,sans-serif');
  root.setProperty('--mono', '"' + current.m + '",SFMono-Regular,Consolas,monospace');

  let sheet = document.getElementById('atelier-overrides');
  if (!sheet) {
    sheet = document.createElement('style');
    sheet.id = 'atelier-overrides';
    document.head.appendChild(sheet);       // last in head = wins on equal specificity
  }
  sheet.textContent = overrideCss(p, dark, current.c, current.dens);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', vars['--navy-deep']);

  loadFonts(current);
}

function setTheme(t) { current = t; writePref(t); paint(); }

/* ---------- 6. settings sheet -------------------------------------------- */
const CSS_UI = `
#atelierPanel{position:fixed;left:0;right:0;bottom:0;z-index:300;max-height:88vh;
  display:none;flex-direction:column;background:var(--panel);color:var(--ink);
  border-top:1px solid var(--line);border-radius:18px 18px 0 0;
  box-shadow:0 -18px 50px rgba(0,0,0,.35);animation:atSlide .22s ease}
#atelierPanel.open{display:flex}
@keyframes atSlide{from{transform:translateY(14px);opacity:.4}to{transform:none;opacity:1}}
@media(min-width:760px){#atelierPanel{left:auto;right:16px;bottom:16px;width:390px;
  border-radius:16px;border:1px solid var(--line)}}
#atelierScrim{position:fixed;inset:0;background:rgba(0,0,0,.34);z-index:299;display:none}
#atelierScrim.open{display:block}
.at-head{display:flex;align-items:center;gap:10px;padding:16px 18px 12px;border-bottom:1px solid var(--line)}
.at-head strong{font-family:var(--display);font-size:16px;flex:1}
.at-x{all:unset;cursor:pointer;font-size:24px;line-height:1;padding:0 8px;color:var(--ink-soft)}
.at-body{overflow-y:auto;padding:16px 18px 26px;-webkit-overflow-scrolling:touch}
.at-lbl{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--ink-soft);margin:20px 0 9px;display:flex;align-items:center;gap:9px}
.at-lbl:first-child{margin-top:0}
.at-lbl::after{content:'';flex:1;height:1px;background:var(--line)}
.at-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.at-sw{all:unset;box-sizing:border-box;cursor:pointer;border:1.5px solid var(--line);
  border-radius:11px;padding:9px}
.at-sw.on{border-color:var(--amber);box-shadow:inset 0 0 0 1px var(--amber)}
.at-sw .bars{display:flex;gap:3px;margin-bottom:7px}
.at-sw .bars i{flex:1;height:15px;border-radius:3px}
.at-sw b{font-size:12px;font-weight:600;display:block}
.at-row{display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;
  background:none;border:1px solid var(--line);border-radius:11px;padding:11px 13px;
  margin-bottom:8px;cursor:pointer;text-align:left;color:var(--ink)}
.at-row .rl{flex:none;width:82px}
.at-row .rl b{display:block;font-size:12.5px;font-weight:600}
.at-row .rl span{font-size:10px;color:var(--ink-soft);font-family:var(--mono)}
.at-row .rv{flex:1;min-width:0;font-size:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.at-seed{display:flex;align-items:center;gap:11px;margin-bottom:10px}
.at-seed .dot{width:38px;height:38px;border-radius:10px;position:relative;overflow:hidden;
  border:1px solid var(--line);flex:none}
.at-seed .dot input{position:absolute;inset:-8px;width:150%;height:150%;border:0;padding:0;background:none;cursor:pointer}
.at-sel{width:100%;padding:10px;border-radius:9px;border:1px solid var(--line);
  background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:13.5px}
.at-note{font-size:11.5px;color:var(--ink-soft);line-height:1.5;margin:9px 0 0}
.at-audit{font-family:var(--mono);font-size:11px;color:var(--ink-soft);line-height:1.7}
.at-audit b{color:var(--sage);font-weight:600}
.at-audit b.low{color:var(--today)}
.at-search{width:100%;padding:10px 12px;border-radius:9px;border:1px solid var(--line);
  background:var(--paper);color:var(--ink);font-size:14px;margin-bottom:10px}
.at-flist{border:1px solid var(--line);border-radius:11px;overflow:hidden}
.at-fitem{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;background:none;
  border:0;border-bottom:1px solid var(--line);padding:11px 13px;cursor:pointer;text-align:left;color:var(--ink)}
.at-fitem:last-child{border-bottom:0}
.at-fitem.on{background:var(--line)}
.at-fitem .s{flex:1;font-size:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.at-fitem .n{font-family:var(--mono);font-size:9.5px;color:var(--ink-soft);flex:none}
.at-back{all:unset;cursor:pointer;font-family:var(--mono);font-size:11px;color:var(--ink-soft);
  letter-spacing:.08em;text-transform:uppercase}
.at-pair{all:unset;box-sizing:border-box;cursor:pointer;display:block;width:100%;
  border:1px solid var(--line);border-radius:11px;padding:10px 13px;margin-bottom:8px}
.at-pair .ph{display:block;font-size:19px;line-height:1.15}
.at-pair .pb{display:block;font-size:11px;color:var(--ink-soft);margin-top:3px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.at-seg{display:flex;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.at-seg button{all:unset;flex:1;text-align:center;cursor:pointer;padding:10px 4px;
  font-size:12.5px;color:var(--ink-soft)}
.at-seg button+button{border-left:1px solid var(--line)}
.at-seg button.on{background:var(--amber);color:var(--paper);font-weight:600}
.at-reset{all:unset;cursor:pointer;display:block;text-align:center;width:100%;margin-top:22px;
  padding:11px;border:1px solid var(--line);border-radius:10px;font-size:13px;color:var(--ink-soft)}
`;

/* Preview a family in the picker without committing to it. */
const previewed = new Set();
function previewFont(name) {
  if (previewed.has(name)) return;
  previewed.add(name);
  const q = FONT_Q[name];
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=' +
    encodeURIComponent(name).replace(/%20/g, '+') + (q ? ':' + q : '') + '&display=swap';
  document.head.appendChild(l);
}

function buildPicker() {
  const anchor = document.getElementById('themeToggle');
  if (!anchor) return;

  const style = document.createElement('style');
  style.textContent = CSS_UI;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.className = anchor.className;
  btn.id = 'paletteToggle';
  btn.type = 'button';
  btn.innerHTML = '<span style="width:11px;height:11px;border-radius:3px;background:var(--amber);display:inline-block"></span>Theme';
  anchor.parentNode.insertBefore(btn, anchor.nextSibling);

  const scrim = document.createElement('div');
  scrim.id = 'atelierScrim';
  document.body.appendChild(scrim);

  const panel = document.createElement('div');
  panel.id = 'atelierPanel';
  panel.innerHTML =
    '<div class="at-head"><strong>Appearance</strong>' +
    '<span class="at-note" style="margin:0">this device only</span>' +
    '<button class="at-x" aria-label="Close">&times;</button></div>' +
    '<div class="at-body"></div>';
  document.body.appendChild(panel);

  const body = panel.querySelector('.at-body');
  let route = { view: 'home', role: null, q: '' };

  function draw() {
    body.scrollTop = 0;
    body.innerHTML = route.view === 'home' ? homeHtml() : fontHtml();
    route.view === 'home' ? wireHome() : wireFonts();
  }

  /* ----- home ----- */
  function homeHtml() {
    const swatches = THEMES.map(t => {
      const p = palettes(t.seed, t.variant);
      return '<button class="at-sw' + (t.id === current.id ? ' on' : '') + '" data-t="' + t.id + '">' +
        '<span class="bars">' + [p.accent.t(46), p.calm.t(40), p.warm.t(44), p.n.t(90)]
          .map(c => '<i style="background:' + c + '"></i>').join('') + '</span>' +
        '<b>' + t.name + '</b></button>';
    }).join('');

    const roles = ROLES.map(r =>
      '<button class="at-row" data-role="' + r.key + '">' +
      '<span class="rl"><b>' + r.label + '</b><span>' + (r.cats ? 'mono' : 'any') + '</span></span>' +
      '<span class="rv" style="font-family:\'' + current[r.key] + '\'">' + current[r.key] + '</span>' +
      '</button>').join('');

    const a = window.Atelier.audit();
    const rows = Object.entries(a).map(([k, v]) =>
      k + ' <b class="' + (parseFloat(v) < 4.5 ? 'low' : '') + '">' + v + '</b>').join('<br>');

    const pairs = PAIRINGS.map((p, i) =>
      '<button class="at-pair" data-p="' + i + '">' +
      '<span class="ph" style="font-family:\'' + p.h + '\'">' + p.n + '</span>' +
      '<span class="pb" style="font-family:\'' + p.b + '\'">' + p.h + ' · ' + p.b + ' · ' + p.m + '</span>' +
      '</button>').join('');

    const seg = (id, opts, cur) => '<div class="at-seg" id="' + id + '">' + opts.map(([v, l]) =>
      '<button data-v="' + v + '"' + (v == cur ? ' class="on"' : '') + '>' + l + '</button>').join('') + '</div>';

    return '<div class="at-lbl">Palette</div><div class="at-grid">' + swatches + '</div>' +
      '<div class="at-lbl">Your own colour</div>' +
      '<div class="at-seed"><span class="dot" style="background:' + current.seed + '">' +
        '<input type="color" id="atSeed" value="' + current.seed + '"></span>' +
        '<select class="at-sel" id="atVariant">' +
        Object.keys(VARIANTS).map(v => '<option value="' + v + '"' +
          (v === current.variant ? ' selected' : '') + '>' + v + '</option>').join('') +
        '</select></div>' +
      '<p class="at-note">Pick any colour and the rest of the palette is generated around it. ' +
        'The variant sets how far the supporting colours travel from your choice.</p>' +
      '<div class="at-lbl">Typeface pairings</div>' + pairs +
      '<div class="at-lbl">Or set each slot</div>' + roles +
      '<p class="at-note">' + ROLES[2].hint + '</p>' +
      '<div class="at-lbl">Contrast</div>' +
      seg('atC', [[0, 'Standard'], [1, 'More'], [2, 'High']], current.c) +
      '<p class="at-note">Deepens text and borders. Useful under the bench lights, ' +
        'or for anyone who finds the standard setting washed out.</p>' +
      '<div class="at-lbl">Grid density</div>' +
      seg('atD', [['compact', 'Compact'], ['comfortable', 'Default'], ['large', 'Large'], ['xlarge', 'Largest']], current.dens) +
      '<p class="at-note">Trades rows on screen against readability. Largest is ' +
        'aimed at a wall monitor, compact at seeing a full fortnight on a phone.</p>' +
      '<div class="at-lbl">Legibility</div><div class="at-audit">' + rows + '</div>' +
      '<button class="at-reset">Reset to Lab Notebook</button>';
  }

  function wireHome() {
    body.querySelectorAll('.at-sw').forEach(b => b.onclick = () => {
      const t = THEMES.find(x => x.id === b.dataset.t);
      setTheme(Object.assign({}, t, { c: current.c, dens: current.dens })); draw();
    });
    body.querySelectorAll('.at-row').forEach(b => b.onclick = () => {
      route = { view: 'fonts', role: b.dataset.role, q: '' }; draw();
    });
    const seed = body.querySelector('#atSeed');
    seed.oninput = () => {
      setTheme(Object.assign({}, current, { seed: seed.value.toUpperCase(), id: 'custom', name: 'Custom' }));
      seed.parentNode.style.background = seed.value;
      const a = window.Atelier.audit();
      body.querySelector('.at-audit').innerHTML = Object.entries(a).map(([k, v]) =>
        k + ' <b class="' + (parseFloat(v) < 4.5 ? 'low' : '') + '">' + v + '</b>').join('<br>');
      body.querySelectorAll('.at-sw').forEach(x => x.classList.remove('on'));
    };
    body.querySelectorAll('.at-pair').forEach(b => b.onclick = () => {
      const p = PAIRINGS[+b.dataset.p];
      setTheme(Object.assign({}, current, { h: p.h, b: p.b, m: p.m })); draw();
    });
    const segWire = (id, key, cast) => body.querySelectorAll('#' + id + ' button').forEach(b =>
      b.onclick = () => { setTheme(Object.assign({}, current, { [key]: cast(b.dataset.v) })); draw(); });
    segWire('atC', 'c', Number);
    segWire('atD', 'dens', String);
    body.querySelector('#atVariant').onchange = e =>
      { setTheme(Object.assign({}, current, { variant: e.target.value })); draw(); };
    PAIRINGS.forEach(p => { previewFont(p.h); previewFont(p.b); });
    body.querySelector('.at-reset').onclick = () => { setTheme(Object.assign({ c: 0, dens: 'comfortable' }, THEMES[0])); draw(); };
  }

  /* ----- font list ----- */
  function fontHtml() {
    const role = ROLES.find(r => r.key === route.role);
    const list = CATALOG
      .filter(f => !role.cats || role.cats.includes(f.c))
      .filter(f => f.n.toLowerCase().includes(route.q.toLowerCase()));
    return '<button class="at-back">&larr; back</button>' +
      '<div class="at-lbl">' + role.label + '</div>' +
      '<p class="at-note" style="margin:-4px 0 12px">' + role.hint + '</p>' +
      '<input class="at-search" id="atQ" placeholder="search ' + list.length + ' fonts" value="' + route.q + '">' +
      '<div class="at-flist">' + (list.length ? list.map(f =>
        '<button class="at-fitem' + (f.n === current[route.role] ? ' on' : '') + '" data-f="' + f.n + '">' +
        '<span class="s" style="font-family:\'' + f.n + '\'">Mon 07 · Zee</span>' +
        '<span class="n">' + f.n + '</span></button>').join('')
        : '<p class="at-note" style="padding:14px">No family matches that. Try a shorter word.</p>') +
      '</div>';
  }

  function wireFonts() {
    body.querySelector('.at-back').onclick = () => { route = { view: 'home', role: null, q: '' }; draw(); };
    const q = body.querySelector('#atQ');
    q.oninput = () => {
      route.q = q.value;
      const box = body.querySelector('.at-flist');
      const role = ROLES.find(r => r.key === route.role);
      const list = CATALOG.filter(f => !role.cats || role.cats.includes(f.c))
                          .filter(f => f.n.toLowerCase().includes(route.q.toLowerCase()));
      box.innerHTML = list.length ? list.map(f =>
        '<button class="at-fitem' + (f.n === current[route.role] ? ' on' : '') + '" data-f="' + f.n + '">' +
        '<span class="s" style="font-family:\'' + f.n + '\'">Mon 07 · Zee</span>' +
        '<span class="n">' + f.n + '</span></button>').join('')
        : '<p class="at-note" style="padding:14px">No family matches that. Try a shorter word.</p>';
      bindItems();
    };
    bindItems();
  }
  function bindItems() {
    body.querySelectorAll('.at-fitem').forEach(b => {
      previewFont(b.dataset.f);
      b.onclick = () => {
        setTheme(Object.assign({}, current, { [route.role]: b.dataset.f }));
        body.querySelectorAll('.at-fitem').forEach(x => x.classList.toggle('on', x === b));
      };
    });
    /* load the visible samples in their own faces */
    body.querySelectorAll('.at-fitem').forEach(b => previewFont(b.dataset.f));
  }

  const open = on => {
    panel.classList.toggle('open', on);
    scrim.classList.toggle('open', on);
    if (on) { route = { view: 'home', role: null, q: '' }; draw(); }
  };
  btn.onclick = () => open(!panel.classList.contains('open'));
  panel.querySelector('.at-x').onclick = () => open(false);
  scrim.onclick = () => open(false);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') open(false); });
}

/* ---------- 7. boot ------------------------------------------------------ */
function start() {
  current = readPref() || THEMES[0];
  paint();
  buildPicker();
  // The roster flips data-theme on <html> when the light/dark button is used.
  // Repaint on that change rather than monkey-patching its applyTheme().
  new MutationObserver(paint).observe(document.documentElement,
    { attributes: true, attributeFilter: ['data-theme'] });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

/* Exposed for the console / future settings screen */
window.Atelier = {
  themes: THEMES,
  set: id => { const t = THEMES.find(x => x.id === id); if (t) setTheme(Object.assign({}, t, { m: current.m })); },
  custom: (seed, variant) => setTheme(Object.assign({}, current, { seed, variant: variant || current.variant })),
  audit: () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const v = legacyVars(palettes(current.seed, current.variant), dark, current.c);
    return {
      'body text'   : contrast(v['--ink'], v['--paper']).toFixed(2) + ':1',
      'muted text'  : contrast(v['--ink-soft'], v['--panel']).toFixed(2) + ':1',
      'accent/paper': contrast(v['--amber'], v['--paper']).toFixed(2) + ':1',
      'today/paper' : contrast(v['--today'], v['--paper']).toFixed(2) + ':1'
    };
  }
};
})();
