import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SEED_BASE_PAYMENT_METHODS, parseCode, parseStatus, parseTranslations } from '../domain/basePaymentMethods';

const full = {
  en: { name: 'Cash', description: 'Payment made in cash.' },
  es: { name: 'Efectivo', description: '' },
  ca: { name: 'Efectiu' },
};

describe('base payment methods rules (#1663)', () => {
  it('migration 284 seeds exactly the declared codes and statuses', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../infra/migrations/284_base_payment_methods.js'), 'utf8');
    for (const { code, status } of SEED_BASE_PAYMENT_METHODS) {
      expect(sql).toContain(`['${code}', '${status}',`);
    }
    expect((sql.match(/^\s+\['[a-z_]+', '(active|inactive)',/gm) ?? []).length).toBe(SEED_BASE_PAYMENT_METHODS.length);
  });

  it('judges codes', () => {
    expect(parseCode(' cash ')).toEqual({ value: 'cash' });
    expect('error' in parseCode('Cash')).toBe(true);
    expect('error' in parseCode('')).toBe(true);
  });

  it('judges status without coercion', () => {
    expect(parseStatus('inactive')).toEqual({ value: 'inactive' });
    expect('error' in parseStatus('deleted')).toBe(true);
  });

  it('requires a name in every supported locale and rejects unknown locales', () => {
    const ok = parseTranslations(full);
    expect('value' in ok && ok.value.es.description).toBeNull();
    expect('error' in parseTranslations({ en: full.en, es: full.es })).toBe(true);
    expect('error' in parseTranslations({ ...full, fr: { name: 'x' } })).toBe(true);
  });
});
