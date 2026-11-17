import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

/**
 * #2952 — Cordel → Export / Import, the Admin's pure half: what an archive holds,
 * how it is built and read, and what an operation's summary counts. The page
 * does the requests (one entity at a time, so it can show progress and keep
 * going past a failure); everything it decides is decided here, so it can be
 * asserted without a browser.
 *
 * The archive is a ZIP of:
 *  - `manifest.json` — the format, its version, when and what was exported;
 *  - `<type>/<slug>.json` — one file per entity: its `slug`, its own content
 *    (`data`) and, per image slot, the path of that image inside the archive;
 *  - `images/<type>/<slug>-<slot>.<ext>` — the image files themselves.
 *
 * Which types exist is the API's answer (`GET /platform/transfer/types`); this
 * module only knows their labels.
 */
export const TRANSFER_FORMAT = 'cordel-entity-transfer';
export const TRANSFER_FORMAT_VERSION = 1;
export const MANIFEST_PATH = 'manifest.json';

/** The locale key under the `transfer` namespace each known type is labelled with. */
const TYPE_LABEL_KEYS: Record<string, string> = {
  muscles: 'type_muscles',
  payment_providers: 'type_payment_providers',
  base_payment_methods: 'type_base_payment_methods',
  base_professional_services: 'type_base_professional_services',
};

/** A type's label key, or null when the type has none (the page then shows the type as is). */
export function transferTypeLabelKey(type: string): string | null {
  return TYPE_LABEL_KEYS[type] ?? null;
}

/** One entity as `GET /platform/transfer/<type>` answers it. */
export interface ExportRecord {
  slug: string;
  data: Record<string, unknown>;
  /** The stored URL of each image slot, or null when the slot is empty. */
  images: Record<string, string | null>;
}

/** One entity collected for the archive: the record and the bytes of each image it has. */
export interface CollectedEntity {
  type: string;
  record: ExportRecord;
  images: Record<string, { bytes: Uint8Array; extension: string }>;
}

/** One entity read back from an archive, ready to import. */
export interface ArchiveEntity {
  type: string;
  slug: string;
  data: Record<string, unknown>;
  images: Record<string, { bytes: Uint8Array; mime: string }>;
}

export interface ArchiveProblem {
  path: string;
  message: string;
}

export function entityJsonPath(type: string, slug: string): string {
  return `${type}/${slug}.json`;
}

export function imageArchivePath(type: string, slug: string, slot: string, extension: string): string {
  return `images/${type}/${slug}-${slot}.${extension}`;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
};

/** The image extension a stored URL names, `webp` when it names none the API accepts. */
export function imageExtensionFromUrl(url: string): string {
  const path = url.split('?')[0].split('#')[0];
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return ext in MIME_BY_EXTENSION ? ext : 'webp';
}

export function mimeForImagePath(path: string): string | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? null;
}

/** The image slots of a record that hold an image, in the record's order. */
export function imageSlotsToCollect(record: ExportRecord): { slot: string; url: string }[] {
  return Object.entries(record.images ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
    .map(([slot, url]) => ({ slot, url }));
}

/** `cordel-export-2026-11-17T10-30-00Z.zip` — sortable and safe on every file system. */
export function archiveFileName(now: Date): string {
  return `cordel-export-${now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')}.zip`;
}

/** Builds the ZIP from the entities collected. */
export function buildArchive(types: string[], entities: CollectedEntity[], now: Date): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const counts: Record<string, number> = {};
  for (const type of types) counts[type] = 0;
  for (const entity of entities) {
    const { type, record } = entity;
    const imagePaths: Record<string, string | null> = {};
    for (const slot of Object.keys(record.images ?? {})) {
      const image = entity.images[slot];
      if (!image) { imagePaths[slot] = null; continue; }
      const path = imageArchivePath(type, record.slug, slot, image.extension);
      files[path] = image.bytes;
      imagePaths[slot] = path;
    }
    files[entityJsonPath(type, record.slug)] = strToU8(JSON.stringify({
      format: TRANSFER_FORMAT,
      version: TRANSFER_FORMAT_VERSION,
      type,
      slug: record.slug,
      data: record.data,
      images: imagePaths,
    }, null, 2));
    counts[type] = (counts[type] ?? 0) + 1;
  }
  files[MANIFEST_PATH] = strToU8(JSON.stringify({
    format: TRANSFER_FORMAT,
    version: TRANSFER_FORMAT_VERSION,
    exported_at: now.toISOString(),
    types,
    counts,
  }, null, 2));
  return zipSync(files, { level: 6 });
}

