/**
 * #2404: Equipment stays a free-text value preserved from the Free Exercise DB
 * (#964); the stored value is language-independent and is what filters and
 * writes use. Only its *label* is translated: the fixed set below has an
 * `exercises.equipment_<slug>` key in en/es/ca, and any other stored value falls
 * back to its humanised form (decided before `t()` is called, never an empty
 * label and never a missing key printed verbatim).
 */
export const EQUIPMENT_VALUES = [
  'bands',
  'barbell',
  'body only',
  'cable',
  'dumbbell',
  'e-z curl bar',
  'exercise ball',
  'foam roll',
  'kettlebells',
  'machine',
  'medicine ball',
  'other',
] as const;

export function equipmentLabelKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (!(EQUIPMENT_VALUES as readonly string[]).includes(v)) return null;
  return `equipment_${v.replace(/[\s-]+/g, '_')}`;
}

export function equipmentLabel(
  value: string | null | undefined,
  resolve: (key: string) => string,
  fallback: (value: string) => string,
): string {
  if (!value) return '';
  const key = equipmentLabelKey(value);
  return key ? resolve(key) : fallback(value);
}
