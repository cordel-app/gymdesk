// #1026 — **Member** is the canonical term on screen: `Member`/`Members` in
// English, `Miembro`/`Miembros` in Spanish, `Membre`/`Membres` in Catalan.
//
// Spanish said `Socio`/`Socios` and Catalan `Soci`/`Socis` in a minority of
// strings while `miembro`/`membre` already carried the great majority of them,
// so this is the gate that keeps the two from drifting apart again. It judges
// locale **values** only: the keys are English identifiers and `members.*` /
// `MEMBERS` are the domain's own names, which the ticket keeps unchanged.
//
// The compound names of *other* entities moved with it, to the wording the same
// files already used elsewhere — `cuota de socio` → `cuota de membresía`,
// `plan de socio` → `plan de membresía`, and the Catalan `membresia` forms —
// so no retired word is left anywhere in the copy and the gate needs no
// allowlist.
//
// `api/src/lib/receipt-pdf.ts`'s `'Socio'` fallback is deliberately out of
// scope and out of this gate: it is the placeholder printed where a person's
// *name* goes on a Spanish fiscal receipt, not a label of the Members domain,
// and #1026's acceptance criteria hold the API unchanged.
//
// It lives in the API suite rather than beside the admin tests because CI runs
// `npm test` in `api/` only (the admin job type-checks and builds), the same
// reason `product-terminology.unit.test.ts` beside this file does.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..', '..');
const LOCALE_FILES = ['admin', 'member'].flatMap((app) =>
  ['en', 'es', 'ca'].map((code) => ({
    label: `apps/${app}/locales/base/${code}.json`,
    path: join(REPO, 'apps', app, 'locales', 'base', `${code}.json`),
  })),
);

const PRIVACY = {
  label: 'apps/admin/src/app/[locale]/privacy/privacyContent.ts',
  path: join(REPO, 'apps', 'admin', 'src', 'app', '[locale]', 'privacy', 'privacyContent.ts'),
};

/**
 * The retired Spanish and Catalan words for the Member entity, as whole words
 * in any casing. Word boundaries are what keep ordinary vocabulary out of it:
 * `social`, `sociedad`, `asociado`, `societat` and `associació` all contain
 * these letters and none of them is the entity.
 */
const RETIRED = [/\bsocios?\b/i, /\bsocis?\b/i];

/** Every leaf string of a locale file, as `namespace.key` → value. */
function values(path: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (node: unknown, prefix: string) => {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const at = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'string') out.push([at, value]);
      else if (value && typeof value === 'object') walk(value, at);
    }
  };
  walk(JSON.parse(readFileSync(path, 'utf8')), '');
  return out;
}

const offenders = (path: string, label: string) =>
  values(path)
    .filter(([, value]) => RETIRED.some((re) => re.test(value)))
    .map(([at, value]) => `${label}: ${at} = ${JSON.stringify(value)}`);

describe('Member is the canonical term in user-facing copy (#1026)', () => {
  for (const { label, path } of LOCALE_FILES) {
    it(`${label} says Member, not Socio/Soci`, () => {
      expect(offenders(path, label)).toEqual([]);
    });
  }

  it('the privacy policy says it too, since its copy is not in a locale file', () => {
    const source = readFileSync(PRIVACY.path, 'utf8');
    const hits = source
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => RETIRED.some((re) => re.test(line)))
      .map(([n, line]) => `${PRIVACY.label}:${n}: ${line.trim()}`);
    expect(hits).toEqual([]);
  });

  it('reads the copy it claims to check', () => {
    // Without this the gate passes vacuously if a locale file moves or the
    // walker stops descending.
    for (const { label, path } of LOCALE_FILES) {
      expect(values(path).length, `${label} produced no strings`).toBeGreaterThan(100);
    }
    const byLocale = new Map(
      LOCALE_FILES.filter(({ label }) => label.startsWith('apps/admin')).map(({ label, path }) => [
        label,
        new Map(values(path)),
      ]),
    );
    expect(byLocale.get('apps/admin/locales/base/en.json')?.get('nav.members')).toBe('Members');
    expect(byLocale.get('apps/admin/locales/base/es.json')?.get('nav.members')).toBe('Miembros');
    expect(byLocale.get('apps/admin/locales/base/ca.json')?.get('nav.members')).toBe('Membres');
    expect(readFileSync(PRIVACY.path, 'utf8')).toContain('miembros');
  });

  it('would catch each wording the rename removed, and no ordinary word', () => {
    for (const retired of [
      'Socios',
      'Socios eliminados',
      '+ Añadir socio',
      'Este socio no tiene pagos registrados.',
      'Cuota de Socio',
      'Socis',
      'Afegir soci',
      'Plans de soci elegibles',
      'els seus socis',
    ]) {
      expect(RETIRED.some((re) => re.test(retired)), `missed ${retired}`).toBe(true);
    }
    for (const kept of [
      'Miembros',
      '+ Añadir miembro',
      'Membres',
      'Afegir membre',
      'Cuota de membresía',
      'Quota de membresia',
      'Red social', // ordinary vocabulary, not the entity
      'Sociedad limitada',
      'Un socorrista', // the letters, not the word
      'Societat anònima',
      "L'associació",
    ]) {
      expect(RETIRED.some((re) => re.test(kept)), `false positive on ${kept}`).toBe(false);
    }
  });
});
