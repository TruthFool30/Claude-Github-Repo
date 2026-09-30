// Procedural top-down "food photo" illustrations (SVG) for demo recipes. No network, deterministic.

function rng(seed) {
  let s = 0;
  for (const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const f = (n) => Math.round(n * 10) / 10;

/** Points evenly-ish scattered inside a circle. */
function scatter(r, count, radius, cx = 400, cy = 300) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * radius;
    pts.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d, r()]);
  }
  return pts;
}

function leaf(x, y, len, rot, fill) {
  return `<path d="M0 0 C ${f(len * 0.35)} ${f(-len * 0.32)} ${f(len * 0.75)} ${f(-len * 0.25)} ${f(len)} 0 C ${f(len * 0.75)} ${f(len * 0.25)} ${f(len * 0.35)} ${f(len * 0.32)} 0 0 Z" fill="${fill}" transform="translate(${f(x)} ${f(y)}) rotate(${f(rot)})"/>`;
}

const FOOD = {
  pasta(r) {
    let s = '<circle cx="400" cy="300" r="150" fill="#f3c969"/>';
    for (let i = 0; i < 70; i++) {
      const [x, y] = scatter(r, 1, 135)[0];
      const len = 40 + r() * 70;
      const rot = r() * 360;
      s += `<path d="M0 0 q ${f(len / 4)} -14 ${f(len / 2)} 0 t ${f(len / 2)} 0" stroke="${r() > 0.5 ? '#e9b949' : '#f8d98a'}" stroke-width="7" fill="none" stroke-linecap="round" transform="translate(${f(x - len / 2)} ${f(y)}) rotate(${f(rot)} ${f(len / 2)} 0)"/>`;
    }
    s += '<path d="M330 250 C 360 205 450 210 470 255 C 500 300 460 360 405 355 C 345 350 305 300 330 250 Z" fill="#c8361f" opacity="0.92"/>';
    for (const [x, y] of scatter(r, 14, 70, 400, 285)) s += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(5 + r() * 5)}" fill="#8f2413" opacity="0.6"/>`;
    for (let i = 0; i < 5; i++) s += leaf(360 + r() * 90, 250 + r() * 80, 34 + r() * 10, r() * 360, '#3f8f3a');
    for (const [x, y] of scatter(r, 40, 120)) s += `<rect x="${f(x)}" y="${f(y)}" width="5" height="3" fill="#fff8e1" transform="rotate(${f(r() * 90)} ${f(x)} ${f(y)})"/>`;
    return s;
  },
  salad(r) {
    let s = '<circle cx="400" cy="300" r="155" fill="#6fae4f"/>';
    const greens = ['#4f9a3a', '#7cc35a', '#9ad46b', '#3b7f2c', '#b5de84'];
    for (let i = 0; i < 60; i++) {
      const [x, y] = scatter(r, 1, 130)[0];
      s += leaf(x - 25, y, 50 + r() * 30, r() * 360, greens[Math.floor(r() * greens.length)]);
    }
    for (const [x, y] of scatter(r, 9, 115)) s += `<circle cx="${f(x)}" cy="${f(y)}" r="17" fill="#e5484d"/><circle cx="${f(x - 5)}" cy="${f(y - 6)}" r="5" fill="#ff9a9d" opacity="0.8"/>`;
    for (const [x, y, k] of scatter(r, 14, 120)) s += `<rect x="${f(x)}" y="${f(y)}" width="18" height="16" rx="3" fill="#fbf7ee" transform="rotate(${f(k * 60)} ${f(x)} ${f(y)})"/>`;
    for (const [x, y] of scatter(r, 8, 110)) s += `<ellipse cx="${f(x)}" cy="${f(y)}" rx="11" ry="7" fill="#2b2233"/>`;
    for (let i = 0; i < 4; i++) s += `<path d="M${f(300 + r() * 60)} ${f(230 + r() * 140)} q 60 -40 ${f(120 + r() * 60)} 0" stroke="#8e4ec6" stroke-width="6" fill="none" opacity="0.8" stroke-linecap="round"/>`;
    return s;
  },
  bowl(r, o = {}) {
    const sauce = o.sauce ?? '#e39b2e';
    let s = `<circle cx="400" cy="300" r="158" fill="${sauce}"/><circle cx="400" cy="300" r="158" fill="url(#sheen)"/>`;
    s += `<path d="M300 300 A 100 100 0 0 1 400 200 L 400 300 Z" fill="#f7f1e3"/>`;
    for (const [x, y] of scatter(r, 60, 50, 360, 255)) s += `<ellipse cx="${f(x)}" cy="${f(y)}" rx="6" ry="3.5" fill="#fffdf6" transform="rotate(${f(r() * 180)} ${f(x)} ${f(y)})"/>`;
    for (const [x, y, k] of scatter(r, 16, 110, 420, 320)) s += `<rect x="${f(x)}" y="${f(y)}" width="${f(22 + k * 10)}" height="20" rx="7" fill="${o.chunk ?? '#f2d0a0'}" transform="rotate(${f(k * 120)} ${f(x)} ${f(y)})"/>`;
    for (const [x, y] of scatter(r, 10, 120, 420, 320)) s += `<circle cx="${f(x)}" cy="${f(y)}" r="9" fill="${o.veg ?? '#30a46c'}"/>`;
    for (let i = 0; i < 9; i++) s += leaf(330 + r() * 150, 230 + r() * 150, 18 + r() * 8, r() * 360, '#2f8f4e');
    for (const [x, y] of scatter(r, 30, 140)) s += `<circle cx="${f(x)}" cy="${f(y)}" r="2" fill="#7a2b12" opacity="0.6"/>`;
    return s;
  },
  tacos(r) {
    let s = '';
    const shells = [[330, 270, -24], [470, 265, 22], [400, 360, 0]];
    for (const [x, y, rot] of shells) {
      s += `<g transform="translate(${x} ${y}) rotate(${rot})">`;
      s += '<path d="M-95 20 A 95 95 0 0 1 95 20 Z" fill="#f2c26b"/>';
      s += '<path d="M-80 18 A 80 70 0 0 1 80 18 Z" fill="#7d3d1f"/>';
      for (let i = 0; i < 14; i++) s += `<rect x="${f(-70 + r() * 130)}" y="${f(-35 + r() * 45)}" width="14" height="10" rx="3" fill="${['#e5484d', '#fbd46d', '#fff'][i % 3]}" transform="rotate(${f(r() * 90)})"/>`;
      for (let i = 0; i < 12; i++) s += leaf(-70 + r() * 120, -30 + r() * 40, 18, r() * 360, '#52a447');
      s += '<path d="M-95 20 A 95 95 0 0 1 95 20" stroke="#dca24a" stroke-width="6" fill="none"/></g>';
    }
    s += '<circle cx="520" cy="385" r="32" fill="#9ccb4a"/><circle cx="520" cy="385" r="26" fill="#c9e58a"/>';
    for (let i = 0; i < 8; i++) s += `<line x1="520" y1="385" x2="${f(520 + Math.cos((i * Math.PI) / 4) * 25)}" y2="${f(385 + Math.sin((i * Math.PI) / 4) * 25)}" stroke="#9ccb4a" stroke-width="2"/>`;
    return s;
  },
  pancakes(r) {
    let s = '';
    for (let i = 0; i < 4; i++) s += `<circle cx="${400 - i * 4}" cy="${310 - i * 9}" r="135" fill="${i % 2 ? '#e3a44a' : '#d7913a'}"/>`;
    s += '<circle cx="388" cy="283" r="128" fill="#efb85c"/><circle cx="388" cy="283" r="128" fill="url(#sheen)"/>';
    s += '<path d="M300 240 C 330 200 430 190 470 240 C 500 280 460 330 420 320 C 400 360 330 350 320 310 C 280 300 280 265 300 240 Z" fill="#a8551b" opacity="0.75"/>';
    s += '<rect x="360" y="255" width="46" height="34" rx="6" fill="#fff3c4"/><rect x="364" y="258" width="38" height="10" rx="4" fill="#fffbe6"/>';
    for (const [x, y] of scatter(r, 12, 110, 400, 300)) s += `<circle cx="${f(x)}" cy="${f(y)}" r="12" fill="#3e4aa8"/><circle cx="${f(x - 3)}" cy="${f(y - 4)}" r="3.5" fill="#8f9af0"/>`;
    for (const [x, y] of scatter(r, 6, 120, 400, 300)) s += `<path d="M${f(x)} ${f(y)} q 12 -22 24 0 q -12 26 -24 0 Z" fill="#e5484d"/>`;
    for (let i = 0; i < 4; i++) s += leaf(430 + r() * 30, 220 + r() * 30, 22, r() * 360, '#3f8f3a');
    return s;
  },
  pizza(r) {
    let s = '<circle cx="400" cy="300" r="168" fill="#d9a05b"/><circle cx="400" cy="300" r="148" fill="#c8361f"/>';
    for (const [x, y] of scatter(r, 26, 125)) s += `<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(26 + r() * 16)}" ry="${f(20 + r() * 12)}" fill="#fff4d6" opacity="0.95"/>`;
    for (const [x, y] of scatter(r, 12, 115)) s += `<circle cx="${f(x)}" cy="${f(y)}" r="18" fill="#a32a1c"/><circle cx="${f(x - 4)}" cy="${f(y - 5)}" r="4" fill="#d9543f" opacity="0.8"/>`;
    for (let i = 0; i < 12; i++) s += leaf(300 + r() * 200, 200 + r() * 200, 26, r() * 360, '#2f8f4e');
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      s += `<line x1="400" y1="300" x2="${f(400 + Math.cos(a) * 168)}" y2="${f(300 + Math.sin(a) * 168)}" stroke="#8a4b1b" stroke-width="3" opacity="0.35"/>`;
    }
    return s;
  },
  salmon(r) {
    let s = '';
    for (let i = 0; i < 7; i++) s += `<rect x="${f(290 + i * 12)}" y="${f(330 + r() * 10)}" width="190" height="14" rx="7" fill="${i % 2 ? '#4f9a3a' : '#62b04b'}" transform="rotate(${f(-18 + r() * 8)} 400 340)"/>`;
    s += '<g transform="translate(400 262) rotate(-8)"><rect x="-115" y="-58" width="230" height="116" rx="40" fill="#f08a5d"/>';
    for (let i = -3; i <= 3; i++) s += `<path d="M${i * 30 - 12} -52 q 22 52 0 104" stroke="#ffc3a3" stroke-width="7" fill="none" opacity="0.85"/>`;
    s += '<rect x="-115" y="-58" width="230" height="30" rx="15" fill="#c9582b" opacity="0.55"/></g>';
    s += '<circle cx="505" cy="360" r="38" fill="#f5d04a"/><circle cx="505" cy="360" r="31" fill="#fbe98a"/>';
    for (let i = 0; i < 8; i++) s += `<line x1="505" y1="360" x2="${f(505 + Math.cos((i * Math.PI) / 4) * 30)}" y2="${f(360 + Math.sin((i * Math.PI) / 4) * 30)}" stroke="#f5d04a" stroke-width="2.5"/>`;
    for (const [x, y] of scatter(r, 18, 70, 330, 380)) s += `<circle cx="${f(x)}" cy="${f(y)}" r="9" fill="#f3e3c3"/>`;
    for (let i = 0; i < 6; i++) s += leaf(360 + r() * 90, 230 + r() * 50, 16, r() * 360, '#2f7f3e');
    return s;
  },
  stirfry(r) {
    let s = '<circle cx="400" cy="300" r="155" fill="#c98b3a"/>';
    for (let i = 0; i < 60; i++) {
      const [x, y] = scatter(r, 1, 130)[0];
      const len = 50 + r() * 60;
      s += `<path d="M0 0 q ${f(len / 4)} -10 ${f(len / 2)} 0 t ${f(len / 2)} 0" stroke="${r() > 0.5 ? '#d9a456' : '#b8792c'}" stroke-width="6" fill="none" stroke-linecap="round" transform="translate(${f(x - len / 2)} ${f(y)}) rotate(${f(r() * 360)} ${f(len / 2)} 0)"/>`;
    }
    const veg = ['#e5484d', '#ffb224', '#30a46c', '#f76b15'];
    for (const [x, y, k] of scatter(r, 22, 120)) s += `<rect x="${f(x)}" y="${f(y)}" width="${f(26 + k * 14)}" height="12" rx="5" fill="${veg[Math.floor(k * 4)]}" transform="rotate(${f(r() * 180)} ${f(x)} ${f(y)})"/>`;
    for (const [x, y] of scatter(r, 10, 110)) s += `<circle cx="${f(x)}" cy="${f(y)}" r="14" fill="#2f8f3a"/><circle cx="${f(x)}" cy="${f(y)}" r="8" fill="#56b35a"/>`;
    for (const [x, y] of scatter(r, 50, 140)) s += `<ellipse cx="${f(x)}" cy="${f(y)}" rx="3" ry="2" fill="#fff8e1"/>`;
    return s;
  },
};

