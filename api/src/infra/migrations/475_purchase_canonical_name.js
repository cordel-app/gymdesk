/**
 * #3288 / #3287 — a Purchase's name is one complete canonical string, and its checkout Billing Event
 * carries the same string.
 *
 * 1. `purchases.name` and `billing_events.name` widen to VARCHAR(320): a gym name (255) plus
 *    ` - Purchase - 11/23/2026 11:56 AM`, never cut.
 * 2. Every purchase still holding #3270's name basis (the UTC creation instant, ISO 8601) gets its
 *    canonical name `<Gym name> - Purchase - <created_at in the gym's Time & Localization>`, from the
 *    gym's current name and settings. The language that created a legacy purchase is not recorded, so
 *    the label is the deterministic English fallback (`Purchase`). Only rows matching the ISO pattern
 *    are touched, so a re-run converts nothing twice and a canonical name is never recomputed.
 * 3. Every Billing Event linked to a purchase (`billing_events.purchase_id`, #3251) takes that
 *    purchase's name verbatim. An event with no purchase keeps its #2940 name.
 *
 * The formatter below is a copy of `formatGymDateTime()` + `canonicalPurchaseName()`
 * (`domain/gymLocalization.ts`, `domain/purchaseName.ts`); `purchase-canonical-name.unit.test.ts`
 * keeps the two in step. The ISO column default stays, so an API image still running the previous
 * code keeps creating carts during the deploy window. `down` narrows nothing back (it would cut the
 * names) and leaves the strings as they are.
 */

const ISO_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DEFAULT_ZONE = 'Europe/Madrid';

function validZone(zone) {
  if (typeof zone !== 'string' || zone.trim() === '') return false;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
}

function formatGymDateTime(value, s) {
  const hour12 = s.time_format === '12h';
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-GB', {
    timeZone: validZone(s.time_zone) ? s.time_zone : DEFAULT_ZONE, hourCycle: hour12 ? 'h12' : 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(value)) parts[p.type] = p.value;
  const date = s.date_format === 'MM/DD/YYYY' ? `${parts.month}/${parts.day}/${parts.year}`
    : s.date_format === 'YYYY-MM-DD' ? `${parts.year}-${parts.month}-${parts.day}`
      : `${parts.day}/${parts.month}/${parts.year}`;
  const time = hour12
    ? `${parts.hour}:${parts.minute} ${(parts.dayPeriod || '').toUpperCase()}`.trim()
    : `${parts.hour}:${parts.minute}`;
  return `${date} ${time}`;
}

function legacyPurchaseName(gymName, iso, settings) {
  const gym = String(gymName || '').trim();
  const rest = `Purchase - ${formatGymDateTime(new Date(iso), settings)}`;
  return gym ? `${gym} - ${rest}` : rest;
}

exports.legacyPurchaseName = legacyPurchaseName;

exports.up = async (knex) => {
  await knex.raw(`ALTER TABLE purchases MODIFY COLUMN name VARCHAR(320) NOT NULL
    DEFAULT (DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ'))`);
  await knex.raw('ALTER TABLE billing_events MODIFY COLUMN name VARCHAR(320) NULL');

  const [rows] = await knex.raw(
    `SELECT p.id, p.name, g.name AS gym_name, g.time_zone, g.date_format, g.time_format
       FROM purchases p JOIN gyms g ON g.id = p.gym_id
      WHERE p.name REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'`);
  for (const r of rows) {
    if (!ISO_NAME.test(r.name)) continue;
    const name = legacyPurchaseName(r.gym_name, r.name, {
      time_zone: r.time_zone, date_format: r.date_format, time_format: r.time_format,
    });
    await knex.raw('UPDATE purchases SET name = ? WHERE id = ? AND name = ?', [name, r.id, r.name]);
  }

  await knex.raw(
    `UPDATE billing_events be JOIN purchases p ON p.id = be.purchase_id AND p.gym_id = be.gym_id
        SET be.name = p.name
      WHERE be.purchase_id IS NOT NULL AND NOT (be.name <=> p.name)`);
};

exports.down = async () => {};
