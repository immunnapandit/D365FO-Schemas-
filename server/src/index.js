// telemetry first, so Application Insights can hook into HTTP before anything else loads
import { flushTelemetry } from './telemetry.js';
import { config, validateConfig } from './config.js';
import { logger } from './logger.js';
import { initDb, closeDb } from './db/knex.js';
import { createApp } from './app.js';
import { seedSampleForms } from './services/seed.js';
import { purgeOldExecutions } from './repositories/executions.js';

async function main() {
  const { errors, warnings } = validateConfig();
  for (const w of warnings) logger.warn(w);
  if (errors.length) {
    for (const e of errors) logger.fatal(e);
    logger.fatal('Configuration is not valid. See the messages above and docs/deployment.md.');
    process.exit(1);
  }

  await initDb();
  if (config.seedSampleForms) await seedSampleForms();

  // daily clean-up of old run history
  const purge = async () => {
    try {
      const n = await purgeOldExecutions();
      if (n) logger.info({ deleted: n, retentionDays: config.history.retentionDays }, 'old run history removed');
    } catch (e) {
      logger.error({ err: e }, 'history clean-up failed');
    }
  };
  await purge();
  const purgeTimer = setInterval(purge, 24 * 3_600_000);
  purgeTimer.unref();

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, authMode: config.auth.mode, db: config.db.kind }, 'Schema Forms server started');
  });
  server.keepAliveTimeout = 65_000; // longer than Azure load balancer idle timeout
  server.headersTimeout = 66_000;

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    server.close(async () => {
      await closeDb().catch(() => {});
      await flushTelemetry().catch(() => {});
      logger.info('stopped');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled promise rejection'));

main().catch((e) => {
  logger.fatal({ err: e }, 'failed to start');
  process.exit(1);
});
