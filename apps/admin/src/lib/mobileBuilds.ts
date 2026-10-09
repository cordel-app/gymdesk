/**
 * #1077 — the Mobile builds page's decisions, kept out of the JSX so they are
 * assertable without a browser (`src/test/mobile-builds.test.ts`).
 *
 * What a build *is* — its fields, which key a download may name — is the API's
 * (`api/src/domain/mobileBuilds.ts`); this mirrors only the shape the page reads and
 * decides how it is *worded*. No label is composed here: each function answers a
 * locale **key** (or a plain formatted value), and the page resolves it, so a
 * missing key is a test failure and not a literal on screen.
 */

/** Android is the only platform published (an iPhone gets TestFlight, see `testflightHref()`). */
export type MobileBuildPlatform = 'android';

export interface MobileBuild {
  id: string;
  app_id: string;
  app_name: string;
  environment: string;
  platform: MobileBuildPlatform;
  version: string;
  build_number: number;
  git_sha: string;
  built_at: string;
  file: string;
  size_bytes: number;
  sha256: string | null;
  signer_sha1: string | null;
  run_url: string | null;
}

export interface MobileBuildsResponse {
  builds: MobileBuild[];
  keep: number;
  /** The iPhone's TestFlight link, or `null` until the app has one. */
  testflight_url: string | null;
}

/** `1.0.0 (57)` — the version and the CI build number, which together name a build. */
export function formatBuildVersion(build: Pick<MobileBuild, 'version' | 'build_number'>): string {
  return `${build.version} (${build.build_number})`;
}

/** The short commit id a build was made from. */
export function shortSha(sha: string): string {
  return sha.trim().slice(0, 8);
}

/** `7.2 MB`, `812 KB`, `0 B` — binary units, one decimal from MB up. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** The `mobile_builds` key naming a platform. */
export function platformLabelKey(platform: MobileBuildPlatform): string {
  return `platform_${platform}`;
}

/**
 * The TestFlight link to put behind the button, or `null` when there is none to offer.
 * The API already refuses anything but a `https://testflight.apple.com/…` URL; this
 * checks it again because the page renders the value as an `href`, and a link to
 * anywhere else must never be possible from a stored string.
 */
export function testflightHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'testflight.apple.com' && parsed.pathname.length > 1
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

/** The key of an environment's short name, or `null` for one the page has no word for. */
export function environmentLabelKey(environment: string): string | null {
  return environment === 'dev' || environment === 'pro' ? `env_${environment}` : null;
}

/** Whether the Android install steps are worth showing: there is a build they apply to. */
export function showsAndroidInstallHelp(builds: readonly MobileBuild[]): boolean {
  return builds.some((b) => b.platform === 'android');
}

/** The API path a build is downloaded from. */
export function downloadPath(build: Pick<MobileBuild, 'id'>): string {
  return `/platform/mobile-builds/${encodeURIComponent(build.id)}/download`;
}

/** Hands a downloaded blob to the browser as a file named `filename`. Browser only. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
