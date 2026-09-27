import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { formatStorageError } from '../lib/storageErrorMessage';

// #824 — two halves of the same complaint. A theme logo upload came back as a
// bare `Unauthorized` because every binary upload was a hand-rolled `fetch`
// that sent the bearer token and nothing else: the proxy forwards `x-gym-id`
// but cannot invent it, so `tenantContext` refused every one of them. And when
// something did go wrong in storage, the toast named neither the step nor the
// object.
//
// The formatter is pure, so it is asserted directly. The wiring is pinned by
// scanning sources, as the rest of apps/admin's tests do (no component test
// infra — docs/architecture.md's TL;DR).

const ROOT = join(__dirname, '..');
const LOCALES_DIR = join(ROOT, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const read = (...parts: string[]) => stripComments(readFileSync(join(ROOT, ...parts), 'utf-8'));

const apiClient = read('lib', 'apiClient.ts');
const customPage = read('app', '[locale]', 'themes', 'page.tsx');
const basePage = read('app', '[locale]', 'system', 'themes', 'page.tsx');

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
};

describe('formatStorageError() (#824)', () => {
  it('names the operation, the path, the status and the storage detail', () => {
    const message = formatStorageError(
      {
        message: 'Failed to upload logo: Unauthorized',
        status: 502,
        body: {
          error: 'Failed to upload logo: Unauthorized',
          stage: 'upload_logo',
          path: 'gyms/123-QSport/Themes/456-CrimsonBase/Logo/logo.png',
          details: {
            operation: 'uploadStorageObject',
            message: 'Unauthorized',
            name: 'AccessDenied',
            code: 'AccessDenied',
            httpStatusCode: 401,
            requestId: 'req-7',
            bucket: 'gym-bucket',
            key: 'gyms/123-QSport/Themes/456-CrimsonBase/Logo/logo.png',
          },
        },
      },
      LABELS,
    );

    expect(message).toContain('Logo upload failed.');
    expect(message).toContain('Operation: Upload logo');
    expect(message).toContain('Path: gyms/123-QSport/Themes/456-CrimsonBase/Logo/logo.png');
    // The status comes from the storage layer's own response, not the HTTP
    // status of our route — a 502 carrying a 401 from R2 is the interesting case.
    expect(message).toContain('Error: Failed to upload logo: Unauthorized (401)');
    expect(message).toContain('AccessDenied');
    expect(message).toContain('bucket: gym-bucket');
    expect(message).toContain('request: req-7');
  });

  it('falls back to the key when the body carries no explicit path', () => {
    const message = formatStorageError(
      { message: 'boom', status: 502, body: { details: { key: 'gyms/1-G/Themes/2-T/Logo/logo.png' } } },
      LABELS,
    );
    expect(message).toContain('Path: gyms/1-G/Themes/2-T/Logo/logo.png');
  });

  it('still says what it can for a failure that never reached storage', () => {
    // The reported defect: a 401 from `tenantContext`, with no stage, no path
    // and no details. It must not render as the single word `Unauthorized`.
    const message = formatStorageError({ message: 'Unauthorized', status: 401, body: { error: 'Unauthorized' } }, LABELS);
    expect(message).toContain('Logo upload failed.');
    expect(message).toContain('Operation: Upload logo');
    expect(message).toContain('Error: Unauthorized (401)');
    expect(message).not.toContain('Path:');
    expect(message).not.toContain('Details:');
  });

  it('lists the missing configuration of a 503', () => {
    const message = formatStorageError(
      { message: 'not configured', status: 503, body: { stage: 'resolve_path', missingConfig: ['CLOUDFLARE_R2_BUCKET'] } },
      { ...LABELS, operationName: 'Resolve the gym/theme storage path' },
    );
    expect(message).toContain('Operation: Resolve the gym/theme storage path');
    expect(message).toContain('missing: CLOUDFLARE_R2_BUCKET');
  });

  it('never repeats the same sentence as both Error and Details', () => {
    const message = formatStorageError(
      { message: 'boom', status: 502, body: { error: 'boom', details: { message: 'boom' } } },
      LABELS,
    );
    expect(message.match(/boom/g)).toHaveLength(1);
  });
});

describe('the binary upload carries the tenant headers (#824)', () => {
  it('useApiClient exposes one uploadFetch that sends gym, center, locale and impersonation', () => {
    expect(apiClient).toContain('const uploadFetch = useCallback(');
    const upload = apiClient.slice(apiClient.indexOf('const uploadFetch = useCallback('), apiClient.indexOf('const pdfFetch'));
    // The header that was missing, and the rest of the tenant context with it.
    expect(upload).toContain("headers['x-gym-id'] = activeGymId");
    expect(upload).toContain("headers['x-center-id']");
    expect(upload).toContain("headers['x-impersonate-as']");
    expect(upload).toContain("headers['x-locale'] = locale");
    expect(upload).toContain("headers['Authorization'] = `Bearer ${token}`");
    // The error has to carry the parsed body, or the diagnostic has nothing to read.
    expect(upload).toContain('{ status: res.status, body }');
    expect(apiClient).toContain('return { apiFetch, pdfFetch, uploadFetch };');
  });

  it.each([
    { name: 'Custom Themes page', src: () => customPage },
    { name: 'Base Themes page', src: () => basePage },
  ])('$name uploads through uploadFetch, never a hand-rolled fetch', ({ src }) => {
    const page = src();
    expect(page).toContain('uploadFetch(');
    // No page may assemble an upload request itself again — that is how the
    // gym header went missing in the first place.
    expect(page).not.toMatch(/fetch\(`\/api\/proxy[^`]*`,\s*\{\s*\n?\s*method: 'POST'/);
    expect(page).not.toContain('const token = await getToken();');
  });

  it.each([
    { name: 'Custom Themes page', src: () => customPage },
    { name: 'Base Themes page', src: () => basePage },
  ])('$name renders the diagnostic, honouring the stage the API reported', ({ src }) => {
    const page = src();
    expect(page).toContain('formatStorageError');
    expect(page).toContain('err.body?.stage ?? fallbackStage');
    expect(page).toContain('t(`storage_stage_${stage}`)');
    // A multi-line diagnostic collapses to one line without this.
    expect(page).toContain("whiteSpace: 'pre-line'");
  });
});

describe('every stage has a label in every locale (#824)', () => {
  // The key is interpolated from the stage the API sends, and next-intl prints
  // a missing key verbatim — a stage with no key would put
  // `themes.storage_stage_upload_logo` on screen.
  const STAGES = [
    'resolve_path',
    'create_theme_folder',
    'create_logo_folder',
    'create_members_folder',
    'upload_logo',
    'remove_logo',
    'upload_members_image',
    'remove_members_image',
    'save_settings',
  ];
  const LABEL_KEYS = [
    'storage_error_operation',
    'storage_error_path',
    'storage_error_error',
    'storage_error_details',
    'storage_error_title_settings',
    'storage_error_title_logo',
    'storage_error_title_logo_remove',
    'storage_error_title_members_image',
    'storage_error_title_members_image_remove',
  ];

  it.each(LOCALE_CODES)('%s carries every stage and label in both theme namespaces', (code) => {
    for (const ns of ['themes', 'gym_themes']) {
      const bundle = locales[code][ns];
      for (const stage of STAGES) expect(bundle).toHaveProperty(`storage_stage_${stage}`);
      for (const key of LABEL_KEYS) expect(bundle).toHaveProperty(key);
    }
  });
});