/**
 * SVG buffer for a recipe illustration.
 *   kind: pasta | salad | bowl | tacos | pancakes | pizza | salmon | stirfry
 *   table: background color, cloth: napkin color
 */
export function foodSvg({ kind = 'bowl', seed = kind, table = '#e9dcc9', cloth = '#5b5bd6', sauce, chunk, veg } = {}) {
  const r = rng(seed);
  const food = (FOOD[kind] ?? FOOD.bowl)(r, { sauce, chunk, veg });
  let grain = '';
  for (let i = 0; i < 26; i++) {
    const y = f(r() * 600);
    grain += `<path d="M0 ${y} C 200 ${f(y + (r() - 0.5) * 30)} 600 ${f(y + (r() - 0.5) * 30)} 800 ${y}" stroke="#000" stroke-opacity="${f(0.02 + r() * 0.04) / 1}" stroke-width="${f(1 + r() * 3)}" fill="none"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600">
<defs>
<linearGradient id="table" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${table}"/><stop offset="1" stop-color="${table}" stop-opacity="0.82"/></linearGradient>
<radialGradient id="light" cx="0.35" cy="0.25" r="0.9"><stop offset="0" stop-color="#fff" stop-opacity="0.35"/><stop offset="1" stop-color="#000" stop-opacity="0.18"/></radialGradient>
<radialGradient id="sheen" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="#fff" stop-opacity="0.28"/><stop offset="0.6" stop-color="#fff" stop-opacity="0"/></radialGradient>
<filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="10" dy="16" stdDeviation="14" flood-color="#2a1a0a" flood-opacity="0.28"/></filter>
<clipPath id="plate"><circle cx="400" cy="300" r="180"/></clipPath>
</defs>
<rect width="800" height="600" fill="#1a1b26"/>
<rect width="800" height="600" fill="url(#table)"/>
${grain}
<g transform="rotate(-14 90 520)" filter="url(#shadow)"><rect x="-40" y="400" width="250" height="250" rx="14" fill="${cloth}"/>
<path d="M-40 440 H210 M-40 470 H210 M-40 600 H210" stroke="#fff" stroke-opacity="0.25" stroke-width="6"/></g>
<g filter="url(#shadow)"><rect x="660" y="120" width="18" height="330" rx="9" fill="#c9ccd6"/><rect x="700" y="120" width="16" height="330" rx="8" fill="#c9ccd6"/>
<rect x="656" y="120" width="26" height="90" rx="6" fill="#dfe2ea"/></g>
<circle cx="400" cy="300" r="222" fill="#fbfbfd" filter="url(#shadow)"/>
<circle cx="400" cy="300" r="190" fill="none" stroke="#e7e8ef" stroke-width="3"/>
<g clip-path="url(#plate)">${food}</g>
<circle cx="400" cy="300" r="222" fill="none" stroke="#fff" stroke-opacity="0.8" stroke-width="2"/>
<rect width="800" height="600" fill="url(#light)"/>
</svg>`;
  return Buffer.from(svg);
}
