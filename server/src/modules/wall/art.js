// Illustrated placeholder "photos" for the demo seed (no network, no image libraries):
// each scene is a self-contained SVG rendered by the browser like any other image.

const W = 1200;
const H = 900;
const wrap = (defs, body, w = W, h = H) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><defs>${defs}</defs>${body}</svg>`;

/** Deterministic pseudo-random numbers so seeds look the same every run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function sunset({ seed = 1, sky = ['#2b1055', '#d53369', '#fbb040'], pier = true } = {}) {
  const r = rng(seed);
  const waves = Array.from({ length: 14 }, (_, i) => {
    const y = 600 + i * 22;
    const w = 120 + r() * 380;
    const x = r() * (W - w);
    return `<rect x="${x.toFixed(0)}" y="${y}" width="${w.toFixed(0)}" height="4" rx="2" fill="#ffd9a0" opacity="${(0.55 - i * 0.03).toFixed(2)}"/>`;
  }).join('');
  const birds = Array.from({ length: 5 }, () => {
    const x = 200 + r() * 800;
    const y = 120 + r() * 200;
    const s = 10 + r() * 14;
    return `<path d="M${x} ${y} q${s / 2} ${-s / 2} ${s} 0 q${s / 2} ${-s / 2} ${s} 0" stroke="#3a1740" stroke-width="3" fill="none" stroke-linecap="round"/>`;
  }).join('');
  const posts = pier
    ? Array.from({ length: 9 }, (_, i) => `<rect x="${90 + i * 62}" y="${640 + i * 4}" width="8" height="${120 - i * 6}" fill="#2a0f2e"/>`).join('')
    : '';
  const deck = pier ? `<path d="M0 620 L640 668 L640 680 L0 640 Z" fill="#2a0f2e"/>${posts}` : '';
  return wrap(
    `<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="0.55" stop-color="${sky[1]}"/><stop offset="1" stop-color="${sky[2]}"/></linearGradient>
     <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e2736a"/><stop offset="1" stop-color="#3b1f4f"/></linearGradient>
     <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff5c2"/><stop offset="0.7" stop-color="#ffd166"/><stop offset="1" stop-color="#ffd166" stop-opacity="0"/></radialGradient>`,
    `<rect width="${W}" height="${H}" fill="url(#s)"/><circle cx="760" cy="560" r="170" fill="url(#sun)"/><circle cx="760" cy="560" r="96" fill="#fff1b8"/>${birds}
     <rect y="580" width="${W}" height="${H - 580}" fill="url(#sea)"/>${waves}${deck}`,
  );
}

function mountains({ seed = 2, sky = ['#7ec8f2', '#dff3ff'], lake = true, peaks = ['#51698f', '#3b5078', '#2a3b5c'] } = {}) {
  const r = rng(seed);
  const ridge = (base, amp, color, n = 7) => {
    let d = `M0 ${H} L0 ${base}`;
    for (let i = 0; i <= n; i++) {
      const x = (W / n) * i;
      const y = base - amp * (0.4 + r() * 0.6) * (i % 2 ? 1 : 0.45);
      d += ` L${x.toFixed(0)} ${y.toFixed(0)}`;
    }
    return `<path d="${d} L${W} ${H} Z" fill="${color}"/>`;
  };
  const trees = Array.from({ length: 22 }, (_, i) => {
    const x = i * 58 + r() * 20;
    const h = 70 + r() * 70;
    const y = lake ? 600 : 760;
    return `<path d="M${x} ${y} l${h * 0.28} ${-h} l${h * 0.28} ${h} Z" fill="#1f3d2c"/>`;
  }).join('');
  const water = lake
    ? `<rect y="600" width="${W}" height="${H - 600}" fill="url(#lake)"/>${Array.from({ length: 8 }, (_, i) => `<rect x="${100 + r() * 900}" y="${630 + i * 32}" width="${80 + r() * 200}" height="3" rx="1.5" fill="#fff" opacity="0.35"/>`).join('')}`
    : `<rect y="760" width="${W}" height="${H - 760}" fill="#3f6b3a"/>`;
  const clouds = Array.from({ length: 3 }, () => {
    const x = r() * 1000;
    const y = 80 + r() * 140;
    return `<g fill="#fff" opacity="0.85"><ellipse cx="${x}" cy="${y}" rx="90" ry="26"/><ellipse cx="${x + 50}" cy="${y - 16}" rx="60" ry="30"/><ellipse cx="${x - 40}" cy="${y - 8}" rx="50" ry="22"/></g>`;
  }).join('');
  return wrap(
    `<linearGradient id="sk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient>
     <linearGradient id="lake" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5aa6c8"/><stop offset="1" stop-color="#1d4e6b"/></linearGradient>`,
    `<rect width="${W}" height="${H}" fill="url(#sk)"/>${clouds}
     ${ridge(430, 260, peaks[0])}${ridge(520, 220, peaks[1], 9)}${ridge(600, 160, peaks[2], 11)}
     <path d="M300 260 l60 70 l-120 0 Z" fill="#fff" opacity="0.9"/>${water}${trees}`,
  );
}

