/** #2404: locale key for a stored equipment value; the caller checks `t.has()` and falls back to the humanised value. */
export function equipmentLabelKey(value: string): string {
  return `exercise_media.equipment_${value.trim().toLowerCase().replace(/[\s-]+/g, '_')}`;
}
