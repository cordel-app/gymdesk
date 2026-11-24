import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1077: the signed Android release build (`android-release` in
// `.github/workflows/mobile-build.yml`). In the API suite because CI runs
// `npm test` in `api/` only. The job holds the Play upload key, so it must never
// run for a pull request, must take every secret as `env:` rather than
// interpolating one into a script, and must not publish to Cordel → Mobile
// builds, which lists installable APKs.

const ROOT = join(__dirname, '..', '..', '..');
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'mobile-build.yml'), 'utf8');
const gradle = readFileSync(join(ROOT, 'apps', 'mobile', 'android', 'app', 'build.gradle'), 'utf8');

/** The text of one top-level job, up to the next job. */
function jobBlock(name: string): string {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  expect(start, `job ${name} is missing`).toBeGreaterThan(-1);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[a-z0-9-]+:\s*$/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/** Every `run:` script body of a job, joined. */
function runScripts(job: string): string {
  const out: string[] = [];
  const lines = job.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (!m) continue;
    if (m[2] && m[2] !== '|') { out.push(m[2]); continue; }
    const indent = m[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && lines[j].search(/\S/) <= indent) break;
      out.push(lines[j]);
    }
  }
  return out.join('\n');
}

describe('the Android release job', () => {
  const job = jobBlock('android-release');

  it('never runs for a pull request, and only on a tag or an explicit request', () => {
    const condition = job.match(/^ {4}if:\s*(.+)$/m)?.[1] ?? '';
    expect(condition).toContain("github.event_name != 'pull_request'");
    expect(condition).toContain("startsWith(github.ref, 'refs/tags/mobile-v')");
    expect(condition).toContain('inputs.release');
  });

  it('builds a release bundle and checks its signer', () => {
    expect(job).toContain('./gradlew bundleRelease');
    expect(job).toContain('keytool -printcert -jarfile');
    expect(job).toContain('ANDROID_UPLOAD_KEY_SHA256');
  });

  it('interpolates no secret into a script', () => {
    expect(runScripts(job)).not.toMatch(/\$\{\{\s*secrets\./);
  });

  it('does not publish to Cordel → Mobile builds', () => {
    expect(job).not.toContain('publish-mobile-build.sh');
  });

  it('uploads to Play only on the internal track, for the profile’s own app id', () => {
    expect(job).toMatch(/track:\s*internal/);
    expect(job).toContain('packageName: ${{ env.APP_ID }}');
  });

  it('is a self-hosted-free job (it holds a signing key)', () => {
    expect(job).not.toContain('self-hosted');
  });
});

describe('the Firebase config (push)', () => {
  for (const name of ['android', 'android-release']) {
    it(`${name} writes google-services.json from the environment before applying the profile`, () => {
      const job = jobBlock(name);
      expect(job).toContain('GOOGLE_SERVICES_JSON_B64: ${{ secrets.GOOGLE_SERVICES_JSON_B64 }}');
      const write = job.indexOf('google-services.json"');
      expect(write).toBeGreaterThan(-1);
      expect(write).toBeLessThan(job.indexOf('npm run profile:apply'));
      expect(runScripts(job)).not.toMatch(/\$\{\{\s*secrets\./);
    });
  }
});

describe('the Gradle release signing', () => {
  it('reads the upload key from the environment and commits none', () => {
    for (const name of [
      'ANDROID_UPLOAD_KEYSTORE_PATH',
      'ANDROID_UPLOAD_STORE_PASSWORD',
      'ANDROID_UPLOAD_KEY_ALIAS',
      'ANDROID_UPLOAD_KEY_PASSWORD',
    ]) {
      expect(gradle).toContain(`System.getenv('${name}')`);
    }
    expect(gradle).not.toMatch(/storePassword\s+['"]/);
    expect(gradle).not.toMatch(/keyPassword\s+['"]/);
  });

  it('signs the release build type only when a key is present', () => {
    expect(gradle).toMatch(/if \(hasUploadKey\) \{\s*signingConfig signingConfigs\.release/);
  });
});
