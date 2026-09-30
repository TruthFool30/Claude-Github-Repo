import fs from 'node:fs';
import { makeTime } from './time.js';
import { sniffImageBuffer } from './imagesniff.js';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { isSessionValid, makeAuth, publicUser } from './auth.js';
import { openDb, tx } from './db.js';
import { createHub } from './realtime.js';
import { makeLogActivity } from './activity.js';
import { makeNotify } from './notifications.js';
import { imageOnly, makeRemoveFile, makeStoreFile, makeUpload, makeUploadServer, verifyImageUpload } from './uploads.js';
import { TOO_MANY, createRateLimiter, httpError } from './util.js';
import { authRouter } from './core/auth.js';
import { familiesRouter, familyRouter, invitePreviewHandler } from './core/families.js';
import { activityRouter, dashboardHandler, notificationsRouter, searchHandler, streamHandler } from './core/feed.js';
import { modules as defaultModules, validateModules } from './modules/index.js';
import { config } from './config.js';

/** Default rate limits (per key, fixed window). Override with createApp({ limits }). */
export const DEFAULT_LIMITS = {
  'login-ip': { max: 100, windowMs: 10 * 60_000 },
  'login-email': { max: 10, windowMs: 10 * 60_000 }, // failures per email+IP
  'register-ip': { max: 30, windowMs: 60 * 60_000 },
  'join-ip': { max: 60, windowMs: 10 * 60_000 },
  'invite-ip': { max: 120, windowMs: 10 * 60_000 },
};

/** HEARTH_RATE_LIMITS=off disables rate limiting (handy for scripted test instances). */
function envLimits() {
  if (process.env.HEARTH_RATE_LIMITS !== 'off') return {};
  return Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((k) => [k, { max: Number.MAX_SAFE_INTEGER, windowMs: 60_000 }]));
}

/**
 * Build the context object shared by core routers, module routers and seeds.
 * Exposed separately so seed.js can build it without an HTTP server.
 */
export function createContext({ db, uploadDir, hub = createHub(), limits = {} }) {
  const auth = makeAuth(db);
  const limiter = createRateLimiter();
  const rules = { ...DEFAULT_LIMITS, ...envLimits(), ...limits };
  /** Middleware: rateLimit('login-ip', (req) => req.ip) -> 429 JSON when the rule's budget is spent. */
  const rateLimit = (rule, keyFn) => (req, res, next) => {
    const cfg = rules[rule];
    const key = keyFn(req);
    if (!cfg || !key) return next();
    const { ok, retryAfter } = limiter.hit(`${rule}:${key}`, cfg);
    if (ok) return next();
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: TOO_MANY, retry_after: retryAfter });
  };
  /**
   * Failure-only limiter (login): check(keys) -> 429 sent? ; fail(keys) counts a failed attempt;
   * succeed(keys) clears the counters. Successful sign-ins never use up the budget.
   */
  const failureLimit = (entries) => ({
    check(res) {
      for (const [rule, key] of entries) {
        const cfg = rules[rule];
        if (cfg && key && limiter.blocked(`${rule}:${key}`, cfg)) {
          const retryAfter = limiter.retryAfter(`${rule}:${key}`);
          res.set('Retry-After', String(retryAfter));
          res.status(429).json({ error: TOO_MANY, retry_after: retryAfter });
          return true;
        }
      }
      return false;
    },
    fail() {
      for (const [rule, key] of entries) if (rules[rule] && key) limiter.hit(`${rule}:${key}`, rules[rule]);
    },
    succeed() {
      for (const [rule, key] of entries) if (key && rule.endsWith('-email')) limiter.clear(`${rule}:${key}`);
    },
  });
  const ctx = {
    rateLimit,
    failureLimit,
    limiter,
    db,
    hub,
    auth,
    uploadDir,
    broadcast: (familyId, type, payload) => hub.broadcast(familyId, type, payload),
    sendToUsers: (userIds, type, payload, familyId) => hub.sendToUsers(userIds, type, payload, familyId),
    logActivity: makeLogActivity(db, hub),
    notify: makeNotify(db, hub),
    upload: makeUpload(uploadDir),
    avatarUpload: makeUpload(uploadDir, { scope: (req) => `users/${req.user.id}`, fileFilter: imageOnly }),
    coverUpload: makeUpload(uploadDir, { fileFilter: imageOnly }),
    storeFile: makeStoreFile(uploadDir),
    removeFile: makeRemoveFile(uploadDir),
    publicUser,
    tx,
    httpError,
    time: makeTime(db),
    /** verifyImage(req.file) → { mime, ext, width, height }; throws 400 unless the bytes are a real image. */
    verifyImage: verifyImageUpload,
    /** sniffImage(buffer) → { mime, ext, width, height } | null. */
    sniffImage: sniffImageBuffer,
  };
  return ctx;
}

