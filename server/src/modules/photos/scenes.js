// Procedural "photo" scenes for the demo seed — no network, no image libraries.
// Every scene is resolution independent (normalized coordinates), so the same seed renders
// the full-size image and its thumbnail identically.

const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Deterministic hash of integer coordinates → [0,1). */
function hash2(x, y, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Multi-stop vertical gradient: stops = [[t, '#hex'], ...]. */
function gradient(stops) {
  const s = stops.map(([t, c]) => [t, hex(c)]);
  return (t) => {
    if (t <= s[0][0]) return s[0][1];
    for (let i = 1; i < s.length; i++) {
      if (t <= s[i][0]) return mix(s[i - 1][1], s[i][1], (t - s[i - 1][0]) / (s[i][0] - s[i - 1][0]));
    }
    return s[s.length - 1][1];
  };
}

/** A smooth 1-D ridge function made of random sines: returns height in ~[-1,1]. */
function ridge(r, octaves = 5, base = 2) {
  const waves = Array.from({ length: octaves }, (_, i) => ({
    f: base * 2 ** i * (0.8 + r() * 0.5),
    p: r() * Math.PI * 2,
    a: 1 / 1.9 ** i,
  }));
  const norm = waves.reduce((s, w) => s + w.a, 0);
  // Pixels are rendered column by column, so caching the last value makes this ~free.
  let lastU = NaN;
  let lastV = 0;
  return (u) => {
    if (u === lastU) return lastV;
    let sum = 0;
    for (const w of waves) sum += Math.sin(u * w.f * Math.PI + w.p) * w.a;
    lastU = u;
    lastV = sum / norm;
    return lastV;
  };
}

/** Column height map of a row of pine trees (0..1 of image height). */
function pineline(r, w, { count, minH, maxH, base }) {
  const heights = new Float32Array(w);
  for (let x = 0; x < w; x++) heights[x] = base;
  for (let i = 0; i < count; i++) {
    const cx = r() * 1.1 - 0.05;
    const h = minH + r() * (maxH - minH);
    const halfW = h * (0.16 + r() * 0.06);
    for (let x = Math.max(0, Math.floor((cx - halfW) * w)); x < Math.min(w, Math.ceil((cx + halfW) * w)); x++) {
      const d = Math.abs(x / w - cx) / halfW;
      // jagged branch tiers
      const tier = 1 - d - 0.08 * Math.abs(Math.sin(d * 18 + i));
      const top = base + h * Math.max(0, tier);
      if (top > heights[x]) heights[x] = top;
    }
  }
  return heights;
}

// ---------------------------------------------------------------------------------------------
// Scenes: each returns (u, v, x, y) => [r,g,b] after a setup phase that knows the size.

const SCENES = {
  beach(p, w, h, r) {
    const sky = gradient(p.sky);
    const horizon = p.horizon ?? 0.56;
    const sea = gradient([[0, p.sea[0]], [1, p.sea[1]]]);
    const sun = { x: p.sunX ?? 0.5, y: p.sunY ?? horizon - 0.08, r: p.sunR ?? 0.07 };
    const sunCol = hex(p.sun ?? '#fff1c1');
    const sand = gradient([[0, p.sand[0]], [1, p.sand[1]]]);
    const shore = ridge(r, 3, 1.4);
    const aspect = w / h;
    const clouds = Array.from({ length: p.clouds ?? 5 }, () => ({ x: r(), y: 0.08 + r() * (horizon - 0.25), rx: 0.12 + r() * 0.18, ry: 0.015 + r() * 0.025 }));
    const cloudCol = hex(p.cloud ?? '#ffd6c2');
    return (u, v) => {
      const shoreY = 0.8 + shore(u) * 0.05;
      if (v > shoreY + 0.004) {
        const t = (v - shoreY) / (1 - shoreY);
        let c = sand(t);
        const wet = smooth(0.12, 0, t);
        c = mix(c, mix(c, hex(p.sea[1]), 0.35), wet);
        return c;
      }
      if (v > shoreY - 0.012) return mix(hex('#fffaf0'), sand(0), smooth(shoreY - 0.012, shoreY + 0.004, v) * 0.6);
      if (v > horizon) {
        const t = (v - horizon) / (shoreY - horizon);
        let c = sea(t);
        // sun glitter path
        const dx = Math.abs(u - sun.x) * aspect;
        const band = Math.sin(v * 900 + Math.sin(u * 60) * 2) * 0.5 + 0.5;
        const path = smooth(0.12 + t * 0.2, 0, dx) * band * (1 - t * 0.6);
        c = mix(c, sunCol, path * 0.75);
        // gentle wave lines
        const wave = Math.sin(v * 320 + Math.sin(u * 18 + v * 40) * 3) * 0.5 + 0.5;
        c = mix(c, hex('#ffffff'), wave * 0.06 * t);
        return c;
      }
      let c = sky(v / horizon);
      const d = Math.hypot((u - sun.x) * aspect, v - sun.y);
      c = mix(c, sunCol, smooth(sun.r * 4, 0, d) * 0.45);
      for (const cl of clouds) {
        if (Math.abs(v - cl.y) > cl.ry || Math.abs(u - cl.x) > cl.rx) continue;
        const e = ((u - cl.x) / cl.rx) ** 2 + ((v - cl.y) / cl.ry) ** 2;
        c = mix(c, cloudCol, smooth(1, 0.2, e) * 0.55);
      }
      c = mix(c, sunCol, smooth(sun.r + 0.004, sun.r - 0.002, d));
      return c;
    };
  },

  mountains(p, w, h, r) {
    const sky = gradient(p.sky);
    const layers = p.layers.map((col, i) => ({ col: hex(col), f: ridge(r, 6, 1.5 + i * 0.8), base: p.base[i], amp: p.amp[i] }));
    const aspect = w / h;
    const sun = p.sun ? { x: p.sun[0], y: p.sun[1], r: p.sun[2] } : null;
    const sunCol = hex(p.sunColor ?? '#fff4d6');
    const haze = hex(p.haze ?? p.sky[p.sky.length - 1][1]);
    const lake = p.lake ?? null;
    const render = (u, v) => {
      for (let i = layers.length - 1; i >= 0; i--) {
        const L = layers[i];
        const top = L.base - (L.f(u) * 0.5 + 0.5) * L.amp;
        if (v > top) {
          const depth = (v - top) / (1 - top);
          const c = mix(L.col, haze, (1 - i / layers.length) * 0.18 * (1 - depth));
          // snow caps on the farthest layer
          if (i === 0 && p.snow && v - top < 0.03 + 0.02 * Math.sin(u * 80)) return mix(c, hex('#f4f7ff'), 0.85);
          return mix(c, [0, 0, 0], depth * 0.12);
        }
      }
      let c = sky(v / (layers[0].base));
      if (sun) {
        const d = Math.hypot((u - sun.x) * aspect, v - sun.y);
        c = mix(c, sunCol, smooth(sun.r * 5, 0, d) * 0.5);
        c = mix(c, sunCol, smooth(sun.r + 0.003, sun.r - 0.002, d));
      }
      return c;
    };
    if (!lake) return render;
    return (u, v) => {
      if (v < lake) return render(u, v);
      const mirror = lake - (v - lake) * 1.1 + Math.sin(v * 400 + u * 30) * 0.002 * ((v - lake) * 20);
      const c = render(u, Math.max(0, mirror));
      return mix(mix(c, hex(p.water ?? '#1d3b5a'), 0.35), [255, 255, 255], Math.sin(v * 700) > 0.96 ? 0.08 : 0);
    };
  },

  forest(p, w, h, r) {
    const sky = gradient(p.sky);
    const far = ridge(r, 5, 1.2);
    const rows = p.rows.map((col, i) => ({
      col: hex(col),
      map: pineline(r, w, { count: 22 + i * 8, minH: 0.18 + i * 0.05, maxH: 0.34 + i * 0.1, base: p.bases[i] }),
    }));
    const farCol = hex(p.far);
    const aspect = w / h;
    const fog = hex(p.fog ?? '#dfe8e4');
    return (u, v, x) => {
      const yUp = 1 - v;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (yUp < rows[i].map[x]) return mix(rows[i].col, fog, (1 - (i + 1) / rows.length) * 0.35);
      }
      const farTop = 0.55 - (far(u) * 0.5 + 0.5) * 0.18;
      if (v > farTop) return mix(farCol, fog, 0.25);
      let c = sky(v / 0.6);
      if (p.sun) {
        const d = Math.hypot((u - p.sun[0]) * aspect, v - p.sun[1]);
        c = mix(c, hex('#fff2cc'), smooth(0.35, 0, d) * 0.55);
      }
      return c;
    };
  },

  party(p, w, h, r) {
    const bg = gradient(p.bg);
    const aspect = w / h;
    const bokeh = Array.from({ length: 26 }, () => ({ x: r(), y: r(), rad: 0.03 + r() * 0.08, col: hex(p.bokeh[Math.floor(r() * p.bokeh.length)]), a: 0.18 + r() * 0.3 }));
    const balloons = Array.from({ length: p.balloons ?? 6 }, (_, i) => ({
      x: 0.1 + (i / (p.balloons ?? 6)) * 0.85 + (r() - 0.5) * 0.08,
      y: 0.18 + r() * 0.3,
      rx: 0.055 + r() * 0.02,
      col: hex(p.balloon[i % p.balloon.length]),
    }));
    const confetti = Array.from({ length: 90 }, () => {
      const a = r() * Math.PI;
      return { x: r(), y: r(), s: 0.004 + r() * 0.006, cos: Math.cos(a), sin: Math.sin(a), col: hex(p.confetti[Math.floor(r() * p.confetti.length)]) };
    });
    const table = p.table ? hex(p.table) : null;
    return (u, v) => {
      let c = bg(v);
      for (const b of bokeh) {
        if (Math.abs(v - b.y) > b.rad || Math.abs(u - b.x) * aspect > b.rad) continue;
        const d = Math.hypot((u - b.x) * aspect, v - b.y);
        c = mix(c, b.col, smooth(b.rad, b.rad * 0.85, d) * b.a);
      }
      if (table && v > 0.78) {
        c = mix(table, [0, 0, 0], (v - 0.78) * 0.8);
        // cake
        const cx = 0.5;
        if (Math.abs(u - cx) * aspect < 0.13 && v < 0.86) c = mix(hex('#fff4e8'), hex('#f7c6d9'), v > 0.82 ? 1 : 0);
      }
      if (table && Math.abs(u - 0.5) * aspect < 0.13 && v > 0.7 && v <= 0.78) {
        c = mix(hex('#fde2ec'), hex('#f59ac0'), smooth(0.7, 0.78, v));
        if (Math.abs(v - 0.735) < 0.008) c = hex('#ffffff');
      }
      {
        for (let k = -2; table && v > 0.58 && v < 0.72 && k <= 2; k++) {
          const cxk = 0.5 + (k * 0.045) / aspect;
          if (Math.abs(u - cxk) * aspect < 0.006 && v > 0.63 && v < 0.7) c = hex(p.balloon[(k + 5) % p.balloon.length]);
          const fd = Math.hypot((u - cxk) * aspect * 1.6, v - 0.615);
          c = mix(c, hex('#ffd35c'), smooth(0.016, 0.006, fd));
          c = mix(c, hex('#fff6d8'), smooth(0.007, 0.002, fd));
        }
      }
      for (const b of balloons) {
        const ry = b.rx * 1.25;
        if (Math.abs(u - b.x) * aspect > b.rx * 1.1 || v < b.y - ry * 1.1 || v > b.y + ry + 0.3) continue;
        const dx = ((u - b.x) * aspect) / b.rx;
        const dy = (v - b.y) / ry;
        const e = dx * dx + dy * dy;
        if (Math.abs((u - b.x) * aspect + Math.sin(v * 30) * 0.004) < 0.0025 && v > b.y + ry && v < b.y + ry + 0.28) c = mix(c, hex('#ffffff'), 0.7);
        if (e < 1.02) {
          const shade = mix(b.col, [0, 0, 0], clamp((dx + dy) * 0.18 + 0.1));
          const hi = smooth(0.35, 0, Math.hypot(dx + 0.4, dy + 0.45));
          c = mix(c, mix(shade, [255, 255, 255], hi * 0.7), smooth(1.02, 0.96, e));
        }
      }
      for (const f of confetti) {
        const dy = v - f.y;
        if (dy > f.s || dy < -f.s) continue;
        const dx = (u - f.x) * aspect;
        if (dx > f.s || dx < -f.s) continue;
        const rx = dx * f.cos - dy * f.sin;
        const ry = dx * f.sin + dy * f.cos;
        if (Math.abs(rx) < f.s && Math.abs(ry) < f.s * 0.45) c = f.col;
      }
      return c;
    };
  },

  city(p, w, h, r) {
    const sky = gradient(p.sky);
    const aspect = w / h;
    const cols = [];
    let x = 0;
    while (x < 1.05) {
      const bw = 0.03 + r() * 0.07;
      cols.push({ x0: x, x1: x + bw, top: 0.35 + r() * 0.4, hue: r() });
      x += bw + r() * 0.006;
    }
    const moon = p.moon ?? [0.78, 0.18, 0.05];
    const back = ridge(r, 4, 3);
    let lastU = NaN;
    let b = null;
    return (u, v) => {
      if (u !== lastU) {
        lastU = u;
        b = cols.find((c) => u >= c.x0 && u < c.x1);
      }
      if (b && v > b.top) {
        let c = mix(hex(p.building[0]), hex(p.building[1]), b.hue);
        const wx = Math.floor(((u - b.x0) / (b.x1 - b.x0)) * 6);
        const wy = Math.floor((v - b.top) * 70);
        const inX = ((u - b.x0) / (b.x1 - b.x0)) * 6 - wx;
        const inY = (v - b.top) * 70 - wy;
        if (inX > 0.25 && inX < 0.75 && inY > 0.3 && inY < 0.75 && wy > 0) {
          const lit = hash2(wx + Math.floor(b.x0 * 1000), wy, 7);
          if (lit > 0.45) c = mix(hex(p.window[0]), hex(p.window[1]), hash2(wx, wy, 3));
        }
        return c;
      }
      const backTop = 0.62 - (back(u) * 0.5 + 0.5) * 0.14;
      if (v > backTop) return mix(hex(p.building[0]), sky(1), 0.45);
      let c = sky(v / 0.8);
      const d = Math.hypot((u - moon[0]) * aspect, v - moon[1]);
      c = mix(c, hex('#dfe6ff'), smooth(moon[2] * 5, 0, d) * 0.3);
      c = mix(c, hex('#fbf6e6'), smooth(moon[2] + 0.003, moon[2] - 0.002, d));
      const star = hash2(Math.floor(u * 400), Math.floor(v * 400 / aspect), 11);
      if (star > 0.9965 && v < 0.55) c = mix(c, [255, 255, 255], 0.6 + (star - 0.9965) * 100);
      return c;
    };
  },

  meadow(p, w, h, r) {
    const sky = gradient(p.sky);
    const hills = p.hills.map((col, i) => ({ col: hex(col), f: ridge(r, 3, 0.8 + i * 0.4), base: 0.5 + i * 0.12, amp: 0.1 - i * 0.015 }));
    const clouds = Array.from({ length: 7 }, () => ({ x: r(), y: 0.08 + r() * 0.25, rx: 0.08 + r() * 0.12, ry: 0.03 + r() * 0.03 }));
    const flowers = p.flowers.map(hex);
    const aspect = w / h;
    return (u, v) => {
      for (let i = hills.length - 1; i >= 0; i--) {
        const H = hills[i];
        const top = H.base - (H.f(u) * 0.5 + 0.5) * H.amp;
        if (v > top) {
          let c = mix(H.col, [0, 0, 0], (v - top) * 0.35);
          if (i === hills.length - 1) {
            // flowers get bigger towards the viewer
            const depth = (v - top) / (1 - top);
            const cell = 9 + (1 - depth) * 40;
            const gx = Math.floor(u * cell * aspect);
            const gy = Math.floor(v * cell);
            const hsh = hash2(gx, gy, 5);
            if (hsh > 0.72) {
              const fx = (u * cell * aspect - gx) - 0.5;
              const fy = (v * cell - gy) - 0.5;
              const rr = 0.18 + depth * 0.18;
              const d = Math.hypot(fx, fy);
              if (d < rr) c = d < rr * 0.35 ? hex('#ffe066') : flowers[Math.floor(hsh * 997) % flowers.length];
            }
          }
          return c;
        }
      }
      let c = sky(v / 0.55);
      for (const cl of clouds) {
        if (Math.abs(v - cl.y) > cl.ry * 1.05 || Math.abs(u - cl.x) > cl.rx * 1.05) continue;
        const e = ((u - cl.x) / cl.rx) ** 2 + ((v - cl.y) / cl.ry) ** 2;
        c = mix(c, [255, 255, 255], smooth(1.1, 0.3, e) * 0.85);
      }
      return c;
    };
  },

  aurora(p, w, h, r) {
    const sky = gradient(p.sky);
    const aspect = w / h;
    const mtn = ridge(r, 6, 1.6);
    const bands = [ridge(r, 3, 1.2), ridge(r, 3, 1.2)];
    const lake = 0.72;
    const render = (u, v) => {
      const top = 0.6 - (mtn(u) * 0.5 + 0.5) * 0.16;
      if (v > top) return mix(hex('#0b1320'), hex('#1b2735'), (v - top) * 3);
      let c = sky(v / 0.7);
      const star = hash2(Math.floor(u * 500), Math.floor((v * 500) / aspect), 21);
      if (star > 0.996) c = mix(c, [255, 255, 255], 0.75);
      for (let k = 0; k < 2; k++) {
        const center = 0.26 + k * 0.12 + bands[k](u) * 0.1;
        const dist = v - center;
        const spread = dist < 0 ? 3.2 : 11;
        const rays = 0.8 + 0.2 * Math.sin(u * 260 + Math.sin(u * 31) * 4);
        const curtain = Math.exp(-((dist * spread) ** 2)) * (0.65 + 0.35 * Math.sin(u * 7 + k * 2.3)) * rays;
        const col = k ? hex(p.aurora[1]) : hex(p.aurora[0]);
        c = mix(c, col, clamp(curtain * (dist < 0 ? 1 : 0.6)) * 0.85);
      }
      return c;
    };
    return (u, v) => {
      if (v < lake) return render(u, v);
      const m = lake - (v - lake) * 1.3 + Math.sin(v * 500 + u * 40) * 0.003;
      return mix(render(u, Math.max(0, m)), hex('#06101c'), 0.45);
    };
  },

  snow(p, w, h, r) {
    const sky = gradient(p.sky);
    const hill = ridge(r, 3, 0.9);
    const trees = pineline(r, w, { count: 18, minH: 0.2, maxH: 0.42, base: 0.24 });
    const aspect = w / h;
    return (u, v, x) => {
      const yUp = 1 - v;
      const hillTop = 0.62 - (hill(u) * 0.5 + 0.5) * 0.12;
      let c;
      if (yUp < trees[x] && yUp > 0.24) {
        const snowy = Math.sin((yUp - 0.24) * 75) > 0.8 || yUp > trees[x] - 0.012;
        c = snowy ? hex('#e9f0f7') : hex(p.tree);
      } else if (v > hillTop) {
        c = mix(hex('#ffffff'), hex('#cfdced'), smooth(hillTop, 1, v) * 0.7 + Math.sin(u * 12 + v * 20) * 0.04);
      } else {
        c = sky(v / 0.62);
        if (p.sun) {
          const d = Math.hypot((u - p.sun[0]) * aspect, v - p.sun[1]);
          c = mix(c, hex('#fff5e0'), smooth(0.3, 0, d) * 0.6);
        }
      }
      const flake = hash2(Math.floor(u * 160 * aspect), Math.floor(v * 160), 31);
      if (flake > 0.985) {
        const fx = (u * 160 * aspect) % 1 - 0.5;
        const fy = (v * 160) % 1 - 0.5;
        if (Math.hypot(fx, fy) < 0.22) c = mix(c, [255, 255, 255], 0.85);
      }
      return c;
    };
  },
};

