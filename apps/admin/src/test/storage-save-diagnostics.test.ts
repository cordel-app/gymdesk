import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { formatStorageError, formatStorageErrorLine } from '../lib/storageErrorMessage';
import {
  STORAGE_FAILURE_CAUSES,
  isStorageFailureCause,
  storageCauseSuggestsInitialize,
  storageFailureCause,
} from '../lib/storageFailureCause';
import { formatThemeAssetFailure, initializeSuggestedByFailures } from '../components/themes/themeAssetSave';

// #1042 — the complaint is one screenshot: `Saving the theme failed. /
// Operation: Save theme configuration / Error: Theme not found (404)`. It names
// the step (#824 did that much) and nothing else: not why it failed, not what
// the administrator is supposed to do about it, and certainly not that the one
// action that would fix the commonest cause — Initialize bucket — is sitting in
// a context menu they have no reason to open.
//
// So every storage failure now carries a `cause`, and the block carries a *Why*
// and a *What you can do* line built from it. The rule that shapes all of it is
// §4: the initialization suggestion may only appear when the failure is
// evidence that storage was never initialized, which is why an undiagnosed
// error renders exactly as it did before and why the button is gated on the
// cause rather than on the step.
//
// The pure halves are asserted directly; the wiring is pinned by scanning
// sources, as the rest of apps/admin's tests do (no component test infra).

