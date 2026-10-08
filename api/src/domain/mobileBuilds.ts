/**
 * #1077 (mobile app WP5) — the **one** place that decides what a published mobile
 * build is: where it lives in the bucket, what describes it, which of them a page may
 * list and which key a download may name.
 *
 * `.github/workflows/mobile-build.yml` is the only writer. After a build it uploads
 *
 *     cordel/mobile-builds/<app id>/<platform>/<file>
 *     cordel/mobile-builds/<app id>/<platform>/<file>.json     (the sidecar)
 *
 * and `GET /platform/mobile-builds` lists what it finds. There is no table: the
 * bucket is the record, so a build can neither be listed without its file nor
 * outlive its removal, and the page has no write path to get wrong. Pure — no S3, no
 * Express — so what a sidecar must say and which keys are servable are assertable
 * without a bucket (`api/src/test/mobile-builds.unit.test.ts`), and
 * `.github/workflows/mobile-build.yml` is asserted to write exactly the fields
 * `parseBuildSidecar()` requires, because the two halves are otherwise invisibly able
 * to drift: a sidecar the parser refuses is a build that simply never appears.
 *
 * Four of its answers are the rule rather than the implementation.
 *
 * **The platform is the folder, not a guess from the extension.** `ios_simulator` and
 * `ios` are both `.zip`/`.ipa`-shaped things a person could confuse, and "Mac
 * simulator only" is exactly the distinction a tester needs, so it is written by the
 * workflow into the path and the sidecar and the parser insists they agree.
 *
 * **A download names a key under the builds prefix and nothing else.**
 * `keyFromBuildId()` answers `null` for anything that decodes outside it, contains a
 * dot-segment or is the sidecar itself, so `GET …/:id/download` can never be asked
 * for another object in a bucket that also holds every gym's files.
 *
 * **A sidecar that does not say who, what and when is dropped, not repaired.** A build
 * with no version or build number is one a tester cannot tell from another, so it is
 * left out of the list (the route logs the key) rather than shown with invented
 * values; `run_url` is accepted only as an `https` URL, because the page renders it as
 * a link and a stored `javascript:` value must never become one.
 *
 * **Retention is the writer's.** `MOBILE_BUILD_RETENTION` is declared here so the page
 * can say how many it keeps, but the pruning is the workflow's, beside the upload —
 * the page deletes nothing.
 */

import { PLATFORM_STORAGE_ROOT } from '../infra/storage';

export const MOBILE_BUILDS_FOLDER = 'mobile-builds';

/** How many builds per app and platform the workflow keeps. */
export const MOBILE_BUILD_RETENTION = 20;

export const MOBILE_BUILD_PLATFORMS = ['android', 'ios_simulator', 'ios'] as const;
export type MobileBuildPlatform = (typeof MOBILE_BUILD_PLATFORMS)[number];

/** The sidecar extension: `<file>` is described by `<file>.json`. */
export const SIDECAR_SUFFIX = '.json';

/** Every key a build owns lives under this prefix. */
export function mobileBuildsPrefix(): string {
  return `${PLATFORM_STORAGE_ROOT}/${MOBILE_BUILDS_FOLDER}/`;
}

/** What a sidecar must say. The workflow writes exactly these fields. */
export const SIDECAR_REQUIRED_FIELDS = [
  'app_id',
  'app_name',
  'environment',
  'platform',
  'version',
  'build_number',
  'git_sha',
  'built_at',
  'file',
] as const;

/** What it may add. */
export const SIDECAR_OPTIONAL_FIELDS = ['sha256', 'signer_sha1', 'run_url'] as const;

