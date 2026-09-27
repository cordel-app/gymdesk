import type { CSSProperties } from 'react';

/**
 * #799: the one declaration of what a Nutrition Library item *is* on the
 * frontend — its persisted shape, the values its Edit form is seeded from, the
 * order its read-only sections appear in, and the formatters both halves use.
 *
 * Both libraries import it (`nutrition/nutrition-library` for a gym's,
 * `cordel/nutrition-library` for the platform's), so the list row, the read-only
 * expanded row, the Details modal and the Edit form cannot drift apart into four
 * field lists (§26). The read-only view renders the same row the form is seeded
 * from rather than re-reading the item, which is what keeps the two consistent.
 */

export interface NutritionItemTaxonomy {
  id: number;
  slug: string;
}

/**
 * A row as `GET /nutrition-library` and `GET /platform/nutrition-library`
 * return it. `description` and the three actor pairs come from migration 196;
 * they are what the Details modal shows, and they arrive on the list row rather
 * than through a second endpoint (§25).
 */
export interface NutritionLibraryItemRow {
  id: number;
  /** Null on the platform router's own responses — a base food belongs to no gym. */
  gym_id?: string | null;
  /** Base (English) name — what the Edit form submits back, and what uniqueness applies to. */
  name: string;
  /** `name` in the viewer's locale; equals `name` when untranslated (#643). */
  display_name: string;
  description: string | null;
  status: 'active' | 'deleted';
  image_url: string | null;
  /** Per-locale names keyed by locale (#643). Absent locales fall back to `name`. */
  translations?: Record<string, string>;
  categories: NutritionItemTaxonomy[];
  qualities: NutritionItemTaxonomy[];
  created_at: string;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_name: string | null;
  deleted_at: string | null;
  deleted_by_name: string | null;
}

/** The editable fields, in the shape both pages' inline forms hold them. */
export interface NutritionItemFormValues {
  name: string;
  description: string;
  categoryIds: number[];
  qualityIds: number[];
  translations: Record<string, string>;
  imageUrl: string | null;
}

export function emptyNutritionItemForm(): NutritionItemFormValues {
  return { name: '', description: '', categoryIds: [], qualityIds: [], translations: {}, imageUrl: null };
}

/**
 * Persisted row → Edit form values. The single mapping both pages use, so
 * "what Edit manages" is declared once beside "what the read-only view shows".
 *
 * `name` is the base value, never `display_name`: editing in Spanish must not
 * overwrite the English original the translations hang off (#643).
 */
export function toNutritionItemFormValues(item: NutritionLibraryItemRow): NutritionItemFormValues {
  return {
    name: item.name,
    description: item.description ?? '',
    categoryIds: item.categories.map((c) => c.id),
    qualityIds: item.qualities.map((q) => q.id),
    translations: { ...(item.translations ?? {}) },
    imageUrl: item.image_url,
  };
}

/**
 * The order the expanded read-only row renders its sections in (§2, §22).
 * `status` sits immediately after `description`, and `media` is last.
 */
export const NUTRITION_ITEM_SECTION_ORDER = [
  'name',
  'description',
  'status',
  'translations',
  'categories',
  'qualities',
  'media',
] as const;

export type NutritionItemSection = typeof NUTRITION_ITEM_SECTION_ORDER[number];

/** The admin app's empty-value convention — never `null`, never `undefined`. */
export const EMPTY_VALUE = '—';

/** A value, or the em dash. Zero-length and whitespace-only read as empty. */
export function displayValue(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : EMPTY_VALUE;
}

/**
 * A stored UTC timestamp as a local date and time, or the em dash. MySQL hands
 * back `YYYY-MM-DD HH:MM:SS` for a DATETIME, which Safari refuses to parse —
 * the `T` makes it an ISO string every browser reads.
 */
export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return EMPTY_VALUE;
  const parsed = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(parsed.getTime())) return EMPTY_VALUE;
  return parsed.toLocaleString();
}

/**
 * The chip look of an assigned / unassigned category or quality — the same
 * selected blue the Edit form's checkboxes use (§5, §6), so the read-only row
 * and the form read as the same control without one of them being clickable.
 */
export function taxonomyChipStyle(assigned: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 12px',
    borderRadius: 12,
    border: `1px solid ${assigned ? 'var(--badge-border, #bfdbfe)' : 'var(--card-border, #e5e7eb)'}`,
    background: assigned ? 'var(--badge-bg, #eff6ff)' : 'transparent',
    color: assigned ? 'var(--badge-text, #1d4ed8)' : 'var(--text-muted, #6b7280)',
    fontSize: 13,
    fontWeight: 500,
    userSelect: 'none',
  };
}
