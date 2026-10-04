/** Color helpers for putting text on member/module colors with WCAG AA contrast. */

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colors (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Mix a hex color toward black: k=1 unchanged, k=0.8 = 20% darker. */
export function darken(hex: string, k: number): string {
  return '#' + rgb(hex).map((v) => Math.round(v * k).toString(16).padStart(2, '0')).join('');
}

const DARK_TEXT = '#1a1b26';
const cache = new Map<string, { bg: string; fg: string }>();

/**
 * Background + text color pair with ≥4.5:1 contrast for text on a member/module color.
 * Keeps white text by darkening the color slightly when that is enough (≤20%), otherwise uses
 * dark text on the original color (e.g. yellow/orange).
 *   const { bg, fg } = readableOn(member.color);
 */
export function readableOn(color: string | null | undefined): { bg: string; fg: string } {
  const hex = /^#[0-9a-f]{6}$/i.test(color ?? '') ? (color as string) : '#8d90a0';
  const hit = cache.get(hex);
  if (hit) return hit;
  let result: { bg: string; fg: string } | null = null;
  for (const k of [1, 0.9, 0.85, 0.8]) {
    const bg = k === 1 ? hex : darken(hex, k);
    if (contrastRatio('#ffffff', bg) >= 4.5) {
      result = { bg, fg: '#ffffff' };
      break;
    }
  }
  if (!result) {
    let bg = hex;
    for (let k = 1; contrastRatio(DARK_TEXT, bg) < 4.5 && k > 0.5; k -= 0.05) bg = darken(hex, k);
    result = { bg, fg: DARK_TEXT };
  }
  cache.set(hex, result);
  return result;
}
