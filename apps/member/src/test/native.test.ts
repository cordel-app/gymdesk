import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  NATIVE_PLATFORMS,
  appUrlOpenPath,
  bridgeNativePlatform,
  bridgePlatform,
  deviceRegistrationBody,
  googleIdToken,
  googleNativeConfig,
  isNative,
  isNativeBridge,
  isNativePlatform,
  nativePlatform,
  notificationTapPath,
} from '../lib/native';
import { MEMBER_LOCALES } from '../lib/memberLocale';
import { safeArea, withSafeArea } from '../lib/memberChrome';

// #1073 (mobile app WP2) — the Members App inside the native shell.
//
// Everything the app *decides* about running natively is pure and is asserted
// directly here (`lib/native.ts`); the wiring has no component-test infra in this
// repo (no testing-library, no jsdom), so the components and their call sites are
// pinned by scanning their source, exactly as `my-goals.test.ts` (#1036) and
// `my-nutrition-sections.test.ts` (#932) do.
//
// The acceptance criteria this file covers: `isNative()`, which sign-in button
// renders, and the token-registration payload.

const SRC = join(__dirname, '..');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

function read(...parts: string[]): string {
  return stripComments(readFileSync(join(SRC, ...parts), 'utf-8'));
}

function setBridge(bridge: unknown) {
  (globalThis as any).Capacitor = bridge;
}

afterEach(() => {
  delete (globalThis as any).Capacitor;
});

describe('isNative()', () => {
  it('is false with no bridge at all — every browser, and the server', () => {
    // The acceptance criterion in one assertion: a plain browser never executes
    // native code, because there is nothing to detect.
    expect(isNative()).toBe(false);
    expect(nativePlatform()).toBeNull();
  });

  it('is true inside the shell, on either platform', () => {
    for (const platform of NATIVE_PLATFORMS) {
      setBridge({ getPlatform: () => platform, isNativePlatform: () => true });
      expect(isNative()).toBe(true);
      expect(nativePlatform()).toBe(platform);
    }
  });

  it('reads the bridge the native side injects, which exposes `platform` rather than a getter', () => {
    // A remote page is handed the injected bridge, not the `@capacitor/core`
    // object — the spike's own finding, and the reason this module reads the
    // global structurally instead of importing the package.
    setBridge({ platform: 'iOS' });
    expect(isNative()).toBe(true);
    expect(nativePlatform()).toBe('ios');
  });

  it('is false for the web platform the bridge reports in a browser', () => {
    setBridge({ getPlatform: () => 'web', isNativePlatform: () => false });
    expect(isNative()).toBe(false);
  });

  it('is false for a platform the API could not register', () => {
    // Detection and the registered platform are one answer: `electron` is a
    // Capacitor target and is not a `member_device_tokens.platform`, so it reads
    // as not native rather than registering a value `chk_mdt_platform` refuses.
    setBridge({ getPlatform: () => 'electron', isNativePlatform: () => true });
    expect(isNative()).toBe(false);
    expect(nativePlatform()).toBeNull();
  });

  it('treats a bridge that throws as no bridge', () => {
    setBridge({ getPlatform: () => { throw new Error('bridge gone'); } });
    expect(isNative()).toBe(false);
  });

  it('answers the same question for a bridge passed in', () => {
    expect(isNativeBridge(null)).toBe(false);
    expect(isNativeBridge(undefined)).toBe(false);
    expect(isNativeBridge({})).toBe(false);
    expect(isNativeBridge({ platform: 'android' })).toBe(true);
    expect(bridgePlatform({ platform: '  Android  ' })).toBe('android');
    expect(bridgeNativePlatform({ platform: 'ios' })).toBe('ios');
  });

  it('keeps the platform vocabulary the API’s', () => {
    expect([...NATIVE_PLATFORMS]).toEqual(['ios', 'android']);
    expect(isNativePlatform('ios')).toBe(true);
    expect(isNativePlatform('web')).toBe(false);
  });
});

