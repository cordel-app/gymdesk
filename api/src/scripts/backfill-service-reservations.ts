/**
 * #2605 stage 3 — reserve a Professional Service unit for the future bookings
 * made before the reservation model existed (stage 1, migration 381).
 *
 *   npm run reservations:backfill                        # dry run (default)
 *   npm run reservations:backfill -- --execute           # write
 *   npm run reservations:backfill -- --before=2026-11-10T14:46:00Z
 *
 * A candidate is a `booked` row on a future scheduled occurrence that holds no
 * reservation and was booked before the first reservation ever written (or
 * `--before`). Reserving goes through the booking's own rule, so a member whose
 * remaining balance is already fully booked gets no reservation for the rest.
 * Repeatable: a second run finds nothing to do.
 */
import 'dotenv/config';
import { db } from '../infra/db';
import { backfillReservations } from '../api/service-reservation';

async function main() {
  const execute = process.argv.includes('--execute');
  const before = process.argv.find((a) => a.startsWith('--before='))?.slice('--before='.length) ?? null;
  const res = await backfillReservations({ execute, before, log: (line) => console.log(line) });
  console.log(`\n${execute ? 'Executed' : 'Dry run'} (cutoff ${res.cutoff ?? 'none: every candidate'}): ${res.candidates} candidates, ` +
    `${res.reserved} reserved, ${res.no_available} with no available balance, ${res.not_applicable} needing no service.`);
  await db.end();
}

main().catch(async (err) => { console.error(err); await db.end().catch(() => {}); process.exit(1); });
