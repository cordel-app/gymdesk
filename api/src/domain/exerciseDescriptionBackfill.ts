import { BASE_LOCALE } from '../infra/locale';
import { DESCRIPTION_MAX, SHORT_DESCRIPTION_MAX } from './exerciseDescriptionTranslations';

/**
 * #1419: what `npm run exercises:backfill-descriptions` may write, decided in
 * one pure place. The rule is "fill what is empty, never overwrite": a stored
 * value (base or translated) always wins over the reviewed content file, so the
 * script can be re-run after a review round without undoing a human correction.
 */
export interface DescriptionPair { short_description?: string | null; description?: string | null }

export interface BackfillPlan {
  /** Values to write per locale (the base locale means `exercises` columns). */
  writes: Record<string, { short_description?: string; description?: string }>;
  /** Problems with the content entry itself; nothing is written for those fields. */
  warnings: string[];
}

const blank = (v: unknown) => typeof v !== 'string' || v.trim() === '';

export function planDescriptionBackfill(
  existing: Record<string, DescriptionPair>,
  content: Record<string, DescriptionPair>,
): BackfillPlan {
  const writes: BackfillPlan['writes'] = {};
  const warnings: string[] = [];
  for (const [locale, entry] of Object.entries(content ?? {})) {
    for (const [field, max] of [['short_description', SHORT_DESCRIPTION_MAX], ['description', DESCRIPTION_MAX]] as const) {
      const value = entry?.[field];
      if (blank(value)) continue;
      if ((value as string).trim().length > max) {
        warnings.push(`${locale}.${field} is longer than ${max} characters; skipped`);
        continue;
      }
      if (!blank(existing[locale]?.[field])) continue;
      (writes[locale] ??= {})[field] = (value as string).trim();
    }
  }
  return { writes, warnings };
}

export { BASE_LOCALE };
