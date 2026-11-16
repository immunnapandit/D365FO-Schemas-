import pino from 'pino';
import { config } from './config.js';

const usePretty = !config.isProd && !config.isTest && process.stdout.isTTY;

export const logger = pino({
  level: config.logLevel,
  base: { service: 'schema-forms' },
  timestamp: pino.stdTimeFunctions.isoTime,
  // never write tokens, secrets or passwords to the logs
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-ms-client-principal"]',
      'req.headers["x-ms-token-aad-access-token"]',
      'req.headers["x-ms-token-aad-id-token"]',
      '*.clientSecret',
      '*.password',
      '*.token',
      '*.access_token',
    ],
    censor: '[redacted]',
  },
  ...(usePretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } } : {}),
});