const ROOT = join(__dirname, '..');
const LOCALES_DIR = join(ROOT, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const read = (...parts: string[]) => stripComments(readFileSync(join(ROOT, ...parts), 'utf-8'));

const customPage = read('app', '[locale]', 'themes', 'page.tsx');
const basePage = read('app', '[locale]', 'system', 'themes', 'page.tsx');
const apiCause = stripComments(
  readFileSync(join(ROOT, '..', '..', '..', 'api', 'src', 'domain', 'storageFailureCause.ts'), 'utf-8'),
);

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, Record<string, unknown>>>;

const LABELS = {
  title: 'Logo upload failed.',
  operation: 'Operation',
  path: 'Path',
  error: 'Error',
  details: 'Details',
  operationName: 'Upload logo',
  cause: 'Cause',
  suggestion: 'What you can do',
};

describe('storageFailureCause() (#1042 §2, §4)', () => {
  it('takes the cause the route stated, whatever the status is', () => {
    // The load-bearing one: a 409 is *also* "a theme with this name already
    // exists", so only the route can say that this one was missing storage.
    expect(storageFailureCause({ status: 409, body: { stage: 'resolve_path', cause: 'not_initialized' } }))
      .toBe('not_initialized');
    expect(storageFailureCause({ status: 503, body: { cause: 'not_configured' } })).toBe('not_configured');
    expect(storageFailureCause({ status: 502, body: { cause: 'access_denied' } })).toBe('access_denied');
  });

  it('diagnoses what a status says on its own', () => {
    expect(storageFailureCause({ status: 404, body: { error: 'Theme not found' } })).toBe('not_found');
    expect(storageFailureCause({ status: 401, body: { error: 'Unauthorized' } })).toBe('access_denied');
    expect(storageFailureCause({ status: 403 })).toBe('access_denied');
    expect(storageFailureCause({ status: 415 })).toBe('invalid_file');
    expect(storageFailureCause({ status: 413 })).toBe('invalid_file');
    expect(storageFailureCause({ status: 504 })).toBe('unreachable');
  });

  it('answers null for an ambiguous status rather than guessing', () => {
    // A 409 with no cause is a name conflict or a status downgrade; a 400 with
    // no cause is a rejected field, not a rejected file. Guessing either would
    // put a wrong explanation — and, for the 409, a wrong button — on screen.
    expect(storageFailureCause({ status: 409, body: { error: 'A theme with this name already exists' } })).toBeNull();
    expect(storageFailureCause({ status: 400, body: { error: 'status must be one of: draft, active' } })).toBeNull();
    expect(storageFailureCause({ status: 418 })).toBeNull();
    expect(storageFailureCause({})).toBeNull();
    expect(storageFailureCause(null)).toBeNull();
  });

  it('ignores a cause outside the vocabulary', () => {
    expect(storageFailureCause({ status: 404, body: { cause: 'something_else' } })).toBe('not_found');
    expect(isStorageFailureCause('something_else')).toBe(false);
  });

  it('offers Initialize for exactly one cause', () => {
    const suggesting = STORAGE_FAILURE_CAUSES.filter((c) => storageCauseSuggestsInitialize(c));
    expect(suggesting).toEqual(['not_initialized']);
    expect(storageCauseSuggestsInitialize(null)).toBe(false);
  });
});

describe('the block says why and what to do (#1042 §1, §8)', () => {
  it('adds the two lines beneath what already failed', () => {
    const message = formatStorageError(
      {
        message: 'Cloudflare storage has not been initialized for this gym',
        status: 409,
        body: {
          error: 'Cloudflare storage has not been initialized for this gym',
          stage: 'resolve_path',
          cause: 'not_initialized',
        },
      },
      {
        ...LABELS,
        operationName: 'Resolve the gym/theme storage path',
        causeName: 'The Cloudflare storage structure this theme needs does not exist yet.',
        suggestionText: 'Initialize this theme’s Cloudflare storage and save again.',
      },
    );
    expect(message).toContain('Operation: Resolve the gym/theme storage path');
    expect(message).toContain('Cause: The Cloudflare storage structure this theme needs does not exist yet.');
    expect(message).toContain('What you can do: Initialize this theme’s Cloudflare storage and save again.');
    // §8: the raw particulars stay the secondary section, under the sentences.
    expect(message.indexOf('Cause:')).toBeLessThan(message.indexOf('What you can do:'));
  });

  it('leaves an undiagnosed failure exactly as #824 rendered it', () => {
    const message = formatStorageError(
      { message: 'A theme with this name already exists', status: 409, body: { error: 'A theme with this name already exists' } },
      { ...LABELS, causeName: null, suggestionText: null },
    );
    expect(message).toContain('Error: A theme with this name already exists (409)');
    expect(message).not.toContain('Cause:');
    expect(message).not.toContain('What you can do:');
  });

  it('renders neither line when the caller passes no labels for them', () => {
    // #830's toast and any caller written before this ticket.
    const message = formatStorageError({ message: 'boom', status: 502 }, {
      title: 'x', operation: 'Operation', path: 'Path', error: 'Error', details: 'Details', operationName: 'Upload logo',
    });
    expect(message).not.toContain('Cause');
    expect(message).not.toContain('What you can do');
  });

  it('keeps the one-line form one line (#828)', () => {
    const line = formatStorageErrorLine(
      { message: 'NoSuchBucket', status: 502, body: { stage: 'upload_logo', cause: 'not_initialized' } },
      { ...LABELS, causeName: 'Storage is missing.', suggestionText: 'Initialize it.' },
    );
    expect(line).not.toContain('\n');
    expect(line).toContain('Cause: Storage is missing. · What you can do: Initialize it.');
  });
});

describe('an asset failure is diagnosed per failure, not per operation (#1042)', () => {
  const assetLabels = {
    operation: 'Operation',
    path: 'Path',
    error: 'Error',
    details: 'Details',
    cause: 'Cause',
    suggestion: 'What you can do',
    title: () => 'Members image upload failed (training).',
    operationName: (_op: unknown, stage: string) => `stage:${stage}`,
    diagnosis: (err: any) => {
      const cause = storageFailureCause(err);
      return cause ? { causeName: `why:${cause}`, suggestionText: `do:${cause}` } : null;
    },
  } as any;

  const op = { kind: 'members_image_upload', slot: 'training', file: new Blob() } as any;

  it('reads the cause off the error rather than off the step', () => {
    const message = formatThemeAssetFailure(
      { op, error: { status: 502, body: { stage: 'upload_members_image', cause: 'access_denied' } } },
      assetLabels,
    );
    expect(message).toContain('Operation: stage:upload_members_image');
    expect(message).toContain('Cause: why:access_denied');
    expect(message).toContain('What you can do: do:access_denied');
  });

  it('offers Initialize only when one of the failures is missing storage', () => {
    const denied = { op, error: { status: 403 } };
    const missing = { op, error: { status: 502, body: { cause: 'not_initialized' } } };
    expect(initializeSuggestedByFailures([denied])).toBe(false);
    expect(initializeSuggestedByFailures([])).toBe(false);
    // One of four assets failing for want of storage is enough to offer it.
    expect(initializeSuggestedByFailures([denied, missing])).toBe(true);
  });
});

describe('both Theme screens wire the diagnosis and the action (#1042 §3, §6)', () => {
  it.each([
    { name: 'Custom Themes page', src: () => customPage },
    { name: 'Base Themes page', src: () => basePage },
  ])('$name resolves the cause through its own namespace', ({ src }) => {
    const page = src();
    expect(page).toContain('const cause = storageFailureCause(err);');
    expect(page).toContain('t(`storage_cause_${cause}` as any)');
    expect(page).toContain('t(`storage_suggestion_${cause}` as any)');
    // The pair reaches the three formatters: the block, the toast line and the
    // shared asset report — a screen that wired only one would say why a logo
    // failed and not why a Members image did.
    expect(page.match(/causeName: diagnosis\?\.causeName \?\? null,/g) ?? []).toHaveLength(2);
    expect(page).toContain('diagnosis: storageDiagnosis,');
  });

  it.each([
    { name: 'Custom Themes page', src: () => customPage },
    { name: 'Base Themes page', src: () => basePage },
  ])('$name offers Initialize only on the diagnosed cause', ({ src }) => {
    const page = src();
    expect(page).toContain('initializeSuggested && (');
    expect(page).toContain("{t('action_initialize_bucket')}");
    // Set from the cause, never from the stage that failed.
    expect(page).toContain('setInitializeSuggested(initializeSuggestedByFailures(failures));');
    expect(page).toContain('setInitializeSuggested(storageCauseSuggestsInitialize(storageFailureCause(err)));');
    // …and cleared whenever the failures it belongs to are.
    const clears = page.match(/setAssetFailures\(\[\]\);\s*\n\s*setInitializeSuggested\(false\);/g) ?? [];
    expect(clears.length).toBeGreaterThanOrEqual(3);
    expect(page.match(/setAssetFailures\(\[\]\);/g) ?? []).toHaveLength(clears.length);
  });

  it('neither screen decides the cause for itself', () => {
    for (const page of [customPage, basePage]) {
      expect(page).not.toMatch(/status === 404/);
      expect(page).not.toMatch(/body\?\.cause ===/);
    }
  });
});

describe('the API and the admin share one cause vocabulary (#1042)', () => {
  it('the two declarations agree', () => {
    const declared = Array.from(apiCause.matchAll(/^ {2}'([a-z_]+)',$/gm)).map((m) => m[1]);
    expect(declared).toEqual([...STORAGE_FAILURE_CAUSES]);
  });

  it('only `not_initialized` is allowed to offer Initialize on the API side too', () => {
    expect(apiCause).toContain("return cause === 'not_initialized';");
  });
});

describe('every cause has a sentence in every locale (#1042 §10)', () => {
  // The keys are interpolated from the wire value and next-intl prints a
  // missing key verbatim — a cause with no key would put
  // `themes.storage_cause_unreachable` on screen.
  it.each(LOCALE_CODES)('%s carries both lines and every cause in both theme namespaces', (code) => {
    for (const ns of ['themes', 'gym_themes']) {
      const bundle = locales[code][ns];
      expect(bundle).toHaveProperty('storage_error_cause');
      expect(bundle).toHaveProperty('storage_error_suggestion');
      for (const cause of STORAGE_FAILURE_CAUSES) {
        expect(bundle).toHaveProperty(`storage_cause_${cause}`);
        expect(bundle).toHaveProperty(`storage_suggestion_${cause}`);
      }
    }
  });

  it.each(LOCALE_CODES)('%s points a gym at its own bucket and the platform at the theme alone', (code) => {
    // The one sentence that genuinely differs between the two screens: a
    // Custom Theme's assets live in the gym's bucket (which Gym Bucket
    // Initialization owns, #735), a Base Theme's under the platform root.
    expect(String(locales[code].gym_themes.storage_suggestion_not_initialized).length)
      .toBeGreaterThan(String(locales[code].themes.storage_suggestion_not_initialized).length);
  });
});