function soccer({ seed = 3 } = {}) {
  const r = rng(seed);
  const stripes = Array.from({ length: 8 }, (_, i) => `<rect y="${420 + i * 60}" width="${W}" height="30" fill="#2f8f46" opacity="0.5"/>`).join('');
  const crowd = Array.from({ length: 60 }, (_, i) => {
    const colors = ['#E5484D', '#0090FF', '#FFB224', '#fff', '#8E4EC6', '#30A46C'];
    return `<circle cx="${i * 20 + r() * 10}" cy="${360 + r() * 30}" r="${8 + r() * 4}" fill="${colors[Math.floor(r() * colors.length)]}" opacity="0.8"/>`;
  }).join('');
  return wrap(
    `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fd3fe"/><stop offset="1" stop-color="#e8f6ff"/></linearGradient>`,
    `<rect width="${W}" height="${H}" fill="url(#sky)"/><rect y="330" width="${W}" height="80" fill="#5d6b7a"/>${crowd}
     <rect y="400" width="${W}" height="${H - 400}" fill="#3aa856"/>${stripes}
     <path d="M200 900 L420 470 L780 470 L1000 900" stroke="#fff" stroke-width="6" fill="none" opacity="0.85"/>
     <g stroke="#fff" stroke-width="10" fill="none"><path d="M470 470 L470 330 L730 330 L730 470"/></g>
     <g stroke="#fff" stroke-width="2" opacity="0.6">${Array.from({ length: 12 }, (_, i) => `<line x1="${480 + i * 21}" y1="335" x2="${480 + i * 21}" y2="470"/>`).join('')}${Array.from({ length: 6 }, (_, i) => `<line x1="475" y1="${345 + i * 22}" x2="725" y2="${345 + i * 22}"/>`).join('')}</g>
     <g transform="translate(600 720)"><circle r="58" fill="#fff" stroke="#222" stroke-width="3"/><path d="M0 -22 L21 -7 L13 18 L-13 18 L-21 -7 Z" fill="#222"/><path d="M0 -58 L0 -22 M21 -7 L52 -18 M13 18 L32 46 M-13 18 L-32 46 M-21 -7 L-52 -18" stroke="#222" stroke-width="3"/></g>
     <ellipse cx="600" cy="790" rx="70" ry="12" fill="#000" opacity="0.18"/>`,
  );
}

