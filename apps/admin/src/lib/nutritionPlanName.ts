// #2153: an assigned Nutrition Plan version is stored as `<name> [<start> - <end>]`
// (#1970, api/src/domain/nutritionPlanVersioning.ts). The dates are kept in the
// stored name and in the plan's own start/end fields; this strips the suffix for
// display only. Mirrors the API's VERSION_SUFFIX_RE.
const VERSION_SUFFIX_RE = /\s*\[\d{4}-\d{2}-\d{2} - (?:\d{4}-\d{2}-\d{2}|Open End)\]\s*$/;

export function displayNutritionPlanName(name: string): string {
  return name.replace(VERSION_SUFFIX_RE, '').trim();
}