/**
 * createApp({ dbPath, uploadDir, clientDist?, modules? }) -> express app.
 * app.locals: { db, hub, ctx, modules, close() }.
 */
export function createApp({
  dbPath = config.dbPath,
  uploadDir = config.uploadDir,
  clientDist = config.clientDist,
  modules = defaultModules,
  limits = {},
  trustProxy = config.trustProxy,
} = {}) {
  validateModules(modules);
  fs.mkdirSync(uploadDir, { recursive: true });
  const db = openDb(dbPath, modules);
  const hub = createHub({ isSessionValid: (token) => isSessionValid(db, token) });
  const ctx = createContext({ db, uploadDir, hub, limits });
  // Membership lifecycle hooks: modules may export onMemberJoined / onMemberLeft(ctx, { familyId, userId, reason }).
  ctx.memberEvent = (kind, info) => {
    const hook = kind === 'joined' ? 'onMemberJoined' : 'onMemberLeft';
    for (const mod of modules) {
      if (typeof mod[hook] !== 'function') continue;
      try {
        mod[hook](ctx, info);
      } catch (err) {
        console.error(`[${mod.name}] ${hook} failed:`, err);
      }
    }
  };
  const { requireAuth, requireFamily } = ctx.auth;

  const app = express();
  app.disable('x-powered-by');
  // Which proxies may set X-Forwarded-For (req.ip is used for rate limiting). See TRUST_PROXY.
  app.set('trust proxy', trustProxy);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  // Uploaded files of a request that ends in an error (validation 4xx, thrown error, 5xx) are
  // deleted automatically, so handlers never leave orphans on disk.
  app.use((req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode < 400) return;
      const files = [
        ...(req.file ? [req.file] : []),
        ...(Array.isArray(req.files) ? req.files : Object.values(req.files ?? {}).flat()),
      ];
      for (const f of files) if (f?.path) fs.rm(f.path, { force: true }, () => {});
    });
    next();
  });

  // ---- core API ----
  app.get('/api/health', (req, res) => res.json({ ok: true, modules: modules.map((m) => m.name) }));
  app.use('/api/auth', authRouter(ctx));
  app.get('/api/families/invite/:code', ctx.auth.optionalAuth, ctx.rateLimit('invite-ip', (req) => req.ip), invitePreviewHandler(ctx));
  app.use('/api/families', requireAuth, familiesRouter(ctx));
  app.use('/api/family', requireAuth, requireFamily, familyRouter(ctx));
  app.use('/api/activity', requireAuth, requireFamily, activityRouter(ctx));
  app.use('/api/notifications', requireAuth, requireFamily, notificationsRouter(ctx));
  app.get('/api/stream', requireAuth, streamHandler(ctx));
  app.get('/api/search', requireAuth, requireFamily, searchHandler(ctx, modules));
  app.get('/api/dashboard', requireAuth, requireFamily, dashboardHandler(ctx, modules));

  // ---- feature modules ----
  for (const mod of modules) {
    app.use(`/api/${mod.name}`, requireAuth, requireFamily, mod.router(ctx));
  }

  app.use('/api', (req, res) => res.status(404).json({ error: `No API route for ${req.method} ${req.originalUrl}` }));

  // ---- uploads (auth-checked) ----
  for (const [route, ...handlers] of makeUploadServer(db, uploadDir, requireAuth)) app.get(route, ...handlers);
  app.use('/uploads', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ---- built client + SPA fallback ----
  const indexHtml = path.join(clientDist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(clientDist, {
      index: false,
      setHeaders(res, file) {
        if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
      },
    }));
    app.get('/{*splat}', (req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile('index.html', { root: clientDist }); // root: works even under a dot-folder
    });
  }

  // ---- errors ----
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.expose === false ? 'Something went wrong' : err.message;
    if (err.name === 'MulterError') {
      status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large (max 25 MB)' : err.message;
    } else if (err.type === 'entity.parse.failed') {
      message = 'Invalid JSON body';
    } else if (err.type === 'entity.too.large') {
      message = 'Request body is too large';
    }
    if (status >= 500) {
      console.error(`[error] ${req.method} ${req.originalUrl}`, err);
      message = 'Something went wrong on our side';
    }
    if (res.headersSent) return;
    res.status(status).json({ error: message });
  });

  app.locals.db = db;
  app.locals.hub = hub;
  app.locals.ctx = ctx;
  app.locals.modules = modules;
  app.locals.close = () => {
    hub.close();
    try { db.close(); } catch { /* already closed */ }
  };
  return app;
}