/** Render a scene into an RGB buffer, with a soft vignette. */
export function renderScene(kind, params, width, height, seed = 1) {
  const r = rng(seed);
  const shade = SCENES[kind](params, width, height, r);
  const out = Buffer.alloc(width * height * 3);
  const vig = params.vignette ?? 0.22;
  for (let x = 0; x < width; x++) {
    const u = (x + 0.5) / width;
    for (let y = 0; y < height; y++) {
      const v = (y + 0.5) / height;
      const c = shade(u, v, x, y);
      const d = Math.hypot(u - 0.5, v - 0.5) / 0.7071;
      const k = 1 - vig * smooth(0.45, 1, d);
      const o = (y * width + x) * 3;
      out[o] = clamp(c[0] * k, 0, 255);
      out[o + 1] = clamp(c[1] * k, 0, 255);
      out[o + 2] = clamp(c[2] * k, 0, 255);
    }
  }
  return out;
}

// Palettes for the demo seed ---------------------------------------------------------------------
export const PRESETS = {
  sunsetBeach: ['beach', { sky: [[0, '#2b2d6e'], [0.45, '#b4508a'], [0.8, '#f68b5a'], [1, '#ffd08a']], sea: ['#e08a6d', '#2f4d7a'], sand: ['#f1cf9f', '#d9a86c'], sunY: 0.46, sunX: 0.62, sun: '#fff0c4', cloud: '#ffb49a' }],
  noonBeach: ['beach', { sky: [[0, '#2f8fe0'], [0.7, '#8fd0f5'], [1, '#d8f1ff']], sea: ['#39b6c9', '#12628a'], sand: ['#f6e3bd', '#e8c68d'], sunY: 0.12, sunX: 0.2, sunR: 0.05, sun: '#fffbe8', cloud: '#ffffff', clouds: 6 }],
  goldenBeach: ['beach', { sky: [[0, '#ffb86b'], [0.6, '#ffd89a'], [1, '#fff1cf']], sea: ['#f4b979', '#5b7fa5'], sand: ['#f2d6a8', '#cf9d62'], horizon: 0.5, sunY: 0.43, sunX: 0.35, sunR: 0.06, sun: '#fff7df', cloud: '#fff0dc' }],
  duskBeach: ['beach', { sky: [[0, '#141c3a'], [0.5, '#4d3f7a'], [0.85, '#d1708a'], [1, '#f7b28c']], sea: ['#9a6d8f', '#1d2c50'], sand: ['#cfae92', '#9c7b64'], sunY: 0.58, sunX: 0.5, sunR: 0.09, sun: '#ffcf9e', cloud: '#e3899a', horizon: 0.6 }],
  alpine: ['mountains', { sky: [[0, '#3a7bd5'], [1, '#bfe3ff']], layers: ['#8aa4c8', '#5d7aa6', '#3d5a80', '#223a57'], base: [0.55, 0.66, 0.78, 0.92], amp: [0.32, 0.26, 0.22, 0.2], snow: true, sun: [0.8, 0.14, 0.04], haze: '#dbeeff' }],
  autumnRidge: ['mountains', { sky: [[0, '#f7a35c'], [0.6, '#fcd59a'], [1, '#fff0d6']], layers: ['#c88a7a', '#a4553f', '#7a3526', '#4a1f17'], base: [0.55, 0.68, 0.8, 0.93], amp: [0.25, 0.22, 0.2, 0.18], sun: [0.3, 0.3, 0.05], sunColor: '#fff8e0', haze: '#ffe7c2' }],
  blueRidge: ['mountains', { sky: [[0, '#7aa7d9'], [1, '#f1f4f9']], layers: ['#a9bcd6', '#8199bd', '#5b739b', '#384d73', '#1f2d4a'], base: [0.5, 0.6, 0.7, 0.8, 0.92], amp: [0.18, 0.18, 0.17, 0.16, 0.15], haze: '#eef3fa' }],
  lakeMirror: ['mountains', { sky: [[0, '#5b86e5'], [1, '#e9d6f2']], layers: ['#9aa7cf', '#6b78a8', '#3f4a78'], base: [0.45, 0.53, 0.6], amp: [0.25, 0.2, 0.14], snow: true, lake: 0.6, water: '#28406b', sun: [0.25, 0.12, 0.035] }],
  pineForest: ['forest', { sky: [[0, '#6fb1e3'], [1, '#e6f3f2']], far: '#7fa7a0', rows: ['#4f7d67', '#2f5a45', '#1a3b2c'], bases: [0.3, 0.16, 0.0], sun: [0.75, 0.12], fog: '#d9ebe6' }],
  autumnForest: ['forest', { sky: [[0, '#f0a868'], [1, '#fde8c8']], far: '#c07a5a', rows: ['#b3542c', '#7d3317', '#4a1d0e'], bases: [0.3, 0.15, 0.0], sun: [0.3, 0.2], fog: '#f7d7b6' }],
  mistyForest: ['forest', { sky: [[0, '#9fb3c2'], [1, '#e5ecef']], far: '#9fb0b3', rows: ['#6b8480', '#3f5754', '#22332f'], bases: [0.32, 0.17, 0.0], fog: '#e3e9ea' }],
  party: ['party', { bg: [[0, '#3b1f5e'], [0.6, '#8e3c7a'], [1, '#e6739f']], bokeh: ['#ffd36e', '#ff8fb1', '#8fd3ff', '#ffffff'], balloon: ['#ff5d8f', '#ffd166', '#06d6a0', '#4cc9f0', '#b388ff'], confetti: ['#ffd166', '#ff5d8f', '#4cc9f0', '#06d6a0', '#ffffff'], table: '#5a2d4a' }],
  partyBright: ['party', { bg: [[0, '#ffe6f0'], [0.7, '#ffc2d8'], [1, '#ff9ec0']], bokeh: ['#ffffff', '#ffe29a', '#ffb3cf'], balloon: ['#ff4f8b', '#ffb703', '#8ecae6', '#90be6d', '#c77dff'], confetti: ['#ff4f8b', '#ffb703', '#219ebc', '#90be6d'], balloons: 7 }],
  partyNight: ['party', { bg: [[0, '#101a3a'], [0.7, '#27306a'], [1, '#4b3b8f']], bokeh: ['#ffd36e', '#7ae0ff', '#ff9ad5'], balloon: ['#ffd166', '#ef476f', '#06d6a0', '#118ab2'], confetti: ['#ffd166', '#ef476f', '#06d6a0', '#ffffff'], table: '#2a2350', balloons: 5 }],
  cityNight: ['city', { sky: [[0, '#0b1030'], [0.6, '#2b2466'], [1, '#6a3d7a']], building: ['#12142b', '#1d1f3d'], window: ['#ffd27a', '#fff1c4'] }],
  cityDusk: ['city', { sky: [[0, '#243b73'], [0.6, '#b35f86'], [1, '#f6a57a']], building: ['#1b1e33', '#2b2d4a'], window: ['#ffcf73', '#ffe9b0'], moon: [0.2, 0.2, 0.035] }],
  springMeadow: ['meadow', { sky: [[0, '#4aa3f0'], [1, '#d4efff']], hills: ['#9fd07a', '#6fb655', '#4e9a3f'], flowers: ['#ff6b8b', '#ffffff', '#b388ff', '#ff9f43'] }],
  goldenMeadow: ['meadow', { sky: [[0, '#f5a860'], [1, '#fff0cf']], hills: ['#c8b25a', '#a58f3a', '#7f6a24'], flowers: ['#fff3c4', '#ff9e7a', '#ffffff'] }],
  aurora: ['aurora', { sky: [[0, '#040814'], [0.7, '#0f2440'], [1, '#1c3656']], aurora: ['#3dffb0', '#9b6bff'] }],
  winter: ['snow', { sky: [[0, '#8fb8e8'], [1, '#eaf2fb']], tree: '#2e4a3f', sun: [0.7, 0.2] }],
  winterDusk: ['snow', { sky: [[0, '#4a4f8c'], [0.7, '#e3a7b8'], [1, '#fbd9c8']], tree: '#26304a', sun: [0.3, 0.45] }],
};

/** Box-filter downscale of an RGB buffer (used for seed thumbnails). */
export function downscale(rgb, w, h, tw, th) {
  const out = Buffer.alloc(tw * th * 3);
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * h) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / th));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * w) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / tw));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * w + x) * 3;
          r += rgb[o];
          g += rgb[o + 1];
          b += rgb[o + 2];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (ty * tw + tx) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
    }
  }
  return out;
}
