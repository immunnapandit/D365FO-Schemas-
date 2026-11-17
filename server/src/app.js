import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { authenticate } from './middleware/auth.js';
import { HttpError } from './http-errors.js';
import { pingDb } from './db/index.js';
import formsRouter, { executionsRouter } from './routes/forms.js';
import modulesRouter, { importRouter } from './routes/modules.js';
import { definitionSchema } from './services/definition-schema.js';
import { trackException } from './telemetry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const DEFAULT_CLIENT_DIST = path.join(__dirname, '..', '..', 'client', 'dist');
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

export function createApp({ clientDist = DEFAULT_CLIENT_DIST } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  // request id: reuse the one from Azure front end if present, otherwise create one
  app.use((req, res, next) => {
    const incoming = req.headers['x-request-id'];
    req.id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.id);
    next();
  });

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      autoLogging: { ignore: (req) => req.url.startsWith('/health') || !req.url.startsWith('/api') },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  const loginHost = 'https://login.microsoftonline.com';
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"], // editor + form library set inline styles
          'img-src': ["'self'", 'data:'],
          'font-src': ["'self'", 'data:'],
          'worker-src': ["'self'", 'blob:'],
          'connect-src': ["'self'", ...(config.auth.mode === 'entra' ? [loginHost] : [])],
          'frame-src': config.auth.mode === 'entra' ? [loginHost] : ["'none'"],
          'frame-ancestors': ["'none'"],
          'form-action': ["'self'", ...(config.auth.mode === 'entra' ? [loginHost] : [])],
          'upgrade-insecure-requests': config.isProd ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
  );
  app.use(compression());
  if (config.security.corsOrigins.length) app.use('/api', cors({ origin: config.security.corsOrigins }));

  /* ---------- health (no auth; used by Azure probes) ---------- */
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res) => {
    try {
      await pingDb();
      res.json({ status: 'ok', db: 'ok', version: pkg.version });
    } catch (e) {
      logger.error({ err: e }, 'readiness check failed');
      res.status(503).json({ status: 'error', db: 'unavailable' });
    }
  });

  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: config.rateLimit.apiPerMinute,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { message: 'Too many requests. Please slow down.', code: 'rate_limited' },
    }),
  );
  app.use('/api/import', express.json({ limit: '5mb' })); // OpenAPI files can be large
  app.use('/api', express.json({ limit: '1mb' }));

  /* ---------- public: what the browser needs to sign in ---------- */
  app.get('/api/config', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      authMode: config.auth.mode,
      tenantId: config.auth.mode === 'entra' ? config.auth.tenantId : undefined,
      spaClientId: config.auth.mode === 'entra' ? config.auth.spaClientId : undefined,
      apiScope: config.auth.mode === 'entra' ? config.auth.apiScope : undefined,
      version: pkg.version,
    });
  });

  /* ---------- everything below needs a signed-in user ---------- */
  app.use('/api', authenticate());
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/me', (req, res) => {
    const { id, name, username, roles, isAdmin } = req.user;
    res.json({ id, name, username, roles, isAdmin });
  });
  app.get('/api/meta/definition-schema', (_req, res) => res.json(definitionSchema));
  app.use('/api/forms', formsRouter);
  app.use('/api/modules', modulesRouter);
  app.use('/api/import', importRouter);
  app.use('/api/executions', executionsRouter);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found', [], 'not_found')));

  /* ---------- React app ---------- */
  if (fs.existsSync(path.join(clientDist, 'index.html'))) {
    app.use(
      express.static(clientDist, {
        index: false,
        setHeaders: (res, file) => {
          // hashed assets can be cached forever; index.html never
          if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );
    app.get('/{*splat}', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/health')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  /* ---------- errors ---------- */
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ message: err.message, details: err.details, code: err.code, requestId: req.id });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ message: 'Request body is not valid JSON', code: 'bad_json', requestId: req.id });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ message: 'Request body is too large', code: 'too_large', requestId: req.id });
    }
    (req.log || logger).error({ err }, 'unhandled error');
    trackException(err, { requestId: req.id, path: req.path });
    res.status(500).json({
      message: config.isProd ? 'Something went wrong on the server.' : err.message,
      code: 'server_error',
      requestId: req.id,
    });
  });

  return app;
}
