// #1052 — Website Integration moved from the gym's Configuration group to
// Cordel → Gyms → [Gym]. It is a relocation and nothing else: the same routes,
// the same `website_integration` copy in all three languages, the same
// once-only key, the same two confirmations.
//
// apps/admin has no component-test infra (docs/architecture.md TL;DR), so the
// structural half is pinned by scanning the sources, as the other placement
// tests here do.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { navigationGroups } from '@/config/navigationGroups';

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const sectionSrc = stripComments(
  readFileSync(join(SRC, 'components', 'gyms', 'GymWebsiteIntegrationSection.tsx'), 'utf-8'),
);
const gymsPageSrc = stripComments(
  readFileSync(join(SRC, 'app', '[locale]', 'system', 'gyms', 'page.tsx'), 'utf-8'),
);
const apiClientSrc = stripComments(readFileSync(join(SRC, 'lib', 'apiClient.ts'), 'utf-8'));

const messages = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], any>;

describe('#1052: Website Integration leaves Configuration', () => {
  it('is no longer an item of any navigation group', () => {
    const hrefs = navigationGroups.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).not.toContain('/{{locale}}/website-integration');
    const labels = navigationGroups.flatMap((g) => g.items.map((i) => i.labelKey));
    expect(labels).not.toContain('nav.website_integration');
  });

  it('leaves the rest of the Configuration group exactly as it was', () => {
    const system = navigationGroups.find((g) => g.id === 'system');
    expect(system).toBeDefined();
    expect(system!.items.map((i) => i.href)).toEqual([
      '/{{locale}}/audit',
      '/{{locale}}/themes',
      '/{{locale}}/recycle-bin',
    ]);
  });

  it('has no standalone page left to reach it from', () => {
    expect(existsSync(join(SRC, 'app', '[locale]', 'website-integration'))).toBe(false);
  });

  it('drops the now-unused nav label in all three languages', () => {
    for (const code of LOCALE_CODES) {
      expect(messages[code].nav.website_integration, code).toBeUndefined();
    }
  });
});

describe('#1052: the gym card is where it lives now', () => {
  it('renders the section on the expanded gym card, for that row’s gym', () => {
    expect(gymsPageSrc).toContain('<GymWebsiteIntegrationSection gymId={gym.id} />');
    expect(gymsPageSrc).toContain("import { GymWebsiteIntegrationSection } from '@/components/gyms/GymWebsiteIntegrationSection'");
  });

  it('titles the section with the feature’s own copy rather than a second wording', () => {
    expect(gymsPageSrc).toContain("useTranslations('website_integration')");
    expect(gymsPageSrc).toContain("<SectionHeader title={tWebsite('title')} />");
  });

  it('sits inside the read-only expanded body, after Storage and before Notes', () => {
    const storage = gymsPageSrc.indexOf("title={t('section_storage')}");
    const website = gymsPageSrc.indexOf('<GymWebsiteIntegrationSection');
    const notes = gymsPageSrc.indexOf("title={t('section_notes')}");
    expect(storage).toBeGreaterThan(-1);
    expect(website).toBeGreaterThan(storage);
    expect(notes).toBeGreaterThan(website);
  });

  it('does not restate the gym list read — the section loads its own status', () => {
    expect(gymsPageSrc).not.toContain('/system/website-integration');
  });
});

