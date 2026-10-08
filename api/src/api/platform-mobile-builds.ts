/**
 * #1077 (mobile app WP5): the Mobile builds page's API — superadmin-only, mounted at
 * `/platform/mobile-builds`.
 *
 *   GET /               the published builds, newest first
 *   GET /:id/download   one build file, as an attachment
 *
 * Read-only on purpose: `.github/workflows/mobile-build.yml` is the only writer and
 * the bucket is the record (see `domain/mobileBuilds.ts`, which decides what a build
 * is and which key a download may name). There is no table, no upload route and no
 * delete — a build leaves the list when the workflow's own retention removes it.
 *
 * The file is streamed through the API rather than linked to the bucket's public
 * origin: a debug build is for the people who may open this page, not for anyone who
 * learns a URL.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireSuperadmin } from '../infra/tenantContext';
import {
  getStorageObject, isStorageConfigured, listStorageObjects, StorageOperationError,
} from '../infra/storage';
import {
  MobileBuild, MOBILE_BUILD_RETENTION, SIDECAR_SUFFIX, compareBuilds, downloadContentType,
  downloadFilename, isListedBuildKey, keyFromBuildId, mobileBuildsPrefix, parseBuildSidecar,
  parseTestFlightUrl,
} from '../domain/mobileBuilds';

export const platformMobileBuildsRouter = Router();

/** S3 answers a missing key as `NoSuchKey`, a 404, or both. */
function isMissingObject(err: StorageOperationError): boolean {
  const { name, code, httpStatusCode } = err.details;
  return name === 'NoSuchKey' || code === 'NoSuchKey' || httpStatusCode === 404;
}

/** The iPhone's TestFlight link: configuration, read per request, `null` until it exists. */
function testflightUrl(): string | null {
  return parseTestFlightUrl(process.env.MOBILE_TESTFLIGHT_URL);
}

/** More than the retention can ever hold (20 x apps x platforms), and still a bound. */
const MAX_LISTED_KEYS = 1000;

/** Reads the sidecars a listing returned and answers the builds they describe. */
async function loadBuilds(): Promise<MobileBuild[]> {
  const objects = await listStorageObjects(mobileBuildsPrefix(), MAX_LISTED_KEYS);
  const sizeOf = new Map(objects.map((o) => [o.key, o.size]));
  // Only the platforms the page lists: an older sidecar for another one (a simulator
  // build) is skipped without a read and without a log line.
  const sidecars = objects.filter((o) => isListedBuildKey(o.key));

  const builds = await Promise.all(sidecars.map(async (sidecar): Promise<MobileBuild | null> => {
    const fileKey = sidecar.key.slice(0, -SIDECAR_SUFFIX.length);
    // A sidecar whose file is gone (pruned half-way, or never uploaded) is not a build.
    if (!sizeOf.has(fileKey)) return null;
    try {
      const { body } = await getStorageObject(sidecar.key);
      const build = parseBuildSidecar(JSON.parse(body.toString('utf8')), sidecar.key, sizeOf.get(fileKey) ?? 0);
      if (!build) console.warn('mobile-builds: ignoring a sidecar that does not describe a build: %s', sidecar.key);
      return build;
    } catch (err) {
      console.warn('mobile-builds: could not read %s: %s', sidecar.key, (err as Error)?.message ?? err);
      return null;
    }
  }));

  return builds.filter((b): b is MobileBuild => b !== null).sort(compareBuilds);
}

platformMobileBuildsRouter.get(
  '/',
  requireSuperadmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isStorageConfigured()) {
        return res.status(503).json({
          error: 'storage_not_configured', builds: [], keep: MOBILE_BUILD_RETENTION, testflight_url: testflightUrl(),
        });
      }
      res.set('Cache-Control', 'no-store');
      res.json({ builds: await loadBuilds(), keep: MOBILE_BUILD_RETENTION, testflight_url: testflightUrl() });
    } catch (err) { next(err); }
  },
);

platformMobileBuildsRouter.get(
  '/:id/download',
  requireSuperadmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const key = keyFromBuildId(String(req.params.id));
    if (!key) return res.status(404).json({ error: 'Build not found' });
    try {
      if (!isStorageConfigured()) return res.status(503).json({ error: 'storage_not_configured' });
      const { body } = await getStorageObject(key);
      const filename = downloadFilename(key);
      res.set({
        'Content-Type': downloadContentType(filename),
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
      });
      res.send(body);
    } catch (err) {
      // A missing object is a 404 the page can show, not a 500 with a driver's words.
      if (err instanceof StorageOperationError && isMissingObject(err)) {
        return res.status(404).json({ error: 'Build not found' });
      }
      next(err);
    }
  },
);