describe('the token-registration payload', () => {
  it('is the body POST /me/devices takes', () => {
    expect(deviceRegistrationBody('ios', 'fcm-token-value')).toEqual({
      platform: 'ios',
      token: 'fcm-token-value',
    });
  });

  it('omits app_id unless the shell names one, so the API applies its own default', () => {
    // `MOBILE_DEFAULT_APP_ID` is the deployment's (#1072); shipping a copy of
    // `com.cordel.fitness` in the browser bundle would be a second source of
    // truth for a value design rule 1 says is configuration.
    expect(deviceRegistrationBody('android', 'tok')).not.toHaveProperty('app_id');
    expect(deviceRegistrationBody('android', 'tok', '  com.gym.app  ')).toEqual({
      platform: 'android',
      token: 'tok',
      app_id: 'com.gym.app',
    });
    expect(deviceRegistrationBody('android', 'tok', '   ')).not.toHaveProperty('app_id');
  });

  it('trims the token, because a padded token is a different token to FCM', () => {
    expect(deviceRegistrationBody('ios', '  tok  ')).toEqual({ platform: 'ios', token: 'tok' });
  });

  it('is null for anything that could not be a registration', () => {
    // Not a coercion and not a thrown error: there is simply nothing to ask the
    // API, and a blank token would occupy its `UNIQUE (platform, token)`.
    expect(deviceRegistrationBody(null, 'tok')).toBeNull();
    expect(deviceRegistrationBody('web' as any, 'tok')).toBeNull();
    expect(deviceRegistrationBody('ios', '')).toBeNull();
    expect(deviceRegistrationBody('ios', '   ')).toBeNull();
    expect(deviceRegistrationBody('ios', null)).toBeNull();
  });
});

describe('appUrlOpenPath()', () => {
  it('routes an invitation link to /link with its query intact', () => {
    // The query is the invitation: dropping it turns a working link into
    // "no invitation found".
    expect(
      appUrlOpenPath('https://members.vdicube.com/en/link?gym_id=7&__clerk_ticket=abc', 'en'),
    ).toBe('/en/link?gym_id=7&__clerk_ticket=abc');
  });

  it('keeps the link’s own locale rather than the one the app is showing', () => {
    expect(appUrlOpenPath('https://members.vdicube.com/es/link?gym_id=7', 'en')).toBe('/es/link?gym_id=7');
    expect(appUrlOpenPath('https://members.vdicube.com/CA/notifications', 'en')).toBe('/ca/notifications');
  });

  it('prefixes the app’s locale when the link carries none', () => {
    expect(appUrlOpenPath('https://members.vdicube.com/notifications', 'ca')).toBe('/ca/notifications');
    expect(appUrlOpenPath('https://members.vdicube.com/', 'es')).toBe('/es');
    expect(appUrlOpenPath('https://members.vdicube.com', 'es')).toBe('/es');
  });

  it('leaves a path segment that merely looks like a page alone', () => {
    expect(appUrlOpenPath('https://members.vdicube.com/membership', 'en')).toBe('/en/membership');
  });

  it('routes a custom-scheme URL the same way', () => {
    // Until WP4's universal links, the link arrives through the app's scheme —
    // and a scheme URL has no meaningful origin to check, which is why the host
    // is not part of the decision.
    expect(appUrlOpenPath('com.cordel.fitness://link?gym_id=7', 'en')).toBe('/en/link?gym_id=7');
    expect(appUrlOpenPath('com.cordel.fitness://es/link?gym_id=7', 'en')).toBe('/es/link?gym_id=7');
  });

  it('preserves a hash', () => {
    expect(appUrlOpenPath('https://members.vdicube.com/en/profile#language', 'en')).toBe('/en/profile#language');
  });

  it('is null for anything it cannot turn into a path', () => {
    expect(appUrlOpenPath('', 'en')).toBeNull();
    expect(appUrlOpenPath('   ', 'en')).toBeNull();
    expect(appUrlOpenPath(null, 'en')).toBeNull();
    expect(appUrlOpenPath('not a url', 'en')).toBeNull();
  });

  it('recognises the app’s own locales and no others', () => {
    // One language system (#1039 §2): the list is `lib/memberLocale.ts`'s, so a
    // locale added there is recognised in a link with no change here.
    expect([...MEMBER_LOCALES]).toEqual(['en', 'es', 'ca']);
    expect(appUrlOpenPath('https://members.vdicube.com/fr/link', 'en')).toBe('/en/fr/link');
  });
});

