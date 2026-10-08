import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1285 — `authenticateWithGoogleOneTap()` only returns a sign-in/sign-up
// resource. Without `handleGoogleOneTapCallback()` the session is never activated
// and the member is left on the login with no error (reproduced on the iOS
// simulator after Google's sheet had succeeded). Source-level gate, in the API
// suite because CI runs `npm test` in `api/` only.
const hook = readFileSync(
  join(__dirname, '..', '..', '..', 'apps', 'member', 'src', 'lib', 'useNativeGoogleSignIn.ts'), 'utf-8',
).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('#1285 native Google sign-in finishes what Clerk starts', () => {
  it('hands the resource to handleGoogleOneTapCallback, after authenticating', () => {
    const authenticate = hook.indexOf('authenticateWithGoogleOneTap(');
    const finish = hook.indexOf('handleGoogleOneTapCallback(');
    expect(authenticate).toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(authenticate);
    expect(hook).toMatch(/const resource = await .*authenticateWithGoogleOneTap/);
    expect(hook).toMatch(/handleGoogleOneTapCallback\(resource,/);
  });

  it('lands on the locale\'s home for both a sign-in and a transfer to sign-up', () => {
    expect(hook).toContain('signInFallbackRedirectUrl: `/${locale}`');
    expect(hook).toContain('signUpFallbackRedirectUrl: `/${locale}`');
  });
});
