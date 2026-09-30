// Shared by the server (server/src/modules/lists/categories.js) and the web client (client/src/modules/lists/categories.ts
// imports this file + aisles.json directly; both live in /shared/lists/), so the live aisle preview always matches what the
// server stores. Pure ESM, no Node APIs. Types: classify.d.ts.
//
// The name is split into whole words, each reduced to a singular-ish stem ("berries" -> "berry",
// "peaches" -> "peach"). Keywords (1–4 words) match whole-word sequences only, so "pea" never
// matches "peanuts". Among matches the one ending LAST wins — English puts the head noun last
// ("tomato sauce" is a sauce, "garlic bread" is bread) — then the longest ("black pepper" beats
// "pepper"). A few modifiers ("frozen", "canned") decide on their own.

/** Singular-ish stem, applied identically to keywords and item names. */
export function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('ie')) return `${w.slice(0, -2)}y`;
  if (w.length > 4 && w.endsWith('oes')) return w.slice(0, -2);
  if (/(ch|sh|x|ss|zz)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(ss|us)$/.test(w)) return w.slice(0, -1);
  return w;
}

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stem);
}

export function createClassifier(DATA) {
  const PHRASES = new Map();
  let MAX_WORDS = 1;
  for (const [cat, words] of Object.entries(DATA.keywords)) {
    for (const w of words) {
      const key = tokenize(w).join(' ');
      PHRASES.set(key, cat);
      MAX_WORDS = Math.max(MAX_WORDS, key.split(' ').length);
    }
  }
  const MODIFIERS = new Map(Object.entries(DATA.modifiers).map(([k, v]) => [stem(k), v]));

  /** Guess the aisle for an item name ("Tomato sauce" -> "Pantry"). Returns 'Other' when unsure. */
  function guessCategory(text) {
    if (typeof text !== 'string') return 'Other';
    const tokens = tokenize(text);
    for (const t of tokens) if (MODIFIERS.has(t)) return MODIFIERS.get(t);
    let best = null;
    for (let end = 0; end < tokens.length; end++) {
      for (let len = 1; len <= Math.min(MAX_WORDS, end + 1); len++) {
        const cat = PHRASES.get(tokens.slice(end - len + 1, end + 1).join(' '));
        if (cat && (!best || end > best.end || (end === best.end && len > best.len))) best = { end, len, cat };
      }
    }
    return best?.cat ?? 'Other';
  }
  return { categories: DATA.categories, guessCategory };
}

/** "2 x Milk" / "Milk x2" / "Milk ×2" -> { text: 'Milk', quantity: '2' } (only these explicit forms). */
export function parseQuantity(text) {
  let m = text.match(/^(\d+(?:[.,]\d+)?)\s*[x×]\s+(.+)$/i);
  if (m) return { text: m[2].trim(), quantity: m[1] };
  m = text.match(/^(.+?)\s+[x×]\s*(\d+(?:[.,]\d+)?)$/i);
  if (m) return { text: m[1].trim(), quantity: m[2] };
  return { text, quantity: null };
}
