import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  failedMembersImageSlots,
  formatThemeAssetFailure,
  formatThemeAssetFailures,
  keepBySlot,
  keepFlagsBySlot,
  logoAssetFailed,
  pendingAfterFailures,
  planThemeAssetOps,
  runThemeAssetOps,
  themeAssetOpRequest,
  themeAssetOpStage,
  themeAssetOpTitle,
  type ThemeAssetDraft,
  type ThemeAssetFailure,
  type ThemeAssetLabels,
  type ThemeAssetOp,
} from '@/components/themes/themeAssetSave';
import { MEMBER_IMAGE_SLOTS, type MemberImageSlot } from '@/components/ThemeMembersImagesEditor';

// #830 — a failed Theme asset upload has to say what broke, and one asset
// failing must not take the others with it.
//
// Two defects, both reproduced below. The visible one: a Base Theme's logo is
// bytes served by `GET /themes/:id/logo`, and both Next proxies read every
// backend response with `res.text()` — a UTF-8 decode of binary, which is why
// the editor rendered the ticket's `[broken image] logo preview`. The quiet one:
// each Theme screen carried its own copy of the Save sequence, so the Base
// Themes page removed a logo and a Members slot with no diagnostic at all, and
// the first failure aborted every asset after it.
//
// The shared module is pure (its two requests arrive as callbacks), so it is
// asserted directly; the wiring is pinned by scanning sources, as the rest of
// apps/admin's tests do (no component test infra — docs/architecture.md's TL;DR).

