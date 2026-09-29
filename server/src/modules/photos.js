// Photo albums — module "photos", mounted at /api/photos.
// STUB created by the foundation. The photos feature author replaces this file.
// Contract: docs/ARCHITECTURE.md ("Module contract" + "Module author guide").
import { Router } from 'express';

export const name = 'photos';

/** Idempotent SQL run at boot, in order. Use ISO_NOW from '../db.js' for timestamps. */
export const migrations = [];

/** @param {import('./index.js').ModuleContext} ctx */
export function router(ctx) {
  const r = Router();
  r.get('/', (req, res) => res.json({ ok: true, module: name }));
  return r;
}

// Optional hooks (uncomment / implement as needed):
// export async function seed(ctx, { familyId, users, userList }) {}
// export function search(ctx, familyId, q, req) { return [{ title, subtitle, link }]; }
// export function dashboard(ctx, req) { return { ... }; }
