'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { StatusBadge } from '@/components/StatusBadge';
import {
  NutritionItemTaxonomy,
  NutritionLibraryItemRow,
  displayValue,
  taxonomyChipStyle,
} from './nutritionItemProfile';

/**
 * #799 §1–§7: the expanded Nutrition Library row — the complete item, strictly
 * read-only, in one fixed order: Name → Description → Status → Translations →
 * Categories → Nutritional Qualities → Media (the image, last).
 *
 * It holds no `<input>`, `<select>`, `<textarea>`, checkbox or `<button>`, no
 * image-management control and no Edit affordance: editing is reached only
 * through `⋮ → Edit`, and the image is uploaded, replaced and removed from that
 * form. Categories and qualities show the whole catalogue with the assigned ones
 * in the Edit form's selected blue (§5, §6) — as plain spans, so there is
 * nothing to click and no state to change.
 *
 * It renders the same list row the Edit form is seeded from (see
 * `toNutritionItemFormValues`), never a second read, so the two cannot disagree.
 */
export function NutritionItemReadOnlyView({
  item,
  allCategories,
  allQualities,
  locales,
  extraRows,
}: {
  item: NutritionLibraryItemRow;
  allCategories: NutritionItemTaxonomy[];
  allQualities: NutritionItemTaxonomy[];
  /**
   * The translatable locales to show a row for, so a blank one is visible while
   * authoring. Omitted (a gym's library, whose own items carry a single name)
   * falls back to whichever locales the item actually has.
   */
  locales?: string[];
  /**
   * Read-only rows belonging to the page rather than to the item's own field set
   * — the gym library's Ownership row. Rendered between Status and Translations
   * so §22's own order (Description → Status, Media last) is untouched.
   */
  extraRows?: React.ReactNode;
}) {
  const t = useTranslations('nutrition_library');
  const assignedCategoryIds = new Set(item.categories.map((c) => c.id));
  const assignedQualityIds = new Set(item.qualities.map((q) => q.id));
  const translationLocales = locales ?? Object.keys(item.translations ?? {}).sort();

  /**
   * A slug-keyed label from the catalogue namespaces, falling back to the slug
   * itself. next-intl has no fallback chain (see `apps/admin/src/i18n.ts`), so a
   * category or locale added to the database before its key is added here would
   * otherwise render as its raw key path.
   */
  const label = (key: string, fallback: string) => (t.has(key as any) ? t(key as any) : fallback);

  return (
    <div style={{ padding: '14px 20px', fontSize: 13.5, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Section label={t('label_name')}>
        <span style={valueStyle}>{displayValue(item.display_name || item.name)}</span>
      </Section>

      <Section label={t('label_description')}>
        {/* The author's own line breaks are kept, and a long word wraps instead
            of stretching the card sideways. */}
        <span style={{ ...valueStyle, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {displayValue(item.description)}
        </span>
      </Section>

      <Section label={t('col_status')}>
        <StatusBadge status={item.status} label={t(`status_${item.status}`)} />
      </Section>

      {extraRows}

      {translationLocales.length > 0 && (
        <Section label={t('label_translations')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {translationLocales.map((locale) => (
              <div key={locale} style={{ display: 'flex', gap: 10 }}>
                <span style={{ width: 110, flexShrink: 0, color: 'var(--text-muted, #888)' }}>
                  {label(`locale_${locale}`, locale.toUpperCase())}
                </span>
                <span style={valueStyle}>{displayValue(item.translations?.[locale])}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section label={t('label_categories')}>
        <TaxonomyChips all={allCategories} assigned={assignedCategoryIds} labelFor={(slug) => label(`category_${slug}`, slug)} />
      </Section>

      <Section label={t('nutritional_qualities_label')}>
        <TaxonomyChips all={allQualities} assigned={assignedQualityIds} labelFor={(slug) => label(`quality_${slug}`, slug)} />
      </Section>

      {/* Media is the last section, below Nutritional Qualities, and the image
          lives inside it (§3, §22). No upload, replace or remove — those are in
          the Edit form. */}
      <Section label={t('label_media')}>
        <div style={imageFrameStyle}>
          {item.image_url ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              // The stored key is deterministic, so a replacement reuses the URL
              // — `modified_at` is what busts the browser's cache.
              src={`${item.image_url}?v=${encodeURIComponent(item.modified_at ?? item.created_at)}`}
              alt=""
              loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
            />
          ) : (
            <span style={{ color: 'var(--text-muted, #9ca3af)', fontSize: 12, textAlign: 'center', padding: 8 }}>
              {t('no_image')}
            </span>
          )}
        </div>
      </Section>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted, #888)' }}>{label}</span>
      {children}
    </div>
  );
}

function TaxonomyChips({ all, assigned, labelFor }: {
  all: NutritionItemTaxonomy[];
  assigned: Set<number>;
  labelFor: (slug: string) => string;
}) {
  if (all.length === 0) return <span style={valueStyle}>—</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {all.map((option) => {
        const isAssigned = assigned.has(option.id);
        return (
          <span key={option.id} style={taxonomyChipStyle(isAssigned)}>
            {/* The tick carries the same information as the colour, for anyone
                who cannot tell the two chip styles apart. */}
            <span aria-hidden="true">{isAssigned ? '✓' : ''}</span>
            {labelFor(option.slug)}
          </span>
        );
      })}
    </div>
  );
}

const valueStyle: React.CSSProperties = { color: 'var(--gd-text, #333)' };

/**
 * A 1:1 frame for the food image. The checkerboard is what makes a transparent
 * background legible as transparency rather than as white, and `objectFit:
 * contain` keeps the square undistorted whatever the frame's size.
 */
const imageFrameStyle: React.CSSProperties = {
  width: 160,
  height: 160,
  flexShrink: 0,
  borderRadius: 8,
  border: '1px solid var(--card-border, #e5e7eb)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
  backgroundColor: '#fff',
  backgroundImage:
    'linear-gradient(45deg, #eee 25%, transparent 25%), linear-gradient(-45deg, #eee 25%, transparent 25%),'
    + ' linear-gradient(45deg, transparent 75%, #eee 75%), linear-gradient(-45deg, transparent 75%, #eee 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
};