const ROOT = join(__dirname, '..');
const LOCALES_DIR = join(ROOT, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const NAMESPACES = ['gym_themes', 'themes'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const read = (...parts: string[]) => stripComments(readFileSync(join(ROOT, ...parts), 'utf-8'));

const customPage = read('app', '[locale]', 'themes', 'page.tsx');
const basePage = read('app', '[locale]', 'system', 'themes', 'page.tsx');
const brandingEditor = read('components', 'ThemeSectionEditor.tsx');
const membersEditor = read('components', 'ThemeMembersImagesEditor.tsx');
const adminProxy = read('app', 'api', 'proxy', '[...path]', 'route.ts');
const memberProxy = stripComments(
  readFileSync(join(ROOT, '..', '..', 'member', 'src', 'app', 'api', 'proxy', '[...path]', 'route.ts'), 'utf-8'),
);

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, Record<string, string>>>;

const bySlot = <T>(value: T) =>
  Object.fromEntries(MEMBER_IMAGE_SLOTS.map((slot) => [slot, value])) as Record<MemberImageSlot, T>;

const emptyDraft = (): ThemeAssetDraft => ({
  logoFile: null,
  logoRemovePending: false,
  membersImageFiles: bySlot<Blob | null>(null),
  membersImageRemovals: bySlot(false),
});

const file = (name: string) => new Blob([name], { type: 'image/png' });

const LABELS: ThemeAssetLabels = {
  operation: 'Operation',
  path: 'Path',
  error: 'Error',
  details: 'Details',
  fallbackError: 'Failed to upload the image. Please try again.',
  title: (op) => {
    const { key, slot } = themeAssetOpTitle(op);
    return slot ? `${key}[${slot}]` : key;
  },
  operationName: (_op, stage) => `stage:${stage}`,
};

describe('planThemeAssetOps() (#830)', () => {
  it('plans nothing for an untouched draft', () => {
    expect(planThemeAssetOps(emptyDraft())).toEqual([]);
  });

  it('puts the logo first and the slots in the order the editor shows them', () => {
    const draft = emptyDraft();
    draft.logoFile = file('logo');
    for (const slot of MEMBER_IMAGE_SLOTS) draft.membersImageFiles[slot] = file(slot);

    expect(planThemeAssetOps(draft).map((op) => ('slot' in op ? op.slot : op.kind))).toEqual([
      'logo_upload',
      ...MEMBER_IMAGE_SLOTS,
    ]);
  });

  it('plans only the assets the admin touched', () => {
    const draft = emptyDraft();
    draft.membersImageFiles.nutrition = file('nutrition');
    draft.membersImageRemovals.calendar = true;

    expect(planThemeAssetOps(draft)).toEqual([
      { kind: 'members_image_upload', slot: 'nutrition', file: draft.membersImageFiles.nutrition },
      { kind: 'members_image_remove', slot: 'calendar' },
    ]);
  });

  it('never deletes an asset the admin has just replaced', () => {
    // Picking clears the removal in both editors, so the state below cannot be
    // produced from the UI — but a plan that emitted both would delete the object
    // the upload just wrote.
    const draft = emptyDraft();
    draft.logoFile = file('logo');
    draft.logoRemovePending = true;
    draft.membersImageFiles.training = file('training');
    draft.membersImageRemovals.training = true;

    expect(planThemeAssetOps(draft).map((op) => op.kind)).toEqual(['logo_upload', 'members_image_upload']);
  });
});

describe('themeAssetOpRequest() (#830)', () => {
  it('addresses a Custom Theme under the gym router root', () => {
    const logo = file('logo');
    expect(themeAssetOpRequest({ kind: 'logo_upload', file: logo }, '/system/themes', 'th1')).toEqual({
      method: 'POST',
      path: '/system/themes/th1/logo',
      file: logo,
    });
    expect(themeAssetOpRequest({ kind: 'members_image_remove', slot: 'bookings' }, '/system/themes', 'th1')).toEqual({
      method: 'DELETE',
      path: '/system/themes/th1/members-images/bookings',
      file: null,
    });
  });

  it('addresses a Base Theme under the platform router root', () => {
    const img = file('training');
    expect(
      themeAssetOpRequest({ kind: 'members_image_upload', slot: 'training', file: img }, '/platform/themes', 'th2'),
    ).toEqual({ method: 'POST', path: '/platform/themes/th2/members-images/training', file: img });
    expect(themeAssetOpRequest({ kind: 'logo_remove' }, '/platform/themes', 'th2')).toEqual({
      method: 'DELETE',
      path: '/platform/themes/th2/logo',
      file: null,
    });
  });

  it('gives every slot its own fixed path, for both theme kinds', () => {
    for (const basePath of ['/system/themes', '/platform/themes']) {
      for (const slot of MEMBER_IMAGE_SLOTS) {
        const req = themeAssetOpRequest({ kind: 'members_image_upload', slot, file: file(slot) }, basePath, 'th');
        expect(req.path).toBe(`${basePath}/th/members-images/${slot}`);
      }
    }
  });
});

describe('runThemeAssetOps() (#830)', () => {
  const io = (reject: (path: string) => boolean) => {
    const attempted: string[] = [];
    return {
      attempted,
      basePath: '/system/themes',
      themeId: 'th1',
      upload: async (path: string) => {
        attempted.push(`POST ${path}`);
        if (reject(path)) throw Object.assign(new Error('Unauthorized'), { status: 401 });
      },
      remove: async (path: string) => {
        attempted.push(`DELETE ${path}`);
        if (reject(path)) throw Object.assign(new Error('Unauthorized'), { status: 401 });
      },
    };
  };

  it('attempts every asset even when one fails, and reports all failures', async () => {
    const draft = emptyDraft();
    draft.logoFile = file('logo');
    draft.membersImageFiles.training = file('training');
    draft.membersImageFiles.nutrition = file('nutrition');
    draft.membersImageRemovals.calendar = true;
    const target = io((path) => path.endsWith('/training') || path.endsWith('/logo'));

    const result = await runThemeAssetOps(planThemeAssetOps(draft), target);

    // The rejected `training` upload did not stop `nutrition` or the `calendar`
    // removal — the whole of §Upload Independence.
    expect(target.attempted).toEqual([
      'POST /system/themes/th1/logo',
      'POST /system/themes/th1/members-images/training',
      'POST /system/themes/th1/members-images/nutrition',
      'DELETE /system/themes/th1/members-images/calendar',
    ]);
    expect(result.failures.map((f) => f.op.kind)).toEqual(['logo_upload', 'members_image_upload']);
    expect(result.succeeded.map((op) => ('slot' in op ? op.slot : op.kind))).toEqual(['nutrition', 'calendar']);
  });

  it('never throws, so a caller cannot lose the other failures', async () => {
    const draft = emptyDraft();
    for (const slot of MEMBER_IMAGE_SLOTS) draft.membersImageFiles[slot] = file(slot);

    const result = await runThemeAssetOps(planThemeAssetOps(draft), io(() => true));

    expect(result.failures).toHaveLength(MEMBER_IMAGE_SLOTS.length);
    expect(result.succeeded).toEqual([]);
  });

  it('carries the API error through untouched, so the diagnostic can use it', async () => {
    const body = { error: 'Bucket has not been initialized', stage: 'resolve_path', path: 'gyms/1-QSport' };
    const result = await runThemeAssetOps([{ kind: 'logo_remove' }], {
      basePath: '/platform/themes',
      themeId: 'th',
      upload: async () => undefined,
      remove: async () => {
        throw Object.assign(new Error('Bucket has not been initialized'), { status: 409, body });
      },
    });

    expect(result.failures[0].error.body).toEqual(body);
    expect(result.failures[0].error.status).toBe(409);
  });
});

describe('formatThemeAssetFailures() (#830)', () => {
  it('names the slot, the step the API reported, the path and the storage detail', () => {
    const failure: ThemeAssetFailure = {
      op: { kind: 'members_image_upload', slot: 'nutrition', file: file('nutrition') },
      error: {
        message: 'Failed to upload image',
        status: 502,
        body: {
          error: 'Failed to upload image',
          stage: 'create_members_folder',
          path: 'cordel/Themes/456-CrimsonBase/Members/nutrition.png',
          details: { name: 'AccessDenied', httpStatusCode: 403, bucket: 'gymdesk', requestId: 'req-9' },
        },
      },
    };

    expect(formatThemeAssetFailure(failure, LABELS)).toBe(
      [
        'storage_error_title_members_image_slot[nutrition]',
        '',
        'Operation: stage:create_members_folder',
        'Path: cordel/Themes/456-CrimsonBase/Members/nutrition.png',
        'Error: Failed to upload image (403)',
        'Details: AccessDenied — bucket: gymdesk — request: req-9',
      ].join('\n'),
    );
  });

  it('names the operation itself when the failure never reached storage', () => {
    // A bare 401 from `tenantContext` carries no `stage`, which is the case the
    // ticket describes as "only displays Unauthorized".
    const message = formatThemeAssetFailure(
      { op: { kind: 'logo_upload', file: file('logo') }, error: { message: 'Unauthorized', status: 401 } },
      LABELS,
    );

    expect(message).toContain('storage_error_title_logo');
    expect(message).toContain('Operation: stage:upload_logo');
    expect(message).toContain('Error: Unauthorized (401)');
  });

  it('falls back to a clear sentence when the failure carries nothing usable', () => {
    const message = formatThemeAssetFailure(
      { op: { kind: 'members_image_remove', slot: 'calendar' }, error: {} },
      LABELS,
    );

    expect(message).toContain('storage_error_title_members_image_remove_slot[calendar]');
    expect(message).toContain('Error: Failed to upload the image. Please try again.');
  });

  it('reports every failure of one Save, not just the first', () => {
    const failures: ThemeAssetFailure[] = [
      { op: { kind: 'logo_upload', file: file('logo') }, error: { message: 'Unauthorized', status: 401 } },
      { op: { kind: 'members_image_upload', slot: 'membership', file: file('m') }, error: { message: 'Boom', status: 502 } },
    ];

    const text = formatThemeAssetFailures(failures, LABELS);

    expect(text).toContain('storage_error_title_logo');
    expect(text).toContain('storage_error_title_members_image_slot[membership]');
    expect(text.split('\n\n')).toHaveLength(4); // two blocks, each with its own blank line
  });
});

describe('what stays queued after a partial Save (#830)', () => {
  const failures: ThemeAssetFailure[] = [
    { op: { kind: 'members_image_upload', slot: 'training', file: file('training') }, error: {} },
    { op: { kind: 'members_image_remove', slot: 'calendar' }, error: {} },
  ];

  it('keeps exactly the assets that failed', () => {
    const pending = pendingAfterFailures(failures);

    expect(pending.logoUpload).toBe(false);
    expect(pending.logoRemove).toBe(false);
    expect([...pending.slotUploads]).toEqual(['training']);
    expect([...pending.slotRemovals]).toEqual(['calendar']);
  });

  it('drops the files that were stored and keeps the one that was not', () => {
    const files = bySlot<Blob | null>(null);
    files.training = file('training');
    files.nutrition = file('nutrition');

    const kept = keepBySlot(files, pendingAfterFailures(failures).slotUploads);

    expect(kept.training).toBe(files.training);
    expect(kept.nutrition).toBeNull();
  });

  it('keeps only the removals that failed', () => {
    const kept = keepFlagsBySlot(pendingAfterFailures(failures).slotRemovals);

    expect(kept.calendar).toBe(true);
    expect(kept.bookings).toBe(false);
  });

  it('marks the controls that failed and no others', () => {
    expect(logoAssetFailed(failures)).toBe(false);
    expect(logoAssetFailed([{ op: { kind: 'logo_remove' }, error: {} }])).toBe(true);

    const slots = failedMembersImageSlots(failures);
    expect(slots.training).toBe(true);
    expect(slots.calendar).toBe(true);
    expect(slots.nutrition).toBe(false);
  });
});

describe('the Next proxies forward bytes, never text (#830)', () => {
  // The root cause of `[broken image] logo preview`: a Base Theme's logo is a
  // blob served as raw bytes by `GET /themes/:id/logo`, and a `res.text()` read
  // replaces every byte that is not valid UTF-8 with U+FFFD. The response still
  // carries the right `Content-Type`, so nothing errors — the browser simply
  // cannot decode the image. The Admin proxy also carries the receipt PDFs
  // (`pdfFetch` calls `res.blob()` on it), which had the same problem.
  for (const [name, src] of [['admin', adminProxy], ['member', memberProxy]] as const) {
    it(`${name}: reads the response as an ArrayBuffer`, () => {
      expect(src).toContain('await res.arrayBuffer()');
      expect(src).not.toContain('await res.text()');
    });
  }
});

describe('both Theme screens save assets through the shared module (#830)', () => {
  for (const [name, page] of [['Custom Themes', customPage], ['Base Themes', basePage]] as const) {
    it(`${name}: plans and runs the assets with runThemeAssetOps()`, () => {
      expect(page).toContain('planThemeAssetOps(');
      expect(page).toContain('runThemeAssetOps(');
      expect(page).toContain('formatThemeAssetFailures(');
    });

    it(`${name}: has no per-asset upload or removal sequence of its own`, () => {
      // The endpoints are the shared module's now — a second copy here is how
      // the two screens drifted into one having diagnostics and the other not.
      expect(page).not.toContain('/members-images/');
      expect(page).not.toMatch(/uploadFetch\(`[^`]*\/logo`/);
    });

    it(`${name}: keeps the failed assets queued and marks their controls`, () => {
      expect(page).toContain('pendingAfterFailures(');
      expect(page).toContain('logoError={logoAssetFailed(assetFailures)}');
      expect(page).toContain('slotErrors={failedMembersImageSlots(assetFailures)}');
    });

    it(`${name}: still names the router root itself`, () => {
      // #806's rule: the shared code names no endpoint and makes no permission
      // decision, so the gym's module permissions and `requireSuperadmin` stay
      // on the pages.
      expect(page).toMatch(/basePath: '\/(system|platform)\/themes'/);
    });
  }
});

describe('a preview that cannot load says so (#830)', () => {
  it('the logo preview handles onError instead of showing a broken image', () => {
    expect(brandingEditor).toContain('onError={() => setFailedPreviewSrc(logoPreview)}');
    expect(brandingEditor).toContain("t('logo_preview_unavailable')");
  });

  it('both editors mark the asset whose save failed', () => {
    expect(brandingEditor).toContain("t('asset_save_failed')");
    expect(membersEditor).toContain("t('asset_save_failed')");
    expect(membersEditor).toContain('slotErrors');
  });
});

describe('every key #830 interpolates exists in both namespaces (en/es/ca)', () => {
  // next-intl prints a missing key verbatim, so a heading or a stage name with no
  // key would render `gym_themes.storage_stage_upload_logo` at the admin.
  const OPS: ThemeAssetOp[] = [
    { kind: 'logo_upload', file: file('logo') },
    { kind: 'logo_remove' },
    { kind: 'members_image_upload', slot: 'training', file: file('training') },
    { kind: 'members_image_remove', slot: 'training' },
  ];
  const KEYS = [
    ...OPS.map((op) => themeAssetOpTitle(op).key),
    ...OPS.map((op) => `storage_stage_${themeAssetOpStage(op)}`),
    ...MEMBER_IMAGE_SLOTS.map((slot) => `members_image_${slot}`),
    'storage_error_operation',
    'storage_error_path',
    'storage_error_error',
    'storage_error_details',
    'storage_error_fallback',
    'logo_preview_unavailable',
    'asset_save_failed',
  ];

  for (const code of LOCALE_CODES) {
    for (const ns of NAMESPACES) {
      it(`${code}.${ns} carries them all`, () => {
        const missing = KEYS.filter((key) => typeof locales[code][ns]?.[key] !== 'string');
        expect(missing).toEqual([]);
      });
    }
  }

  it('the slot headings interpolate the slot name', () => {
    for (const code of LOCALE_CODES) {
      for (const ns of NAMESPACES) {
        expect(locales[code][ns].storage_error_title_members_image_slot).toContain('{slot}');
        expect(locales[code][ns].storage_error_title_members_image_remove_slot).toContain('{slot}');
      }
    }
  });
});
