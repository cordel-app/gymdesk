import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { DEVICE_PLATFORMS } from '../domain/deviceTokens';

// #1073 (mobile app WP2) — everything native in the Members App sits behind two
// modules, and a plain browser never executes native code
// (`docs/mobile-app.md` design rule 3).
//
// This gate lives in the API suite for #1009's reason, the same one that put
// `members-app-theme-consumption.unit.test.ts` here: CI runs `npm test` in
// `api/` only, so a scan that has to hold on **every** push belongs here even
// when what it scans is a frontend. The Members App's own suite
// (`apps/member/src/test/native.test.ts`) asserts the rules themselves — what
// `isNative()` answers, what a registration body is, which path a link becomes;
// this one asserts that nothing bypasses the two modules, and that the platform
// vocabulary the browser sends is the one this API accepts.

const MEMBER_SRC = join(__dirname, '..', '..', '..', 'apps', 'member', 'src');

/** The *access* half: the only file allowed to import a Capacitor package. */
const PLUGINS = 'lib/nativePlugins.ts';

/** The *decision* half: pure, so it is the one that may be read from anywhere. */
const NATIVE = 'lib/native.ts';

/** Any Capacitor or Capgo package, however it is imported. */
const PLUGIN_PACKAGE = /['"]@(?:capacitor|capgo)\/[a-z-]+['"]/g;

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

/** The file with its comments removed, so a comment naming a package does not
 * read as an import. */
function withoutComments(relative: string): string {
  return readFileSync(join(MEMBER_SRC, relative), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

describe('the Members App keeps native code behind two modules (#1073)', () => {
  const files = walk(MEMBER_SRC);

  it('scans the whole app, so a new screen is covered by default', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain(NATIVE);
    expect(files).toContain(PLUGINS);
  });

  it('imports a Capacitor package in exactly one file', () => {
    // A plugin imported from a page would be evaluated during SSR and in every
    // browser, which is the whole of what "a plain browser never executes native
    // code" rules out. The test file beside it names the packages on purpose.
    const offenders = files.filter(
      (relative) =>
        relative !== PLUGINS &&
        !relative.startsWith('test/') &&
        PLUGIN_PACKAGE.test(withoutComments(relative)),
    );
    expect(offenders, `${offenders.join(', ')} imports a plugin — go through lib/nativePlugins.ts`).toEqual([]);
  });

  it('loads every one of them dynamically', () => {
    // `await import()` still ships the package — which it must, since a page
    // loaded from a remote URL gets no `registerPlugin` from the injected bridge
    // — but nothing is evaluated on the server or in a browser that never asks.
    const plugins = withoutComments(PLUGINS);
    expect(plugins).not.toMatch(/^\s*import\s+[^;]*from\s+['"]@(?:capacitor|capgo)\//m);
    for (const pkg of ['@capacitor/app', '@capacitor/push-notifications', '@capgo/capacitor-social-login']) {
      expect(plugins, `${pkg} is not loaded dynamically`).toContain(`await import('${pkg}')`);
    }
  });

  it('keeps the decision half pure, so it can be read from anywhere', () => {
    // No React, no router, no plugin: `lib/native.ts` is the module a page, a
    // component or an effect asks instead of reading `window.Capacitor` or
    // sniffing a user agent.
    const native = withoutComments(NATIVE);
    expect(native).not.toMatch(/from\s+['"]react['"]/);
    expect(native).not.toMatch(/from\s+['"]next\//);
    expect(native).not.toMatch(PLUGIN_PACKAGE);
  });

  it('declares the platforms this API accepts, and no others', () => {
    // Detection and the registered platform are one answer: the value that makes
    // the app "native" is the value `POST /me/devices` is called with, so a
    // platform the browser could report and `chk_mdt_platform` would refuse must
    // not exist on either side. Adding one means adding it here, in the CHECK,
    // and in the Members App's own list.
    const declaration = withoutComments(NATIVE).match(/NATIVE_PLATFORMS = \[([^\]]*)\]/);
    expect(declaration, 'lib/native.ts no longer declares NATIVE_PLATFORMS').not.toBeNull();
    const declared = [...declaration![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(declared).toEqual([...DEVICE_PLATFORMS]);
  });

  it('never asks whether it is native while rendering', () => {
    // The bridge does not exist on the server, so a render-time answer makes the
    // server emit the web markup and the client the native markup — a hydration
    // mismatch React resolves by discarding the client tree. `useIsNative()` is
    // the one way a component may branch on it.
    const hook = withoutComments('lib/useIsNative.ts');
    expect(hook).toContain('useState(false)');
    expect(hook).toContain('useEffect');

    for (const relative of files) {
      if (!relative.startsWith('components/') && !relative.startsWith('app/')) continue;
      const src = withoutComments(relative);
      if (!src.includes('isNative(')) continue;
      // A component may *act* natively inside an effect; what it may not do is
      // decide its markup on it.
      const callsHook = src.includes('useIsNative(');
      const callsDirectly = /(?<!useIs)[^a-zA-Z]isNative\(\)/.test(src);
      expect(
        callsHook || callsDirectly,
        `${relative} references isNative in an unexpected shape`,
      ).toBe(true);
      if (callsDirectly) {
        expect(src, `${relative} calls isNative() outside an effect`).toContain('useEffect');
      }
    }
  });
});