export interface MobileBuild {
  /** The opaque id a download is requested by (`buildIdFromKey()`). */
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

/** `<segment>` safe in a key: letters, digits, dot, dash, underscore, plus. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function text(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null;
}

/** An opaque, URL-safe id for a build file's key (base64url of the key under the prefix). */
export function buildIdFromKey(key: string): string | null {
  const prefix = mobileBuildsPrefix();
  if (!key.startsWith(prefix)) return null;
  return Buffer.from(key.slice(prefix.length), 'utf8').toString('base64url');
}

/**
 * The key a build id names, or `null` when it names anything a download must refuse:
 * not valid base64url, not `<app>/<platform>/<file>`, a dot-segment, an unsafe
 * character, an unknown platform, or the sidecar itself.
 */
export function keyFromBuildId(id: string): string | null {
  if (typeof id !== 'string' || !id || id.length > 400 || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  let relative: string;
  try {
    relative = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = relative.split('/');
  if (parts.length !== 3) return null;
  const [app, platform, file] = parts;
  if (!parts.every((p) => SAFE_SEGMENT.test(p) && p !== '.' && p !== '..' && !p.includes('..'))) return null;
  if (!(MOBILE_BUILD_PLATFORMS as readonly string[]).includes(platform)) return null;
  if (file.endsWith(SIDECAR_SUFFIX)) return null;
  // Round trip: the id must be the canonical encoding of this key, so two spellings
  // can never name one object.
  const key = `${mobileBuildsPrefix()}${relative}`;
  return buildIdFromKey(key) === id ? key : null;
}

/** The file's name, for `Content-Disposition`. */
export function downloadFilename(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}

/** The `Content-Type` a build file is served with. */
export function downloadContentType(filename: string): string {
  if (filename.endsWith('.apk')) return 'application/vnd.android.package-archive';
  if (filename.endsWith('.aab')) return 'application/octet-stream';
  if (filename.endsWith('.ipa')) return 'application/octet-stream';
  if (filename.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
}

/**
 * Turns one sidecar into a listed build, or `null` when it cannot be trusted to
 * describe one (see the module comment). `sidecarKey` is the sidecar's own key and
 * `sizeBytes` the size the listing reported for the **file** it points at.
 */
export function parseBuildSidecar(
  raw: unknown,
  sidecarKey: string,
  sizeBytes: number,
): MobileBuild | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;
  if (!sidecarKey.endsWith(SIDECAR_SUFFIX)) return null;
  const fileKey = sidecarKey.slice(0, -SIDECAR_SUFFIX.length);
  const id = buildIdFromKey(fileKey);
  if (!id || keyFromBuildId(id) !== fileKey) return null;

  const [, platformInPath] = fileKey.slice(mobileBuildsPrefix().length).split('/');
  const platform = text(doc.platform, 20);
  if (!platform || platform !== platformInPath || !(MOBILE_BUILD_PLATFORMS as readonly string[]).includes(platform)) {
    return null;
  }

  const appId = text(doc.app_id);
  const appName = text(doc.app_name);
  const environment = text(doc.environment, 20);
  const version = text(doc.version, 40);
  const gitSha = text(doc.git_sha, 64);
  const file = text(doc.file);
  const builtAtRaw = text(doc.built_at, 40);
  const buildNumber = typeof doc.build_number === 'number' ? doc.build_number : Number(doc.build_number);
  if (!appId || !appName || !environment || !version || !gitSha || !file || !builtAtRaw) return null;
  if (!Number.isInteger(buildNumber) || buildNumber < 0) return null;
  const builtAt = new Date(builtAtRaw);
  if (Number.isNaN(builtAt.getTime())) return null;
  // The sidecar must describe the file it sits beside, and the app folder must be its app.
  if (downloadFilename(fileKey) !== file) return null;
  if (fileKey.slice(mobileBuildsPrefix().length).split('/')[0] !== appId) return null;

  const runUrlRaw = text(doc.run_url, 400);
  const runUrl = runUrlRaw && /^https:\/\//i.test(runUrlRaw) ? runUrlRaw : null;
  const sha256 = text(doc.sha256, 64);
  const signer = text(doc.signer_sha1, 64);

  return {
    id,
    app_id: appId,
    app_name: appName,
    environment,
    platform: platform as MobileBuildPlatform,
    version,
    build_number: buildNumber,
    git_sha: gitSha,
    built_at: builtAt.toISOString(),
    file,
    size_bytes: Math.max(0, Math.floor(sizeBytes)),
    sha256: sha256 && /^[0-9a-f]{64}$/i.test(sha256) ? sha256.toLowerCase() : null,
    signer_sha1: signer && /^[0-9a-f:]{40,59}$/i.test(signer) ? signer.toLowerCase() : null,
    run_url: runUrl,
  };
}

/** Newest first: by build time, then by build number, then by name (a stable tie-break). */
export function compareBuilds(a: MobileBuild, b: MobileBuild): number {
  if (a.built_at !== b.built_at) return a.built_at < b.built_at ? 1 : -1;
  if (a.build_number !== b.build_number) return b.build_number - a.build_number;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}