describe('notificationTapPath()', () => {
  it('opens the Alerts page in the app’s locale', () => {
    expect(notificationTapPath('en')).toBe('/en/notifications');
    expect(notificationTapPath('ca')).toBe('/ca/notifications');
  });
});

describe('googleNativeConfig()', () => {
  const ios = 'ios-client.apps.googleusercontent.com';
  const web = 'web-client.apps.googleusercontent.com';

  it('initialises iOS with the app’s client and the web client as the audience', () => {
    // The spike's one hard finding: the ID token's `aud` must be the web client
    // Clerk holds, which is what `iOSServerClientId` sets.
    expect(
      googleNativeConfig(
        { NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID: ios, NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID: web },
        'ios',
      ),
    ).toEqual({ iOSClientId: ios, iOSServerClientId: web, webClientId: web });
  });

  it('is null on iOS when either id is missing, so no button is rendered', () => {
    expect(googleNativeConfig({ NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID: ios }, 'ios')).toBeNull();
    expect(googleNativeConfig({ NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID: web }, 'ios')).toBeNull();
    expect(googleNativeConfig({}, 'ios')).toBeNull();
  });

  it('asks Android for the web client alone', () => {
    expect(googleNativeConfig({ NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID: web }, 'android')).toEqual({ webClientId: web });
    expect(googleNativeConfig({ NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID: ios }, 'android')).toBeNull();
  });

  it('is null on the web, whatever is configured', () => {
    expect(
      googleNativeConfig(
        { NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID: ios, NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID: web },
        null,
      ),
    ).toBeNull();
  });
});

describe('googleIdToken()', () => {
  it('reads the token out of the plugin’s nested result', () => {
    expect(googleIdToken({ provider: 'google', result: { idToken: 'tok' } })).toBe('tok');
  });

  it('accepts a flat result too', () => {
    expect(googleIdToken({ idToken: 'tok' })).toBe('tok');
  });

  it('is null for a cancelled sheet, which is not an error', () => {
    expect(googleIdToken({ provider: 'google', result: {} })).toBeNull();
    expect(googleIdToken({})).toBeNull();
    expect(googleIdToken(null)).toBeNull();
    expect(googleIdToken({ result: { idToken: '   ' } })).toBeNull();
  });
});

describe('safe areas', () => {
  it('adds the inset to a surface’s own padding, with a fallback of 0px', () => {
    expect(withSafeArea(10, 'top')).toBe('calc(10px + env(safe-area-inset-top, 0px))');
    expect(safeArea.bottom).toBe('env(safe-area-inset-bottom, 0px)');
  });

  it('is the header’s own padding, so the strip carries the header’s background', () => {
    const topBar = read('components', 'TopBar.tsx');
    expect(topBar).toContain("withSafeArea(10, 'top')");
    expect(topBar).toContain("withSafeArea(16, 'left')");
    // A spacer element above the bar would show the page behind it — the white
    // band over a themed dark header this inset exists to avoid.
    expect(topBar).not.toContain("padding: '10px 16px'");
  });

  it('reserves the bottom inset once, in the layout, for every page at once', () => {
    const layout = read('app', '[locale]', 'layout.tsx');
    expect(layout).toContain('paddingBottom: safeArea.bottom');
  });

  it('is not behind isNative(), because env() already answers 0px on the web', () => {
    const chrome = readFileSync(join(SRC, 'lib', 'memberChrome.ts'), 'utf-8');
    expect(chrome).toContain('env(safe-area-inset-top, 0px)');
    expect(stripComments(chrome)).not.toContain('isNative');
  });
});