/**
 * Reads an archive back. Only the entity files of `types` are returned; a file
 * that cannot be read, or that names an image the archive does not hold, is a
 * problem naming its path, and the rest of the archive is still read.
 */
export function readArchive(
  zip: Uint8Array,
  types: string[],
): { entities: ArchiveEntity[]; problems: ArchiveProblem[] } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch {
    return { entities: [], problems: [{ path: '', message: 'not_a_zip' }] };
  }
  const entities: ArchiveEntity[] = [];
  const problems: ArchiveProblem[] = [];
  const wanted = new Set(types);
  for (const path of Object.keys(files).sort()) {
    const match = /^([a-z_]+)\/([^/]+)\.json$/.exec(path);
    if (!match || !wanted.has(match[1])) continue;
    let doc: any;
    try {
      doc = JSON.parse(strFromU8(files[path]));
    } catch {
      problems.push({ path, message: 'invalid_json' });
      continue;
    }
    if (!doc || doc.format !== TRANSFER_FORMAT || doc.type !== match[1] || typeof doc.slug !== 'string' || !doc.slug) {
      problems.push({ path, message: 'invalid_entity' });
      continue;
    }
    if (doc.version !== TRANSFER_FORMAT_VERSION) {
      problems.push({ path, message: 'unsupported_version' });
      continue;
    }
    const images: ArchiveEntity['images'] = {};
    let missing: string | null = null;
    for (const [slot, imagePath] of Object.entries(doc.images ?? {})) {
      if (imagePath == null) continue;
      const mime = typeof imagePath === 'string' ? mimeForImagePath(imagePath) : null;
      const bytes = typeof imagePath === 'string' ? files[imagePath] : undefined;
      if (!bytes || !mime) { missing = String(imagePath); break; }
      images[slot] = { bytes, mime };
    }
    if (missing) {
      problems.push({ path, message: 'missing_image' });
      continue;
    }
    entities.push({
      type: doc.type,
      slug: doc.slug,
      data: doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data) ? doc.data : {},
      images,
    });
  }
  return { entities, problems };
}

/** The body of the import request: the entity's own content under its slug. */
export function importPayload(entity: ArchiveEntity): Record<string, unknown> {
  return { ...entity.data, slug: entity.slug };
}

export interface TransferFailure {
  type: string;
  slug: string;
  message: string;
}

export interface TransferSummary {
  total: number;
  succeeded: number;
  failed: number;
  failures: TransferFailure[];
}

export function emptySummary(): TransferSummary {
  return { total: 0, succeeded: 0, failed: 0, failures: [] };
}

/** One entity's outcome, folded into the summary. */
export function recordOutcome(summary: TransferSummary, outcome: { type: string; slug: string; error?: string | null }): TransferSummary {
  const failed = typeof outcome.error === 'string';
  return {
    total: summary.total + 1,
    succeeded: summary.succeeded + (failed ? 0 : 1),
    failed: summary.failed + (failed ? 1 : 0),
    failures: failed ? [...summary.failures, { type: outcome.type, slug: outcome.slug, message: outcome.error as string }] : summary.failures,
  };
}

/** Steps an operation counts its progress in: one per entity plus one per image. */
export function stepsForEntities(entities: { images: Record<string, unknown> }[]): number {
  return entities.reduce((n, e) => n + 1 + Object.values(e.images ?? {}).filter((v) => v != null && v !== '').length, 0);
}

/** Progress as a whole percentage, 0 while nothing is known and never above 100. */
export function progressPercent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.floor((done / total) * 100));
}
