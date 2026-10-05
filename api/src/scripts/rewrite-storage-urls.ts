/**
 * One-time operator rewrite: stored media URLs move from the private R2
 * endpoint to the bucket's public origin.
 *
 *   npm run storage:rewrite-urls -- [--dry-run]
 *
 * Before `CLOUDFLARE_R2_PUBLIC_URL` existed, every stored media URL was
 * `${CLOUDFLARE_R2_ENDPOINT}/${CLOUDFLARE_R2_BUCKET}/<key>`. That is the S3 API
 * endpoint, which answers an unauthenticated GET with `400 Authorization`, so
 * every such image rendered broken. New uploads get the public origin
 * (`buildStorageObjectUrl()`), but the rows written before keep the old string
 * until this rewrites them.
 *
 * Only the columns that store a whole URL are touched. Theme logos and Members
 * App backgrounds store an object *key* and are resolved on every read, so they
 * need nothing.
 *
 * **Idempotent**: only values that start with the exact legacy prefix change,
 * so a second run finds nothing. **Key-preserving**: the part after the prefix
 * is kept byte for byte, so every row still names the same object. External
 * links and other deployments' URLs never match the prefix and are left alone.
 *
 * Why a script and not a Knex migration: a migration is deterministic offline
 * SQL and cannot depend on this deployment's environment, while the prefix to
 * replace and the one to write are both deploy-time configuration.
 */

import 'dotenv/config';
import { db } from '../infra/db';

/** Every column that stores a full media URL rather than an object key. */
export const STORED_URL_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'nutrition_library_items', column: 'image_url' },
  { table: 'exercises', column: 'image_url' },
  { table: 'exercises', column: 'image_thumbnail_url' },
  { table: 'exercises', column: 'video_url' },
  { table: 'exercises', column: 'video_thumbnail_url' },
];

export interface RewriteOptions {
  dryRun: boolean;
}

export interface RewritePrefixes {
  /** `${endpoint}/${bucket}/`: what the old rows start with. */
  legacy: string;
  /** `${publicUrl}/`: what they should start with. */
  current: string;
}

export interface ColumnResult {
  table: string;
  column: string;
  matched: number;
  rewritten: number;
}

export function parseArgs(argv: string[]): RewriteOptions {
  return { dryRun: argv.includes('--dry-run') };
}

/**
 * The prefix to replace and the one to write, from this deployment's own
 * configuration. Throws when the public origin is unset, or when it equals the
 * legacy composition: rewriting a URL into itself would change nothing and
 * report success.
 */
export function resolvePrefixes(env: NodeJS.ProcessEnv = process.env): RewritePrefixes {
  const endpoint = env.CLOUDFLARE_R2_ENDPOINT;
  const bucket = env.CLOUDFLARE_R2_BUCKET;
  const publicUrl = env.CLOUDFLARE_R2_PUBLIC_URL?.trim().replace(/\/+$/, '');
  if (!endpoint || !bucket) {
    throw new Error('CLOUDFLARE_R2_ENDPOINT and CLOUDFLARE_R2_BUCKET must be set: they name the legacy prefix to replace');
  }
  if (!publicUrl) {
    throw new Error('CLOUDFLARE_R2_PUBLIC_URL must be set: it is the public origin the URLs are rewritten to');
  }
  // The same concatenation the old rows were written with, trailing slash and all.
  const legacy = `${endpoint}/${bucket}/`;
  const current = `${publicUrl}/`;
  if (legacy === current) {
    throw new Error('CLOUDFLARE_R2_PUBLIC_URL resolves to the legacy endpoint + bucket; there is nothing to rewrite');
  }
  return { legacy, current };
}

/**
 * Rewrites every stored URL that starts with `prefixes.legacy`. The match uses
 * `LEFT()` rather than `LIKE`, because `_` and `%` in an endpoint or bucket
 * name would be wildcards to `LIKE`.
 */
export async function rewriteStorageUrls(
  options: RewriteOptions,
  prefixes: RewritePrefixes,
  log: (line: string) => void = console.log,
): Promise<ColumnResult[]> {
  const results: ColumnResult[] = [];
  const length = prefixes.legacy.length;
  for (const { table, column } of STORED_URL_COLUMNS) {
    // Identifiers come from the constant above, never from input.
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE LEFT(${column}, ?) = ?`,
      [length, prefixes.legacy],
    );
    const matched = Number(rows[0]?.n ?? 0);
    let rewritten = 0;
    if (matched > 0 && !options.dryRun) {
      const { rowCount } = await db.query(
        `UPDATE ${table}
            SET ${column} = CONCAT(?, SUBSTRING(${column}, ?))
          WHERE LEFT(${column}, ?) = ?`,
        [prefixes.current, length + 1, length, prefixes.legacy],
      );
      rewritten = rowCount;
    }
    results.push({ table, column, matched, rewritten });
    log(`${table}.${column}: ${matched} matched, ${options.dryRun ? 'dry run' : `${rewritten} rewritten`}`);
  }
  return results;
}

/* istanbul ignore next: the CLI wrapper; the work above is what tests cover. */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prefixes = resolvePrefixes();
  console.log(`Rewriting ${prefixes.legacy}… → ${prefixes.current}…${options.dryRun ? ' (dry run)' : ''}`);
  await rewriteStorageUrls(options, prefixes);
  await db.end();
}

// Only run when invoked directly, so the functions above can be imported by tests.
if (process.argv[1] && process.argv[1].includes('rewrite-storage-urls')) {
  main().catch(async (err) => {
    console.error(err);
    await db.end().catch(() => {});
    process.exit(1);
  });
}
