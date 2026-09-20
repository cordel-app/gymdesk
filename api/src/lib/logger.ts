import pino from 'pino';

// 'req.headers["x-api-key"]' — #599: the website registration key is a bearer secret.
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'body.password',
  'req.params.token',
  'req.query.token',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  redact: LOG_REDACT_PATHS,
});
