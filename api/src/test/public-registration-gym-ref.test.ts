// #645: unit tests for the two pure helpers behind the registration endpoint —
// how `{gymId}-{gym-name}` is resolved, and what counts as a health check.
// No DB, no HTTP (see public-registrations.test.ts for the router itself).

import { describe, expect, it } from 'vitest';
import { isHealthCheckBody, parseGymRef } from '../api/public-registrations';

const GYM_ID = '3f9c1c6e-9c1a-4f2b-8a7d-1b2c3d4e5f60';

describe('parseGymRef', () => {
  it('reads the gym id out of `{gymId}-{gym-name}`', () => {
    expect(parseGymRef(`${GYM_ID}-fitbox`)).toEqual({ by: 'id', value: GYM_ID });
  });

  it('accepts a bare gym id with no name', () => {
    expect(parseGymRef(GYM_ID)).toEqual({ by: 'id', value: GYM_ID });
  });

  it('ignores whatever the name half contains, hyphens included', () => {
    for (const name of ['fitbox', 'fit-box-barcelona', 'Fit Box', '12345', 'a-b-c-d-e-f']) {
      expect(parseGymRef(`${GYM_ID}-${name}`)).toEqual({ by: 'id', value: GYM_ID });
    }
  });

  it('lowercases an uppercased id so it matches the stored CHAR(36)', () => {
    expect(parseGymRef(`${GYM_ID.toUpperCase()}-fitbox`)).toEqual({ by: 'id', value: GYM_ID });
  });

  it('two gyms with the same name parse to different ids', () => {
    const other = '7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
    expect(parseGymRef(`${GYM_ID}-fitbox`).value).not.toBe(parseGymRef(`${other}-fitbox`).value);
  });

  it('falls back to the legacy bare-slug format', () => {
    expect(parseGymRef('fitbox')).toEqual({ by: 'slug', value: 'fitbox' });
    expect(parseGymRef('fit-box-barcelona')).toEqual({ by: 'slug', value: 'fit-box-barcelona' });
    expect(parseGymRef('')).toEqual({ by: 'slug', value: '' });
  });

  it('treats a not-quite-id prefix as a slug rather than a truncated id', () => {
    // Right shape, wrong characters; and a UUID not followed by a separator.
    expect(parseGymRef('3f9c1c6e-9c1a-4f2b-8a7d-1b2c3d4e5fzz-fitbox').by).toBe('slug');
    expect(parseGymRef(`${GYM_ID}x-fitbox`).by).toBe('slug');
    expect(parseGymRef(GYM_ID.slice(0, 35)).by).toBe('slug');
  });
});

describe('isHealthCheckBody', () => {
  it('accepts exactly { name: "test", email: "" }', () => {
    expect(isHealthCheckBody({ name: 'test', email: '' })).toBe(true);
  });

  it('tolerates whitespace and casing', () => {
    expect(isHealthCheckBody({ name: ' test ', email: '  ' })).toBe(true);
    expect(isHealthCheckBody({ name: 'TEST', email: '' })).toBe(true);
  });

  it('ignores the fields a registration may also carry', () => {
    expect(isHealthCheckBody({ name: 'test', email: '', locale: 'es', center_id: 3 })).toBe(true);
  });

  it('rejects a real registration — a non-empty email is never a probe', () => {
    expect(isHealthCheckBody({ name: 'test', email: 'test@example.com' })).toBe(false);
    expect(isHealthCheckBody({ name: 'Juan García', email: 'juan@example.com' })).toBe(false);
  });

  it('rejects an empty email under any other name', () => {
    expect(isHealthCheckBody({ name: 'Ana', email: '' })).toBe(false);
    expect(isHealthCheckBody({ name: 'testing', email: '' })).toBe(false);
  });

  it('rejects a missing field, a wrong type, and anything that is not an object', () => {
    expect(isHealthCheckBody({ name: 'test' })).toBe(false);
    expect(isHealthCheckBody({ email: '' })).toBe(false);
    expect(isHealthCheckBody({ name: 'test', email: null })).toBe(false);
    expect(isHealthCheckBody({ name: ['test'], email: '' })).toBe(false);
    expect(isHealthCheckBody([{ name: 'test', email: '' }])).toBe(false);
    expect(isHealthCheckBody(undefined)).toBe(false);
    expect(isHealthCheckBody(null)).toBe(false);
    expect(isHealthCheckBody('test')).toBe(false);
  });
});
