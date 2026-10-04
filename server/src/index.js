import { KEY_ERROR, createApp } from './app.js';
import { config } from './config.js';

let app;
try {
  app = createApp();
} catch (err) {
  console.error(err.code === KEY_ERROR ? `Hearth could not start: ${err.message}` : err);
  process.exit(1);
}
const server = app.listen(config.port, () => {
  console.log(`Hearth listening on http://localhost:${config.port}`);
  console.log(`  db: ${config.dbPath}\n  uploads: ${config.uploadDir}`);
});

function shutdown() {
  app.locals.hub.close();
  server.close(() => {
    app.locals.close();
    process.exit(0);
  });
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