function kidDrawing() {
  const family = [
    { x: 330, c: '#5B5BD6', h: 170 },
    { x: 440, c: '#D6409F', h: 160 },
    { x: 540, c: '#30A46C', h: 120 },
    { x: 620, c: '#F76B15', h: 95 },
  ]
    .map(
      (p) =>
        `<g stroke="${p.c}" stroke-width="7" stroke-linecap="round" fill="none"><circle cx="${p.x}" cy="${760 - p.h}" r="24"/><path d="M${p.x} ${784 - p.h} L${p.x} ${760 - p.h * 0.35} M${p.x} ${760 - p.h * 0.35} L${p.x - 22} 780 M${p.x} ${760 - p.h * 0.35} L${p.x + 22} 780 M${p.x - 30} ${810 - p.h} L${p.x + 30} ${800 - p.h}"/></g>`,
    )
    .join('');
  return wrap(
    '',
    `<rect width="${W}" height="${H}" fill="#fffdf6"/>
     ${Array.from({ length: 18 }, (_, i) => `<line x1="0" y1="${60 + i * 48}" x2="${W}" y2="${60 + i * 48}" stroke="#bcd7f5" stroke-width="2"/>`).join('')}
     <line x1="110" y1="0" x2="110" y2="${H}" stroke="#f3a3a3" stroke-width="3"/>
     <g stroke="#ffb224" stroke-width="8" stroke-linecap="round"><circle cx="1010" cy="150" r="62" fill="#ffd34d"/>${Array.from({ length: 10 }, (_, i) => {
       const a = (i / 10) * Math.PI * 2;
       return `<line x1="${1010 + Math.cos(a) * 82}" y1="${150 + Math.sin(a) * 82}" x2="${1010 + Math.cos(a) * 118}" y2="${150 + Math.sin(a) * 118}"/>`;
     }).join('')}</g>
     <path d="M700 520 L860 380 L1020 520 Z" fill="#e5484d" stroke="#a61e22" stroke-width="7" stroke-linejoin="round"/>
     <rect x="720" y="520" width="280" height="260" fill="#ffe7a8" stroke="#a37a1c" stroke-width="7"/>
     <rect x="830" y="640" width="70" height="140" fill="#8b5a2b" stroke="#5e3a17" stroke-width="6"/>
     <rect x="750" y="560" width="60" height="60" fill="#8fd3fe" stroke="#1f6fb2" stroke-width="6"/>
     <rect x="915" y="560" width="60" height="60" fill="#8fd3fe" stroke="#1f6fb2" stroke-width="6"/>
     <path d="M120 790 Q400 770 700 790 T1200 785" stroke="#30a46c" stroke-width="16" fill="none" stroke-linecap="round"/>
     ${family}
     <text x="170" y="150" font-family="Comic Sans MS, Chalkboard, cursive" font-size="64" fill="#5B5BD6" transform="rotate(-4 170 150)">OUR HOUSE</text>
     <text x="180" y="230" font-family="Comic Sans MS, Chalkboard, cursive" font-size="40" fill="#F76B15" transform="rotate(-3 180 230)">by Leo</text>`,
  );
}

