// #966: the global error handler must not answer with a driver message.
//
// A unit test — `domain/httpErrorResponse.ts` is pure, and the two source scans
// below read files rather than starting Express or touching MySQL.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  INTERNAL_ERROR_MESSAGE, httpErrorStatus, publicErrorMessage,
} from '../domain/httpErrorResponse';

const API_SRC = join(__dirname, '..');

/** A mysql2 error, as the driver actually shapes it. */
function driverError(message: string) {
  return Object.assign(new Error(message), {
    code: 'ER_BAD_FIELD_ERROR',
    errno: 1054,
    sqlState: '42S22',
    sqlMessage: message,
    sql: 'SELECT b.result_type FROM workout_template_blocks b',
  });
}

describe('publicErrorMessage', () => {
  it('replaces a database driver message with the generic sentence', () => {
    const err = driverError("Unknown column 'b.result_type' in 'field list'");
    expect(publicErrorMessage(err)).toBe(INTERNAL_ERROR_MESSAGE);
    expect(publicErrorMessage(err)).not.toContain('result_type');
    expect(httpErrorStatus(err)).toBe(500);
  });

  it('keeps the message of an error that named an HTTP status', () => {
    const err = Object.assign(new Error('center_id is required as the gym has more than one center'), { status: 400 });
    expect(publicErrorMessage(err)).toBe('center_id is required as the gym has more than one center');
    expect(httpErrorStatus(err)).toBe(400);
  });

  it('keeps a deliberate 5xx message too — the thrower chose to say it', () => {
    const err = Object.assign(new Error('charge_type membership_fee not configured'), { status: 500 });
    expect(publicErrorMessage(err)).toBe('charge_type membership_fee not configured');
    expect(httpErrorStatus(err)).toBe(500);
  });

  it('keeps body-parser\'s own answers (413 request entity too large)', () => {
    const err = Object.assign(new Error('request entity too large'), {
      status: 413, statusCode: 413, type: 'entity.too.large',
    });
    expect(httpErrorStatus(err)).toBe(413);
    expect(publicErrorMessage(err)).toBe('request entity too large');
  });

  it('generalises an unexpected programming error', () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'rows')");
    expect(publicErrorMessage(err)).toBe(INTERNAL_ERROR_MESSAGE);
    expect(httpErrorStatus(err)).toBe(500);
  });

  it('ignores a status that is not an HTTP one', () => {
    for (const status of [200, 0, -1, 600, '400', null, undefined, NaN, 404.5]) {
      const err = Object.assign(new Error('leaky internal detail'), { status });
      expect(httpErrorStatus(err)).toBe(500);
      expect(publicErrorMessage(err)).toBe(INTERNAL_ERROR_MESSAGE);
    }
  });

  it('falls back to the generic sentence for a deliberate status with no message', () => {
    expect(publicErrorMessage(Object.assign(new Error(''), { status: 403 }))).toBe(INTERNAL_ERROR_MESSAGE);
    expect(publicErrorMessage({ status: 403 })).toBe(INTERNAL_ERROR_MESSAGE);
  });

  it('survives a thrown non-error', () => {
    expect(publicErrorMessage(undefined)).toBe(INTERNAL_ERROR_MESSAGE);
    expect(publicErrorMessage('a string was thrown')).toBe(INTERNAL_ERROR_MESSAGE);
    expect(httpErrorStatus(null)).toBe(500);
  });
});

describe('app.ts wiring', () => {
  const app = readFileSync(join(API_SRC, 'app.ts'), 'utf8');

  it('answers through the shared decision, not err.message', () => {
    expect(app).toContain('res.status(httpErrorStatus(err)).json({ error: publicErrorMessage(err) })');
    expect(app).not.toContain("err?.message || 'Internal server error'");
  });

  it('still logs the real error server-side', () => {
    expect(app).toContain('console.error(err)');
  });
});

describe('the Training Plan Template hierarchy query', () => {
  const router = readFileSync(join(API_SRC, 'api', 'training-plan-templates.ts'), 'utf8');
  // The defect is named in a comment at the route, so the scan reads code only.
  const code = router.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

  it('selects no block-level result_type (migration 074 dropped the column)', () => {
    expect(code).not.toContain('b.result_type');
  });

  it('projects the exercise instance\'s result type instead', () => {
    for (const fragment of [
      "'result_type_id', wte.result_type_id",
      "'result_type_slug', rt.slug",
      "'result_type_name', rt.name",
      "'target_value', wte.target_value",
      "'unit', wte.unit",
      'LEFT JOIN result_types rt ON rt.id = wte.result_type_id',
    ]) {
      expect(router).toContain(fragment);
    }
  });
});
