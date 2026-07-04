/**
 * One-time data migration: Neon PostgreSQL -> MySQL (HeatWave). M4 (#48).
 *
 * Idempotent: truncates target tables and reloads, preserving ids.
 * Usage: SOURCE_URL=postgres://... TARGET_URL=mysql://... node scripts/migrate-data-pg-to-mysql.mjs
 */
import pg from 'pg';
import mysql from 'mysql2/promise';

const SOURCE_URL = process.env.SOURCE_URL;
const TARGET_URL = process.env.TARGET_URL;
if (!SOURCE_URL || !TARGET_URL) {
  console.error('SOURCE_URL (postgres) and TARGET_URL (mysql) are required');
  process.exit(1);
}

// FK dependency order (parents first)
const TABLES = ['gyms', 'fares', 'gym_memberships', 'members', 'classes', 'bookings', 'subscriptions'];
const BATCH = 500;

const pgClient = new pg.Client({ connectionString: SOURCE_URL, ssl: { rejectUnauthorized: false } });
const my = await mysql.createConnection({ uri: TARGET_URL, timezone: 'Z' });

await pgClient.connect();

const summary = [];
await my.query('SET FOREIGN_KEY_CHECKS = 0');
try {
  for (const table of TABLES) {
    const { rows } = await pgClient.query(`SELECT * FROM ${table}`);
    await my.query(`TRUNCATE TABLE \`${table}\``);

    if (rows.length > 0) {
      const cols = Object.keys(rows[0]);
      const colList = cols.map((c) => `\`${c}\``).join(', ');
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const placeholders = chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ');
        const values = chunk.flatMap((r) => cols.map((c) => r[c] ?? null));
        await my.query(`INSERT INTO \`${table}\` (${colList}) VALUES ${placeholders}`, values);
      }
    }

    const [[{ n }]] = await my.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
    const ok = Number(n) === rows.length;
    summary.push({ table, source: rows.length, target: Number(n), ok });
    if (!ok) throw new Error(`Row count mismatch on ${table}: source=${rows.length} target=${n}`);
  }
} finally {
  await my.query('SET FOREIGN_KEY_CHECKS = 1');
}

// Spot checks: FK integrity survived the load
const [orphans] = await my.query(
  `SELECT
     (SELECT COUNT(*) FROM members m LEFT JOIN gyms g ON g.id = m.gym_id WHERE m.gym_id IS NOT NULL AND g.id IS NULL) AS members_no_gym,
     (SELECT COUNT(*) FROM members m LEFT JOIN fares f ON f.id = m.fare_id WHERE m.fare_id IS NOT NULL AND f.id IS NULL) AS members_bad_fare,
     (SELECT COUNT(*) FROM bookings b LEFT JOIN members m ON m.id = b.member_id WHERE m.id IS NULL) AS bookings_bad_member,
     (SELECT COUNT(*) FROM bookings b LEFT JOIN classes c ON c.id = b.class_id WHERE c.id IS NULL) AS bookings_bad_class,
     (SELECT COUNT(*) FROM gym_memberships gm LEFT JOIN gyms g ON g.id = gm.gym_id WHERE g.id IS NULL) AS memberships_no_gym`,
);

console.table(summary);
console.log('FK spot checks (all must be 0):', orphans[0]);
const bad = Object.values(orphans[0]).some((v) => Number(v) !== 0);

await pgClient.end();
await my.end();

if (bad) {
  console.error('FK integrity check FAILED');
  process.exit(1);
}
console.log('✓ Migration complete and verified');
