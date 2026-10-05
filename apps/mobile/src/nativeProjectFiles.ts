/**
 * #1074 (mobile app WP3) — the **one** place that knows how an app profile is
 * written into the files Capacitor generates once and never rewrites.
 *
 * `cap add` seeds the Xcode project, `Info.plist`, Gradle and `strings.xml`
 * from `capacitor.config.ts`, and `cap sync` then leaves all four alone — so
 * switching profile needs something to write them, which is
 * `scripts/apply-profile.ts`. These are the transforms it uses, kept **pure**
 * (text in, text out) so what a profile lands on is assertable without a
 * macOS machine or an Android SDK
 * (`api/src/test/mobile-shell-profile.unit.test.ts`).
 *
 * Two of their properties are the rule rather than the implementation.
 *
 * **A transform that cannot find its anchor throws.** Every one of these edits
 * a file a Capacitor upgrade may reshape, and the failure that matters is the
 * silent one: an apply that reports success while the Bundle ID stayed the
 * previous profile's ships one gym's app under another gym's identity. So a
 * missing anchor is an error naming the file, and `npm run profile:apply` is
 * the step that fails rather than the store upload.
 *
 * **Nothing here holds an identity.** Every value is an argument; the one place
 * a literal app identity may appear is a profile file under `profiles/`.
 */

export class NativeProjectFileError extends Error {}

function requireMatches(count: number, what: string, file: string): void {
  if (count > 0) return;
  throw new NativeProjectFileError(
    `Could not find ${what} in ${file}. The Capacitor template may have changed — update apps/mobile/src/nativeProjectFiles.ts rather than editing the project by hand.`,
  );
}

/** Every `PRODUCT_BUNDLE_IDENTIFIER` of the Xcode project (Debug and Release). */
export function withBundleIdentifier(pbxproj: string, bundleId: string): string {
  const pattern = /(PRODUCT_BUNDLE_IDENTIFIER = )("?)[^;"\n]*(\2;)/g;
  const matches = pbxproj.match(pattern);
  requireMatches(matches?.length ?? 0, 'PRODUCT_BUNDLE_IDENTIFIER', 'project.pbxproj');
  return pbxproj.replace(pattern, `$1${bundleId};`);
}

/**
 * The `<string>` under a plist `<key>`.
 *
 * Only a scalar string value is written: a key whose value is an array or a
 * dict is a different shape and has its own function below, so this cannot
 * quietly overwrite the first element of one.
 */
export function withPlistString(plist: string, key: string, value: string): string {
  const pattern = new RegExp(
    `(<key>${escapeRegExp(key)}</key>\\s*<string>)([\\s\\S]*?)(</string>)`,
  );
  requireMatches(pattern.test(plist) ? 1 : 0, `<key>${key}</key> with a string value`, 'Info.plist');
  return plist.replace(pattern, (_m, open: string, _old: string, close: string) => `${open}${escapeXml(value)}${close}`);
}

/**
 * The `<string>` entries of a plist `<array>` under a given `<key>`.
 *
 * The array is replaced whole rather than appended to, because what a build
 * declares is exactly what its profile implies: appending would leave the
 * previous profile's Google scheme in an app that no longer has that client id
 * (a callback the app claims and cannot answer), or the previous gym's domain
 * in `associated-domains` (a link the app claims and must not open).
 */
export function withPlistStringArray(
  plist: string,
  key: string,
  values: readonly string[],
  file = 'Info.plist',
): string {
  const pattern = new RegExp(`(<key>${escapeRegExp(key)}</key>\\s*<array>)([\\s\\S]*?)(</array>)`);
  requireMatches(pattern.test(plist) ? 1 : 0, `<key>${key}</key> with an array value`, file);
  return plist.replace(pattern, (_m, open: string, body: string, close: string) => {
    // The template indents plist values with tabs; the indent of the first
    // entry is reused so an applied file stays diff-clean against it.
    const indent = /\n([\t ]*)<string>/.exec(body)?.[1] ?? '\t\t\t\t';
    const entries = values.map((value) => `\n${indent}<string>${escapeXml(value)}</string>`).join('');
    const closingIndent = indent.slice(0, Math.max(0, indent.length - 1));
    return `${open}${entries}\n${closingIndent}${close}`;
  });
}

/** The schemes inside `CFBundleURLTypes`' single `CFBundleURLSchemes` array. */
export function withPlistUrlSchemes(plist: string, schemes: readonly string[]): string {
  return withPlistStringArray(plist, 'CFBundleURLSchemes', schemes);
}

/**
 * The `associated-domains` entitlement — `applinks:<host>` for the domain whose
 * links this build may open (#1076, WP4).
 *
 * The entitlement is what turns a link on that domain into a universal link;
 * the domain's own half is the association file `apps/member` serves. Written
 * here rather than left to Xcode because *Associated Domains* added in the UI
 * would carry one gym's host into every other profile's build.
 */
export function withAssociatedDomains(entitlements: string, domains: readonly string[]): string {
  return withPlistStringArray(
    entitlements,
    'com.apple.developer.associated-domains',
    domains,
    'App.entitlements',
  );
}

/**
 * The `namespace` the Android project is generated with — the package its
 * checked-in `MainActivity` and generated `R`/`BuildConfig` live under.
 *
 * It is **read** rather than written: `applicationId` is what identifies the
 * app, and moving the namespace would mean moving source files rather than
 * editing a value (`androidIdentity()`'s own note). Reading it is what keeps
 * the template's package out of the apply script as a literal.
 */
export function gradleNamespace(gradle: string): string {
  const match = /namespace\s*=?\s*["']([^"']+)["']/.exec(gradle);
  requireMatches(match ? 1 : 0, 'namespace', 'app/build.gradle');
  return (match as RegExpExecArray)[1];
}

/** Gradle's `applicationId` — what the Play Store and FCM identify the app by. */
export function withGradleApplicationId(gradle: string, applicationId: string): string {
  const pattern = /(applicationId\s*=?\s*)(["'])[^"']*\2/;
  requireMatches(pattern.test(gradle) ? 1 : 0, 'applicationId', 'app/build.gradle');
  return gradle.replace(pattern, `$1"${applicationId}"`);
}

/** The identity strings the Android project reads from resources. */
export function withAndroidStrings(
  xml: string,
  values: { appName: string; packageName: string; customUrlScheme: string; appLinkHost: string },
): string {
  let out = xml;
  for (const [name, value] of [
    ['app_name', values.appName],
    ['title_activity_main', values.appName],
    ['package_name', values.packageName],
    ['custom_url_scheme', values.customUrlScheme],
    // #1076: the host the App Links `intent-filter` accepts. A resource rather
    // than a literal in the manifest, for design rule 1's reason — the host is
    // the profile's (it is `serverUrl`'s), and a second profile must need no
    // edit to `AndroidManifest.xml`.
    ['app_link_host', values.appLinkHost],
  ] as const) {
    const pattern = new RegExp(
      `(<string name="${escapeRegExp(name)}">)([\\s\\S]*?)(</string>)`,
    );
    requireMatches(pattern.test(out) ? 1 : 0, `<string name="${name}">`, 'res/values/strings.xml');
    out = out.replace(pattern, (_m, open: string, _old: string, close: string) => `${open}${escapeXml(value)}${close}`);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A profile's display name may legitimately contain `&` ("Body & Mind"). */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
