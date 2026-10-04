// Geo helpers for the locator module (pure functions, unit-testable).

const R = 6371000; // mean Earth radius in meters
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in meters between two lat/lng points. */
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Extra meters a member may drift outside a place before counting as "left" (avoids flapping at the edge). */
export const EXIT_MARGIN = 25;

/**
 * Which saved place contains the point?
 * - If `currentPlaceId` is given and the point is still within radius + EXIT_MARGIN of it, stay there.
 * - Otherwise the closest place whose radius contains the point (closest relative to its radius).
 */
export function placeFor(places, lat, lng, currentPlaceId = null) {
  if (currentPlaceId) {
    const cur = places.find((p) => p.id === currentPlaceId);
    if (cur && distanceMeters(lat, lng, cur.lat, cur.lng) <= cur.radius + EXIT_MARGIN) return cur;
  }
  let best = null;
  let bestScore = Infinity;
  for (const p of places) {
    const d = distanceMeters(lat, lng, p.lat, p.lng);
    if (d > p.radius) continue;
    const score = d / p.radius;
    if (score < bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

/** Nearest place (any distance) → { place, meters } or null. */
export function nearestPlace(places, lat, lng) {
  let best = null;
  for (const p of places) {
    const d = distanceMeters(lat, lng, p.lat, p.lng);
    if (!best || d < best.meters) best = { place: p, meters: d };
  }
  return best;
}
