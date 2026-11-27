/**
 * #3485 — a Workout Template edit checkpoint is stored as JSON, which turns
 * every DATETIME column into an ISO-8601 UTC string (`2026-11-27T10:00:00.000Z`).
 * MySQL refuses that spelling in a DATETIME column, so a row written back by
 * Cancel takes its timestamps as `Date` objects again; the pool's `timezone: 'Z'`
 * writes them as the same UTC wall-clock value they were read as. Every other
 * value (numbers, decimal strings, text, null) is written back as stored.
 */
const ISO_UTC_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function reviveCheckpointValue(value: unknown): unknown {
  return typeof value === 'string' && ISO_UTC_DATETIME.test(value) ? new Date(value) : value;
}

export function reviveCheckpointRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = reviveCheckpointValue(value);
  return out;
}