function volcano() {
  return wrap(
    `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9e4ff"/><stop offset="1" stop-color="#c9c0f2"/></linearGradient>
     <linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a5a3b"/><stop offset="1" stop-color="#5b3a26"/></linearGradient>`,
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>
     <rect x="120" y="120" width="420" height="300" rx="16" fill="#fff" stroke="#8E4EC6" stroke-width="6"/>
     <text x="150" y="190" font-family="Helvetica, Arial" font-weight="700" font-size="44" fill="#5B2B8C">How volcanoes</text>
     <text x="150" y="245" font-family="Helvetica, Arial" font-weight="700" font-size="44" fill="#5B2B8C">erupt!</text>
     <rect x="150" y="280" width="340" height="14" rx="7" fill="#d9c9f2"/><rect x="150" y="310" width="280" height="14" rx="7" fill="#d9c9f2"/><rect x="150" y="340" width="310" height="14" rx="7" fill="#d9c9f2"/>
     <rect x="0" y="740" width="${W}" height="${H - 740}" fill="#b07c52"/><rect x="0" y="740" width="${W}" height="18" fill="#8d5f3b"/>
     <path d="M560 740 L760 380 L840 380 L1060 740 Z" fill="url(#v)"/>
     <path d="M760 380 Q800 330 840 380 Q830 470 810 520 Q790 470 760 380 Z" fill="#ff6a3d"/>
     <path d="M785 400 Q770 560 720 640 Q760 600 790 520 Z M815 400 Q840 560 900 660 Q850 600 812 520 Z" fill="#ff8a3d"/>
     ${[0, 1, 2, 3, 4, 5].map((i) => `<circle cx="${740 + i * 26}" cy="${300 - (i % 3) * 40}" r="${16 + (i % 2) * 10}" fill="#ffb224" opacity="0.9"/>`).join('')}
     <g transform="translate(980 250) rotate(12)"><circle r="80" fill="#ffd34d" stroke="#e0a100" stroke-width="6"/><text x="-34" y="26" font-family="Helvetica, Arial" font-weight="800" font-size="76" fill="#8a5a00">A</text></g>`,
  );
}

function cookies({ seed = 5 } = {}) {
  const r = rng(seed);
  const cookie = (x, y, s) => {
    const chips = Array.from({ length: 6 }, () => `<circle cx="${x + (r() - 0.5) * s}" cy="${y + (r() - 0.5) * s}" r="${s * 0.07}" fill="#4a2a14"/>`).join('');
    return `<circle cx="${x}" cy="${y}" r="${s * 0.62}" fill="#d99a4e" stroke="#b67a35" stroke-width="5"/>${chips}`;
  };
  const crumbs = Array.from({ length: 24 }, () => `<circle cx="${380 + r() * 460}" cy="${520 + r() * 180}" r="${3 + r() * 5}" fill="#c78a44"/>`).join('');
  return wrap(
    `<radialGradient id="t" cx="0.5" cy="0.4" r="0.8"><stop offset="0" stop-color="#fbe6cf"/><stop offset="1" stop-color="#d9b48e"/></radialGradient>`,
    `<rect width="${W}" height="${H}" fill="url(#t)"/>
     <ellipse cx="600" cy="520" rx="360" ry="250" fill="#fff" stroke="#e5d6c6" stroke-width="10"/>
     <ellipse cx="600" cy="520" rx="290" ry="190" fill="none" stroke="#efe4d7" stroke-width="4"/>
     ${crumbs}
     <path d="M520 470 a70 70 0 1 1 20 80 l-10 -30 l-20 10 l-8 -30 Z" fill="#d99a4e" stroke="#b67a35" stroke-width="5"/>
     ${cookie(1020, 180, 150)}${cookie(160, 760, 130)}
     <text x="470" y="850" font-family="Helvetica, Arial" font-weight="700" font-size="46" fill="#7a4a20">…who did this?</text>`,
  );
}

function camping() {
  const stars = Array.from({ length: 70 }, (_, i) => {
    const r = rng(100 + i);
    return `<circle cx="${(r() * W).toFixed(0)}" cy="${(r() * 460).toFixed(0)}" r="${(1 + r() * 2.4).toFixed(1)}" fill="#fff" opacity="${(0.5 + r() * 0.5).toFixed(2)}"/>`;
  }).join('');
  return wrap(
    `<linearGradient id="n" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1026"/><stop offset="1" stop-color="#2b3a6b"/></linearGradient>
     <radialGradient id="f" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffcf70" stop-opacity="0.9"/><stop offset="1" stop-color="#ffcf70" stop-opacity="0"/></radialGradient>`,
    `<rect width="${W}" height="${H}" fill="url(#n)"/>${stars}<circle cx="950" cy="160" r="60" fill="#f4f1d0"/><circle cx="975" cy="145" r="54" fill="#141b3a"/>
     <path d="M0 600 L220 420 L420 580 L640 380 L900 600 L1200 440 L1200 900 L0 900 Z" fill="#1b2445"/>
     <rect y="680" width="${W}" height="${H - 680}" fill="#18233b"/>
     <path d="M300 760 L460 520 L620 760 Z" fill="#F76B15"/><path d="M460 520 L460 760 L400 760 Z" fill="#c24f0a"/>
     <circle cx="820" cy="740" r="160" fill="url(#f)"/>
     <path d="M790 770 Q820 660 850 770 Z" fill="#ff8a3d"/><path d="M805 770 Q820 700 835 770 Z" fill="#ffd166"/>
     <rect x="760" y="768" width="120" height="14" rx="7" fill="#6b4226" transform="rotate(8 820 775)"/><rect x="760" y="768" width="120" height="14" rx="7" fill="#7b4d2d" transform="rotate(-8 820 775)"/>`,
  );
}

