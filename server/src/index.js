import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();
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
