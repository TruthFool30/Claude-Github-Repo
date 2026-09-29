// Module registry — DO NOT EDIT from a feature module.
import type { ModuleDef } from './types';
import wall from './wall';
import calendar from './calendar';
import lists from './lists';
import messages from './messages';
import photos from './photos';
import meals from './meals';
import budget from './budget';
import locator from './locator';
import vault from './vault';

export const modules: ModuleDef[] = [wall, calendar, lists, messages, photos, meals, budget, locator, vault].sort(
  (a, b) => a.order - b.order,
);

/** First 4 primary modules → mobile bottom bar. */
export const primaryModules = modules.filter((m) => m.nav === 'primary').slice(0, 4);
/** Everything else → "More" sheet on mobile. */
export const secondaryModules = modules.filter((m) => !primaryModules.includes(m));

export const moduleById: Record<string, ModuleDef> = Object.fromEntries(modules.map((m) => [m.id, m]));

/** Module owning a URL path (for highlighting nav items). */
export function moduleForPath(pathname: string): ModuleDef | undefined {
  return modules.find((m) => pathname === m.path || pathname.startsWith(`${m.path}/`));
}
