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
 * The schemes inside `CFBundleURLTypes`' single `CFBundleURLSchemes` array.
 *
 * The array is replaced whole rather than appended to, because the schemes a
 * build registers are exactly the ones its profile implies (`urlSchemes()`):
 * appending would leave the previous profile's Google scheme in an app that no
 * longer has that client id, which is a callback the app claims and cannot
 * answer.
 */
export function withPlistUrlSchemes(plist: string, schemes: readonly string[]): string {
  const pattern = /(<key>CFBundleURLSchemes<\/key>\s*<array>)([\s\S]*?)(<\/array>)/;
  requireMatches(pattern.test(plist) ? 1 : 0, 'CFBundleURLSchemes', 'Info.plist');
  return plist.replace(pattern, (_m, open: string, body: string, close: string) => {
    // The template indents plist values with tabs; the indent of the first
    // entry is reused so an applied file stays diff-clean against it.
    const indent = /\n([\t ]*)<string>/.exec(body)?.[1] ?? '\t\t\t\t';
    const entries = schemes.map((scheme) => `\n${indent}<string>${escapeXml(scheme)}</string>`).join('');
    const closingIndent = indent.slice(0, Math.max(0, indent.length - 1));
    return `${open}${entries}\n${closingIndent}${close}`;
  });
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

/** The four identity strings the Android template reads from resources. */
export function withAndroidStrings(
  xml: string,
  values: { appName: string; packageName: string; customUrlScheme: string },
): string {
  let out = xml;
  for (const [name, value] of [
    ['app_name', values.appName],
    ['title_activity_main', values.appName],
    ['package_name', values.packageName],
    ['custom_url_scheme', values.customUrlScheme],
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
