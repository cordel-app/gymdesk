// #599: the website registration key travels in `x-api-key`. It is a bearer
// secret, so the request logger must never write it out. Unit test — no DB.

import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { LOG_REDACT_PATHS } from '../lib/logger';

describe('logger redaction', () => {
  it('redacts x-api-key and authorization headers, keeps the rest', () => {
    const lines: string[] = [];
    const log = pino({ redact: LOG_REDACT_PATHS }, { write: (line: string) => { lines.push(line); } });

    log.info({ req: { headers: { 'x-api-key': 'gdk_secret-value', authorization: 'Bearer abc', host: 'api' } } }, 'request');

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('gdk_secret-value');
    expect(lines[0]).not.toContain('Bearer abc');
    expect(JSON.parse(lines[0]).req.headers.host).toBe('api');
  });
});