describe('#1052: the section keeps the existing functionality', () => {
  it('calls the same three routes, unchanged', () => {
    expect(sectionSrc).toContain("const ROOT = '/system/website-integration'");
    expect(sectionSrc).toContain('apiFetch<WebsiteIntegrationStatus>(ROOT, { gymId })');
    expect(sectionSrc).toContain("`${ROOT}/key`, { method: 'POST', gymId }");
    expect(sectionSrc).toContain("`${ROOT}/key`, { method: 'DELETE', gymId }");
  });

  it('addresses the row’s gym on every request, never the selected one', () => {
    const calls = [...sectionSrc.matchAll(/apiFetch<[^>]*>\(([^;]*?)\);/g)].map((m) => m[1]);
    expect(calls.length).toBe(3);
    for (const call of calls) expect(call).toContain('gymId');
  });

  it('reads once per gym — the effect is keyed on the gym and the client', () => {
    expect(sectionSrc).toContain('}, [apiFetch, gymId]);');
    // A toast function and a translator are not reasons to re-read: they are
    // reached through refs so they cannot key the effect.
    expect(sectionSrc).toContain('toastRef.current(');
    expect(sectionSrc).toContain('let cancelled = false;');
  });

  it('shows the plaintext key once and never persists it', () => {
    expect(sectionSrc).toContain("const [newKey, setNewKey] = useState<string | null>(null)");
    expect(sectionSrc).toContain("t('key_shown_once')");
    // Cleared whenever the section loads, and by a revoke.
    expect(sectionSrc).toContain('setNewKey(null);');
    expect(sectionSrc).not.toContain('localStorage');
  });

  it('keeps the endpoint, its copy action and the path-only hint', () => {
    expect(sectionSrc).toContain("t('endpoint_label')");
    expect(sectionSrc).toContain('copy(endpoint)');
    expect(sectionSrc).toContain("t('endpoint_path_only')");
    // The URL is the API's (#645): nothing is assembled in the browser.
    expect(sectionSrc).toContain('status.endpoint_url ?? status.endpoint_path');
    expect(sectionSrc).not.toContain('/public/gyms/');
  });

  it('keeps the key state, both write actions and the connection instructions', () => {
    for (const key of ['key_none', 'generate', 'rotate', 'revoke', 'how_label', 'how_1', 'how_5']) {
      expect(sectionSrc, key).toContain(`t('${key}')`);
    }
    // The active-key sentence keeps its own interpolation (prefix + date).
    expect(sectionSrc).toContain("t('key_active', { prefix:");
  });

  it('confirms rotate and revoke in the app’s own dialog', () => {
    expect(sectionSrc).toContain('<ConfirmDialog');
    expect(sectionSrc).toContain("t('confirm_revoke') : t('confirm_rotate')");
    expect([...sectionSrc.matchAll(/<ConfirmDialog/g)]).toHaveLength(1);
  });

  it('wears the app’s theme: no lilac, and the primary action is the shared one', () => {
    expect(sectionSrc).toContain('primaryBtnSmall()');
    expect(sectionSrc).not.toContain('#6c63ff');
    expect(sectionSrc).not.toContain("btnStyle(");
    // Destructive keeps its own colour, as every other Revoke/Remove does.
    expect(sectionSrc).toContain("btnSmall('#c0392b')");
  });

  it('keeps every string a key of the one namespace, in all three languages', () => {
    const keys = [...sectionSrc.matchAll(/\bt\('([a-z0-9_]+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    for (const code of LOCALE_CODES) {
      const ns = messages[code].website_integration;
      expect(ns, code).toBeDefined();
      for (const key of keys) expect(ns[key], `${code}.${key}`).toBeTruthy();
    }
  });
});

describe('#1052: apiFetch is the one place a Cordel screen names a gym', () => {
  it('accepts a per-request gym that overrides the selected one', () => {
    expect(apiClientSrc).toContain('export interface ApiFetchOptions extends RequestInit');
    expect(apiClientSrc).toContain('gymId?: string;');
    expect(apiClientSrc).toContain('const gymId = options.gymId ?? activeGymId;');
    expect(apiClientSrc).toContain("if (gymId) headers['x-gym-id'] = gymId;");
  });

  it('keeps the header out of the page', () => {
    expect(sectionSrc).not.toContain('x-gym-id');
    expect(gymsPageSrc).not.toContain('x-gym-id');
  });

  it('does not forward the override to fetch as a request option', () => {
    expect(apiClientSrc).toContain('const { gymId: _gymId, ...init } = options;');
  });

  it('leaves the binary and PDF helpers on the selected gym', () => {
    // #824/#787: neither takes a gym — no Cordel screen uploads or downloads
    // on another gym's behalf, and inventing the option would be unused surface.
    const upload = apiClientSrc.slice(apiClientSrc.indexOf('const uploadFetch'));
    expect(upload).toContain("headers['x-gym-id'] = activeGymId");
  });
});
