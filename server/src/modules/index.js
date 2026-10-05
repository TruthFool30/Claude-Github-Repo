// Module registry — DO NOT EDIT from a feature module.
// Every module file exports: name, migrations[], router(ctx) and optionally
// seed(ctx, {familyId, users, userList}), search(ctx, familyId, q, req), dashboard(ctx, req).
import * as wall from './wall.js';
import * as calendar from './calendar.js';
import * as lists from './lists.js';
import * as messages from './messages.js';
import * as photos from './photos.js';
import * as meals from './meals.js';
import * as budget from './budget.js';
import * as locator from './locator.js';
import * as vault from './vault.js';

/**
 * @typedef {object} ModuleContext
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {(familyId:number, type:string, payload?:any) => void} broadcast  SSE to every member viewing the family
 * @property {(userIds:number[], type:string, payload?:any, familyId?:number|null) => void} sendToUsers  SSE to specific users
 * @property {(a:{familyId:number,userId?:number|null,module:string,verb:string,entityId?:number|null,summary:string,link?:string|null,createdAt?:string|null}) => object} logActivity
 * @property {(a:{familyId:number,userIds:number[],module?:string,title:string,body?:string|null,link?:string|null,excludeUserId?:number|null}) => object[]} notify
 * @property {(familyId:number, rows:{id:number,user_id:number}[]) => void} removeNotifications  delete them + tell those users' bells
 * @property {import('multer').Multer} upload  stores to UPLOAD_DIR/<familyId>/, sets req.file.url
 * @property {(row:object) => object} publicUser
 * @property {(familyId:number, buffer:Buffer, ext?:string) => string} storeFile  write a file into the family's uploads, returns URL
 * @property {(url:string) => void} removeFile  delete an uploaded file by URL
 * @property {<T>(db:any, fn:() => T) => T} tx  transaction helper
 * @property {(status:number, message:string) => Error} httpError  throw httpError(404, 'Not found') inside handlers
 * @property {string} uploadDir
 */

export const modules = [wall, calendar, lists, messages, photos, meals, budget, locator, vault];

const RESERVED = new Set(['auth', 'families', 'family', 'activity', 'notifications', 'stream', 'search', 'dashboard', 'health', 'uploads']);

export function validateModules(list = modules) {
  const seen = new Set();
  for (const m of list) {
    if (!m || typeof m.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(m.name)) throw new Error(`Invalid module name: ${m?.name}`);
    if (RESERVED.has(m.name)) throw new Error(`Module name "${m.name}" is reserved`);
    if (seen.has(m.name)) throw new Error(`Duplicate module "${m.name}"`);
    if (typeof m.router !== 'function') throw new Error(`Module "${m.name}" must export router(ctx)`);
    if (m.migrations && !Array.isArray(m.migrations)) throw new Error(`Module "${m.name}" migrations must be an array`);
    seen.add(m.name);
  }
  return list;
}