describe('which sign-in button renders', () => {
  const page = read('app', '[locale]', 'sign-in', '[[...sign-in]]', 'page.tsx');
  const button = read('components', 'NativeGoogleButton.tsx');

  it('hides Clerk’s Google button only in the app', () => {
    // `appearance` is `undefined` on the web, so the sign-in screen is byte-for-
    // byte what it was — the ticket's first acceptance criterion.
    expect(page).toContain('socialButtonsBlockButton__google');
    expect(page).toContain('socialButtonsIconButton__google');
    expect(page).toContain('appearance={native ? { elements: NATIVE_SIGN_IN_ELEMENTS } : undefined}');
  });

  it('renders the native button only in the app, and only when it can work', () => {
    expect(page).toContain('<NativeGoogleButton />');
    expect(button).toContain('const native = useIsNative();');
    expect(button).toContain('if (!native || !config) return null;');
  });

  it('resolves “native” after mount rather than during render', () => {
    // Asking during render would make the server emit the web markup and the
    // client the native markup — a hydration mismatch React resolves by throwing
    // the client tree away.
    const hook = readFileSync(join(SRC, 'lib', 'useIsNative.ts'), 'utf-8');
    expect(hook).toContain('useEffect');
    expect(hook).toContain('useState(false)');
  });

  it('hands Clerk the native token rather than a redirect', () => {
    expect(button).toContain('authenticateWithGoogleOneTap');
    expect(button).not.toContain('window.location');
  });
});

describe('the native wiring lives in one place', () => {
  it('mounts the shell once, in the locale layout', () => {
    const layout = read('app', '[locale]', 'layout.tsx');
    expect(layout).toContain('<NativeShell />');
    expect(layout).toContain('<NativeAppState />');
  });

  it('is the only module that imports a Capacitor plugin', () => {
    // `docs/mobile-app.md` design rule 3. A plugin imported from a page would be
    // evaluated during SSR and in every browser, which is the whole of what
    // "a plain browser never executes native code" rules out.
    const offenders: string[] = [];
    const walk = (dir: string, prefix: string) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { readdirSync, statSync } = require('fs');
      for (const entry of readdirSync(join(SRC, dir))) {
        const rel = prefix ? `${prefix}/${entry}` : entry;
        if (statSync(join(SRC, dir, entry)).isDirectory()) walk(`${dir}/${entry}`, rel);
        else if (/\.tsx?$/.test(entry)) {
          const src = stripComments(readFileSync(join(SRC, dir, entry), 'utf-8'));
          if (/@capacitor\/|@capgo\//.test(src) && rel !== 'nativePlugins.ts') offenders.push(`${dir}/${entry}`);
        }
      }
    };
    walk('lib', '');
    walk('app', '');
    walk('components', '');
    expect(offenders).toEqual([]);
  });

  it('registers the device for the signed-in member and nobody else', () => {
    const shell = read('components', 'NativeShell.tsx');
    expect(shell).toContain('if (!isNative() || !member || !gymId) return;');
    expect(shell).toContain('registerPushToken(latest.current.apiFetch, token.value)');
    expect(shell).toContain('notificationTapPath(latest.current.locale)');
    expect(shell).toContain('appUrlOpenPath(url, latest.current.locale)');
    // The effects key on *who is signed in* and read everything else through a
    // ref: `useApiClient()` builds a fresh `apiFetch` every render, and listing
    // it would ask for push permission again on every unrelated re-render.
    expect(shell).toContain('}, [member?.id, gymId]);');
  });

  it('removes the token before the session that authenticates the removal ends', () => {
    const link = read('app', '[locale]', 'link', 'page.tsx');
    const unregister = link.indexOf('unregisterPushToken(apiFetch)');
    const signOut = link.indexOf('await signOut(');
    expect(unregister).toBeGreaterThan(-1);
    expect(signOut).toBeGreaterThan(unregister);
  });
});
