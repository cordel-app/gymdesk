import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MOBILE_BUILD_PLATFORMS,
  MOBILE_BUILD_RETENTION,
  MOBILE_BUILDS_FOLDER,
  isListedBuildKey,
  parseTestFlightUrl,
  SIDECAR_OPTIONAL_FIELDS,
  SIDECAR_REQUIRED_FIELDS,
  buildIdFromKey,
  compareBuilds,
  downloadContentType,
  downloadFilename,
  keyFromBuildId,
  mobileBuildsPrefix,
  parseBuildSidecar,
} from '../domain/mobileBuilds';

// #1077 — what a published mobile build is, which key a download may name, and the
// sidecar the workflow writes. The route's own tests are `mobile-builds.test.ts`.

const PREFIX = mobileBuildsPrefix();
const FILE_KEY = `${PREFIX}com.cordel.fitness.dev/android/cordel-fitness-dev-1.0.0-b57-ab12cd34.apk`;
const SIDECAR_KEY = `${FILE_KEY}.json`;

function sidecar(overrides: Record<string, unknown> = {}) {
  return {
    app_id: 'com.cordel.fitness.dev',
    app_name: 'Cordel Fitness Dev',
    environment: 'dev',
    platform: 'android',
    version: '1.0.0',
    build_number: 57,
    git_sha: 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12',
    built_at: '2026-10-08T17:01:27Z',
    file: 'cordel-fitness-dev-1.0.0-b57-ab12cd34.apk',
    sha256: 'a'.repeat(64),
    signer_sha1: '904af43a0d4a4667fe3368552deb947e27b98747',
    run_url: 'https://github.com/cordel-app/gymdesk/actions/runs/1',
    ...overrides,
  };
}

describe('the builds prefix', () => {
  it('sits under the platform root, never a gym’s folder', () => {
    expect(PREFIX).toBe('cordel/mobile-builds/');
    expect(MOBILE_BUILD_RETENTION).toBe(20);
  });
});

describe('build ids', () => {
  it('round-trip a build file key', () => {
    const id = buildIdFromKey(FILE_KEY) as string;
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(keyFromBuildId(id)).toBe(FILE_KEY);
  });

  it('refuse a key outside the prefix', () => {
    expect(buildIdFromKey('gyms/abc/members.png')).toBeNull();
  });

  it.each([
    ['a path above the prefix', '../gyms/x/android/file.apk'],
    ['a dot-segment', 'app/android/..'],
    ['a dot-dot inside a name', 'app/android/a..b.apk'],
    ['too few segments', 'app/file.apk'],
    ['too many segments', 'app/android/sub/file.apk'],
    ['an unknown platform', 'app/windows/file.apk'],
    ['an unsafe character', 'app/android/fi le.apk'],
    ['the sidecar itself', 'app/android/file.apk.json'],
  ])('refuse %s', (_label, relative) => {
    const id = Buffer.from(relative, 'utf8').toString('base64url');
    expect(keyFromBuildId(id)).toBeNull();
  });

  it('refuse anything that is not base64url', () => {
    expect(keyFromBuildId('')).toBeNull();
    expect(keyFromBuildId('not base64!')).toBeNull();
    expect(keyFromBuildId('a'.repeat(500))).toBeNull();
  });

  it('refuse a non-canonical spelling of a valid id', () => {
    const id = buildIdFromKey(FILE_KEY) as string;
    // The same bytes with padding appended must not name the same object.
    expect(keyFromBuildId(`${id}==`)).toBeNull();
  });
});

describe('which platforms are listed', () => {
  it('lists Android only: an iPhone gets TestFlight and the simulator build is a CI check', () => {
    expect([...MOBILE_BUILD_PLATFORMS]).toEqual(['android']);
    expect(isListedBuildKey(SIDECAR_KEY)).toBe(true);
    expect(isListedBuildKey(`${PREFIX}com.cordel.fitness.dev/ios_simulator/a.zip.json`)).toBe(false);
    expect(isListedBuildKey(`${PREFIX}com.cordel.fitness.dev/ios/a.ipa.json`)).toBe(false);
  });

  it('only counts sidecars of the right shape under the prefix', () => {
    expect(isListedBuildKey(FILE_KEY)).toBe(false);
    expect(isListedBuildKey('gyms/g1/android/a.apk.json')).toBe(false);
    expect(isListedBuildKey(`${PREFIX}app/android/sub/a.apk.json`)).toBe(false);
  });
});

