// #2159: an assigned Training Plan's stored name carries a version suffix
// (`TP1 - Xavi [2026-10-31 - Open End]`, api/src/domain/trainingPlanVersioning.ts).
// Display only: the stored name, the dates and the versioning are untouched, and the
// pattern mirrors the API's own VERSION_SUFFIX_RE.
const VERSION_SUFFIX_RE = /\s*\[\d{4}-\d{2}-\d{2} - (?:\d{4}-\d{2}-\d{2}|Open End|Open Ended)\]\s*$/;

export function displayTrainingPlanName(name: string): string {
  return name.replace(VERSION_SUFFIX_RE, '').trim();
}