function pancakes() {
  return wrap(
    `<radialGradient id="bg" cx="0.5" cy="0.5" r="0.75"><stop offset="0" stop-color="#fff4d6"/><stop offset="1" stop-color="#f3c77a"/></radialGradient>`,
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>
     <ellipse cx="600" cy="700" rx="400" ry="90" fill="#fff" stroke="#eadcc4" stroke-width="8"/>
     ${[0, 1, 2, 3, 4, 5].map((i) => `<ellipse cx="600" cy="${660 - i * 58}" rx="${280 - i * 6}" ry="62" fill="#e0a45a" stroke="#b97b35" stroke-width="5"/><ellipse cx="600" cy="${648 - i * 58}" rx="${270 - i * 6}" ry="48" fill="#eeb96e"/>`).join('')}
     <path d="M420 348 Q600 300 780 348 Q760 420 700 400 Q680 470 640 420 Q600 500 570 420 Q520 460 500 400 Q440 420 420 348 Z" fill="#9a4d10" opacity="0.9"/>
     <rect x="560" y="300" width="80" height="50" rx="8" fill="#ffe89a"/>
     ${[0, 1, 2, 3, 4].map((i) => `<circle cx="${420 + i * 90}" cy="${780 + (i % 2) * 20}" r="22" fill="#3b5bdb"/><circle cx="${412 + i * 90}" cy="${772 + (i % 2) * 20}" r="6" fill="#fff" opacity="0.6"/>`).join('')}
     <circle cx="880" cy="260" r="34" fill="#e5484d"/><path d="M880 226 q10 -24 26 -20" stroke="#30a46c" stroke-width="6" fill="none"/>`,
  );
}

function garden({ seed = 7 } = {}) {
  const r = rng(seed);
  const colors = ['#E5484D', '#FFB224', '#D6409F', '#8E4EC6', '#fff'];
  const flowers = Array.from({ length: 26 }, () => {
    const x = 40 + r() * 1120;
    const y = 520 + r() * 330;
    const c = colors[Math.floor(r() * colors.length)];
    const s = 14 + r() * 16;
    return `<line x1="${x}" y1="${y}" x2="${x}" y2="${y + 80}" stroke="#2f7a3b" stroke-width="5"/>${[0, 72, 144, 216, 288].map((a) => `<circle cx="${x + Math.cos((a * Math.PI) / 180) * s}" cy="${y + Math.sin((a * Math.PI) / 180) * s}" r="${s * 0.7}" fill="${c}"/>`).join('')}<circle cx="${x}" cy="${y}" r="${s * 0.55}" fill="#ffd34d"/>`;
  }).join('');
  return wrap(
    `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#bfe6ff"/><stop offset="1" stop-color="#f1fbff"/></linearGradient>`,
    `<rect width="${W}" height="${H}" fill="url(#g)"/><circle cx="180" cy="160" r="80" fill="#ffe27a"/>
     <path d="M0 520 Q300 440 600 500 T1200 470 L1200 900 L0 900 Z" fill="#7cc36a"/><path d="M0 620 Q300 560 600 610 T1200 590 L1200 900 L0 900 Z" fill="#5aa84f"/>${flowers}`,
  );
}

/** Named scenes used by the seed. */
export const scenes = {
  pier: () => sunset({ seed: 11 }),
  pierLate: () => sunset({ seed: 12, sky: ['#141e46', '#7b2d8b', '#f06a5f'], pier: true }),
  eagleLake: () => mountains({ seed: 21 }),
  ridge: () => mountains({ seed: 22, sky: ['#f6a96b', '#ffe3c2'], lake: false, peaks: ['#7a5c8e', '#5a4172', '#3b2a55'] }),
  summit: () => mountains({ seed: 23, sky: ['#4f9ee8', '#cfe9ff'], lake: false, peaks: ['#8fa4c4', '#61789d', '#3f5478'] }),
  lakeShore: () => mountains({ seed: 24, sky: ['#9ad0f5', '#fdf2e0'], lake: true, peaks: ['#6d86a8', '#4b6389', '#2f4466'] }),
  campfire: () => camping(),
  soccer1: () => soccer({ seed: 31 }),
  soccer2: () => soccer({ seed: 32 }),
  drawing: () => kidDrawing(),
  volcano: () => volcano(),
  cookies: () => cookies(),
  pancakes: () => pancakes(),
  garden: () => garden(),
};