describe('parseTestFlightUrl()', () => {
  it('accepts a TestFlight link and nothing else', () => {
    expect(parseTestFlightUrl('https://testflight.apple.com/join/AbCd1234')).toBe('https://testflight.apple.com/join/AbCd1234');
    expect(parseTestFlightUrl('  https://testflight.apple.com/join/AbCd1234  ')).toBe('https://testflight.apple.com/join/AbCd1234');
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['another host', 'https://evil.example/join/x'],
    ['a lookalike host', 'https://testflight.apple.com.evil.example/join/x'],
    ['http', 'http://testflight.apple.com/join/x'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['no path', 'https://testflight.apple.com/'],
    ['not a URL', 'testflight'],
  ])('answers null for %s', (_label, value) => {
    expect(parseTestFlightUrl(value as string | undefined)).toBeNull();
  });
});

describe('download headers', () => {
  it('say what the file is', () => {
    expect(downloadContentType('a.apk')).toBe('application/vnd.android.package-archive');
    expect(downloadContentType('a.zip')).toBe('application/zip');
    expect(downloadContentType('a.ipa')).toBe('application/octet-stream');
    expect(downloadFilename(FILE_KEY)).toBe('cordel-fitness-dev-1.0.0-b57-ab12cd34.apk');
  });
});

describe('parseBuildSidecar()', () => {
  it('describes a build from a complete sidecar', () => {
    const build = parseBuildSidecar(sidecar(), SIDECAR_KEY, 7_567_046);
    expect(build).toMatchObject({
      app_id: 'com.cordel.fitness.dev',
      platform: 'android',
      version: '1.0.0',
      build_number: 57,
      size_bytes: 7_567_046,
      signer_sha1: '904af43a0d4a4667fe3368552deb947e27b98747',
      built_at: '2026-10-08T17:01:27.000Z',
    });
    expect(keyFromBuildId(build!.id)).toBe(FILE_KEY);
  });

  it.each(SIDECAR_REQUIRED_FIELDS.map((f) => [f]))('drops a sidecar missing %s', (field) => {
    const doc: Record<string, unknown> = sidecar();
    delete doc[field];
    expect(parseBuildSidecar(doc, SIDECAR_KEY, 1)).toBeNull();
  });

  it('keeps a build whose optional fields are absent', () => {
    const doc: Record<string, unknown> = sidecar();
    for (const field of SIDECAR_OPTIONAL_FIELDS) delete doc[field];
    expect(parseBuildSidecar(doc, SIDECAR_KEY, 1)).toMatchObject({ sha256: null, signer_sha1: null, run_url: null });
  });

  it('drops a sidecar whose platform disagrees with its folder', () => {
    expect(parseBuildSidecar(sidecar({ platform: 'ios_simulator' }), SIDECAR_KEY, 1)).toBeNull();
  });

  it('drops a sidecar that describes another file or another app', () => {
    expect(parseBuildSidecar(sidecar({ file: 'other.apk' }), SIDECAR_KEY, 1)).toBeNull();
    expect(parseBuildSidecar(sidecar({ app_id: 'com.cordel.fitness' }), SIDECAR_KEY, 1)).toBeNull();
  });

  it('drops a bad build number or time', () => {
    expect(parseBuildSidecar(sidecar({ build_number: 'x' }), SIDECAR_KEY, 1)).toBeNull();
    expect(parseBuildSidecar(sidecar({ build_number: -1 }), SIDECAR_KEY, 1)).toBeNull();
    expect(parseBuildSidecar(sidecar({ built_at: 'yesterday' }), SIDECAR_KEY, 1)).toBeNull();
  });

  it('never turns a stored value into a non-https link', () => {
    expect(parseBuildSidecar(sidecar({ run_url: 'javascript:alert(1)' }), SIDECAR_KEY, 1)!.run_url).toBeNull();
    expect(parseBuildSidecar(sidecar({ run_url: 'http://example.com' }), SIDECAR_KEY, 1)!.run_url).toBeNull();
  });

  it('is not fooled by a non-object or by a key that is not a sidecar', () => {
    expect(parseBuildSidecar(null, SIDECAR_KEY, 1)).toBeNull();
    expect(parseBuildSidecar([], SIDECAR_KEY, 1)).toBeNull();
    expect(parseBuildSidecar(sidecar(), FILE_KEY, 1)).toBeNull();
  });
});

describe('compareBuilds()', () => {
  it('lists the newest first, then by build number', () => {
    const mk = (built_at: string, build_number: number, file: string) =>
      parseBuildSidecar(
        sidecar({ built_at, build_number, file }),
        `${PREFIX}com.cordel.fitness.dev/android/${file}.json`,
        1,
      )!;
    const a = mk('2026-10-08T10:00:00Z', 5, 'a.apk');
    const b = mk('2026-10-08T12:00:00Z', 4, 'b.apk');
    const c = mk('2026-10-08T12:00:00Z', 9, 'c.apk');
    expect([a, b, c].sort(compareBuilds).map((x) => x.file)).toEqual(['c.apk', 'b.apk', 'a.apk']);
  });
});

// The workflow is the only writer, so the two halves have to agree. A sidecar the parser
// refuses is a build that silently never appears, which nothing at runtime would report.
describe('the publishing workflow writes what the API reads', () => {
  const ROOT = join(__dirname, '..', '..', '..', '.github');
  const script = readFileSync(join(ROOT, 'scripts', 'publish-mobile-build.sh'), 'utf8');
  const workflow = readFileSync(join(ROOT, 'workflows', 'mobile-build.yml'), 'utf8');

  it('lays files out where the API lists them', () => {
    expect(script).toContain(`ROOT="cordel/${MOBILE_BUILDS_FOLDER}"`);
    expect(script).toContain('PREFIX="$ROOT/$APP_ID/$BUILD_PLATFORM"');
    expect(script).toContain('KEY="$PREFIX/$BUILD_FILE"');
    expect(script).toContain('$KEY.json"');
  });

  it.each([...SIDECAR_REQUIRED_FIELDS])('writes the required sidecar field %s', (field) => {
    expect(script).toMatch(new RegExp(`\\b${field}:`));
  });

  it('keeps the retention the page advertises', () => {
    expect(script).toContain(`KEEP=${MOBILE_BUILD_RETENTION}`);
  });

  it('publishes only platforms the API knows, and never from a pull request', () => {
    const platforms = [...workflow.matchAll(/BUILD_PLATFORM:\s*(\S+)/g)].map((m) => m[1]);
    expect(platforms.sort()).toEqual(['android']);
    for (const p of platforms) expect(MOBILE_BUILD_PLATFORMS as readonly string[]).toContain(p);
    const steps = workflow.split('Publish to Cordel');
    expect(steps.length - 1).toBe(1);
    for (const step of steps.slice(1)) {
      expect(step.slice(0, 200)).toContain("if: github.event_name != 'pull_request'");
    }
  });

  it('forwards the TestFlight link to the deployed API', () => {
    const deploy = readFileSync(join(ROOT, 'workflows', 'deploy.yml'), 'utf8');
    expect(deploy).toContain('MOBILE_TESTFLIGHT_URL: ${{ vars.MOBILE_TESTFLIGHT_URL }}');
    expect(deploy).toContain('MOBILE_TESTFLIGHT_URL=${MOBILE_TESTFLIGHT_URL:-}');
    expect(deploy).toMatch(/envs:[^\n]*\bMOBILE_TESTFLIGHT_URL\b/);
  });

  it('numbers builds from the run and names them by version, build and commit', () => {
    expect(workflow).toContain('BUILD_NUMBER=${{ github.run_number }}');
    expect(workflow).toContain('-PversionCode="$BUILD_NUMBER"');
    expect(workflow).toContain('CURRENT_PROJECT_VERSION="$BUILD_NUMBER"');
    expect(workflow).toContain('${BUILD_VERSION}-b${BUILD_NUMBER}-${GITHUB_SHA::8}');
  });
});
