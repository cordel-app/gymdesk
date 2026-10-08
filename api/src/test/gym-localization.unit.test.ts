import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGymLocalizationInput, DEFAULT_GYM_LOCALIZATION } from '../domain/gymLocalization';

describe('parseGymLocalizationInput (#1246)', () => {
  it('keeps everything when nothing is mentioned', () => {
    expect(parseGymLocalizationInput({})).toEqual({ ok: true, changes: {} });
  });
  it('accepts the defaults', () => {
    expect(parseGymLocalizationInput(DEFAULT_GYM_LOCALIZATION)).toMatchObject({ ok: true });
  });
  it('accepts only EUR as currency', () => {
    expect(parseGymLocalizationInput({ currency: 'USD' })).toMatchObject({ ok: false });
  });
  it('refuses unknown zone, format, number format and weekday without coercing', () => {
    for (const body of [
      { time_zone: 'Mars/Base' }, { date_format: 'YY-MM-DD' }, { time_format: '36h' },
      { number_format: 'x' }, { first_day_of_week: 7 }, { first_day_of_week: '1' },
    ]) expect(parseGymLocalizationInput(body)).toMatchObject({ ok: false });
  });
  it('accepts a valid change', () => {
    expect(parseGymLocalizationInput({ time_zone: 'Europe/London', first_day_of_week: 0, date_format: 'YYYY-MM-DD' }))
      .toEqual({ ok: true, changes: { time_zone: 'Europe/London', first_day_of_week: 0, date_format: 'YYYY-MM-DD' } });
  });
});

describe('gymFormat (#1246): the two apps carry the same formatter', () => {
  it('is identical apart from the header comment', () => {
    const root = join(__dirname, '..', '..', '..', 'apps');
    const body = (app: string) =>
      readFileSync(join(root, app, 'src/lib/gymFormat.ts'), 'utf8').split('\n').filter((l) => !l.startsWith('//')).join('\n');
    expect(body('member')).toBe(body('admin'));
  });
});
