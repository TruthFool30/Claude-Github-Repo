import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { makeAuth, publicUser } from './auth.js';
import { openDb, tx } from './db.js';
import { createHub } from './realtime.js';
import { makeLogActivity } from './activity.js';
import { makeNotify } from './notifications.js';
import { imageOnly, makeRemoveFile, makeStoreFile, makeUpload, makeUploadServer } from './uploads.js';
import { httpError } from './util.js';
import { authRouter } from './core/auth.js';
import { familiesRouter, familyRouter } from './core/families.js';
import { activityRouter, dashboardHandler, notificationsRouter, searchHandler, streamHandler } from './core/feed.js';
import { modules as defaultModules, validateModules } from './modules/index.js';
import { config } from './config.js';

/**
 * Build the context object shared by core routers, module routers and seeds.
 * Exposed separately so seed.js can build it without an HTTP server.
 */
export function createContext({ db, uploadDir, hub = createHub() }) {
  const auth = makeAuth(db);
  const ctx = {
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
} = {}) {
  validateModules(modules);
  fs.mkdirSync(uploadDir, { recursive: true });
  const db = openDb(dbPath, modules);
  const hub = createHub();
  const ctx = createContext({ db, uploadDir, hub });
  const { requireAuth, requireFamily } = ctx.auth;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  // ---- core API ----
  app.get('/api/health', (req, res) => res.json({ ok: true, modules: modules.map((m) => m.name) }));
  app.use('/api/auth', authRouter(ctx));
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
      res.sendFile(indexHtml);
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
