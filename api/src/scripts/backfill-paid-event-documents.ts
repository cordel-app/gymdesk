/**
 * #3511 — give historical paid Billing Events the receipt number and simplified
 * invoice (paid representation) they were never given.
 *
 *   npm run billing:backfill-paid-documents              # dry run (default)
 *   npm run billing:backfill-paid-documents -- --execute # write
 *   ... -- --since 2026-01-01                            # only events paid since that date
 *
 * The same `reconcilePaidEventDocuments()` the nightly billing run calls over
 * its last days, here over the whole history (or `--since`). Idempotent: an
 * event that already has its documents is not selected, and the writers lock
 * the event before allocating a number. Documents are issued with today's date
 * and the current numbering series. Against a deployed database it runs from the
 * VPS as the compiled `node dist/scripts/backfill-paid-event-documents.js`.
 */
import 'dotenv/config';
import { db } from '../infra/db';
import { reconcilePaidEventDocuments } from '../api/paid-event-documents';

async function main() {
  const execute = process.argv.includes('--execute');
  const i = process.argv.indexOf('--since');
  const since = i >= 0 ? process.argv[i + 1] ?? null : null;
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error('--since takes YYYY-MM-DD');
  const log = { warn: (o: object, m: string) => console.warn(m, JSON.stringify(o)) };
  const r = await reconcilePaidEventDocuments({ since, log, limit: 10000, dryRun: !execute });
  console.log(`${execute ? 'reconciled' : 'would reconcile'} ${r.candidates} paid billing event(s): ${r.eventIds.join(', ') || '—'}`);
  if (execute) console.log(`receipts issued: ${r.receipts}, paid representations: ${r.representations}, failed: ${r.failed}`);
  else console.log('dry run — pass --execute to write');
}

main().then(() => db.end()).catch(async (err) => { console.error(err); await db.end(); process.exit(1); });
