import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { navigationGroups } from '../config/navigationGroups';
import {
  downloadPath, environmentLabelKey, formatBuildVersion, formatBytes, platformLabelKey,
  shortSha, showsAndroidInstallHelp, testflightHref, type MobileBuild,
} from '../lib/mobileBuilds';
import en from '../../locales/base/en.json';
import es from '../../locales/base/es.json';
import ca from '../../locales/base/ca.json';

// #1077 — Cordel → Mobile builds.

const LOCALES = { en, es, ca } as Record<string, any>;
const PAGE = readFileSync(join(__dirname, '..', 'app', '[locale]', 'cordel', 'mobile-builds', 'page.tsx'), 'utf-8');

function build(overrides: Partial<MobileBuild> = {}): MobileBuild {
  return {
    id: 'abc', app_id: 'com.cordel.fitness.dev', app_name: 'Cordel Fitness Dev', environment: 'dev',
    platform: 'android', version: '1.0.0', build_number: 57, git_sha: 'ab12cd34ef56ab12',
    built_at: '2026-10-08T17:00:00.000Z', file: 'a.apk', size_bytes: 7_567_046,
    sha256: null, signer_sha1: null, run_url: null, ...overrides,
  };
}

describe('how a build is worded', () => {
  it('names a build by version and CI build number, and its commit', () => {
    expect(formatBuildVersion(build())).toBe('1.0.0 (57)');
    expect(shortSha('ab12cd34ef56ab12')).toBe('ab12cd34');
  });

  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(812)).toBe('812 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(7_567_046)).toBe('7.2 MB');
    expect(formatBytes(NaN)).toBe('0 B');
  });

  it('keys the one published platform', () => {
    expect(platformLabelKey('android')).toBe('platform_android');
  });

  it('puts a TestFlight link behind the iPhone button and nothing else', () => {
    expect(testflightHref('https://testflight.apple.com/join/AbCd1234')).toBe('https://testflight.apple.com/join/AbCd1234');
    expect(testflightHref(null)).toBeNull();
    expect(testflightHref(undefined)).toBeNull();
    expect(testflightHref('')).toBeNull();
    expect(testflightHref('https://evil.example/join/x')).toBeNull();
    expect(testflightHref('https://testflight.apple.com.evil.example/join/x')).toBeNull();
    expect(testflightHref('http://testflight.apple.com/join/x')).toBeNull();
    expect(testflightHref('javascript:alert(1)')).toBeNull();
  });

  it('has a word for dev and pro and none for anything else', () => {
    expect(environmentLabelKey('dev')).toBe('env_dev');
    expect(environmentLabelKey('pro')).toBe('env_pro');
    expect(environmentLabelKey('staging')).toBeNull();
  });

  it('shows the Android steps only when there is an Android build', () => {
    expect(showsAndroidInstallHelp([build()])).toBe(true);
    expect(showsAndroidInstallHelp([])).toBe(false);
  });

  it('downloads through the platform route, with the id encoded', () => {
    expect(downloadPath({ id: 'a_b-c' })).toBe('/platform/mobile-builds/a_b-c/download');
  });
});

describe('the Cordel nav', () => {
  it('lists Mobile builds in the superadmin-only Cordel group', () => {
    const cordel = navigationGroups.find((g) => g.id === 'cordel')!;
    expect(cordel.requiredRole).toBe('superadmin');
    const item = cordel.items.find((i) => i.href === '/{{locale}}/cordel/mobile-builds');
    expect(item?.labelKey).toBe('nav.mobile_builds');
  });
});

describe('labels', () => {
  const keysUsed = [...PAGE.matchAll(/\bt\('([a-z0-9_]+)'/g)].map((m) => m[1]);
  const dynamic = ['platform_android', 'env_dev', 'env_pro'];

  it.each(Object.keys(LOCALES))('%s has every key the page resolves, and the nav label', (locale) => {
    const ns = LOCALES[locale].mobile_builds;
    for (const key of [...new Set([...keysUsed, ...dynamic])]) {
      expect(typeof ns[key], `${locale}: mobile_builds.${key}`).toBe('string');
    }
    expect(LOCALES[locale].nav.mobile_builds).toBeTruthy();
  });

  it('uses the same keys in all three languages', () => {
    const keys = (l: string) => Object.keys(LOCALES[l].mobile_builds).sort();
    expect(keys('es')).toEqual(keys('en'));
    expect(keys('ca')).toEqual(keys('en'));
  });
});

describe('the page', () => {
  it('is read-only: it fetches and downloads, it never writes', () => {
    expect(PAGE).toContain("apiFetch('/platform/mobile-builds')");
    expect(PAGE).toContain('pdfFetch(downloadPath(build))');
    expect(PAGE).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
  });

  it('offers TestFlight as a link, disabled until there is one, and never a download for iOS', () => {
    expect(PAGE).toContain('const testflight = testflightHref(data?.testflight_url);');
    expect(PAGE).toContain('href={testflight}');
    expect(PAGE).toContain('disabled style={{ ...primaryBtnSmall(), opacity: 0.5');
    expect(PAGE).not.toMatch(/ios_simulator|platformNoteKey/);
  });

  it('is for superadmins only', () => {
    expect(PAGE).toContain('if (!gymLoading && !isSuperadmin) router.replace');
  });

  it('only ever links to an https build log', () => {
    // The API drops a non-https run_url; the page renders what it is given as a link
    // with rel=noopener, never as markup.
    expect(PAGE).toContain('rel="noopener noreferrer"');
    expect(PAGE).not.toContain('dangerouslySetInnerHTML');
  });
});
