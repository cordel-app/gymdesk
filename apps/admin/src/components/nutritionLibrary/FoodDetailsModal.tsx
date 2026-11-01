'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';
import { NutritionLibraryItemRow, displayValue } from './nutritionItemProfile';

/**
 * #2204: the food details opened from an Assigned Nutrition Plan (the Member card's
 * Nutrition Plan and the standalone Assigned Nutrition Plans page share one tree).
 * Read-only: a large picture, then every field the Nutrition Library holds for the
 * food, each beside a monochrome icon (`currentColor`, never a hue of its own).
 *
 * It renders a Nutrition Library row the tree already read; when the food is not in
 * that read (more than one page of foods, or a food since removed) the caller hands
 * a minimal row built from the plan item, and every field this modal cannot fill
 * reads `—` rather than disappearing, so the layout never depends on the data.
 */
export function FoodDetailsModal({ item, onClose }: { item: FoodDetailsRow; onClose: () => void }) {
  const t = useTranslations('nutrition_library');
  const label = (key: string, fallback: string) => (t.has(key as any) ? t(key as any) : fallback);
  const [imageFailed, setImageFailed] = React.useState(false);

  const categories = (item.categories ?? []).map((c) => label(`category_${c.slug}`, c.slug));
  const qualities = (item.qualities ?? []).map((q) => label(`quality_${q.slug}`, q.slug));
  const translations = Object.entries(item.translations ?? {}).filter(([, v]) => v && v.trim());
  const description = item.display_description ?? item.description;

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('food_details_title')}
        style={{ ...modalStyle, width: 520, maxHeight: '90vh', overflowY: 'auto', boxSizing: 'border-box' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={imageFrameStyle}>
          {item.image_url && !imageFailed ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={item.modified_at ? `${item.image_url}?v=${encodeURIComponent(item.modified_at)}` : item.image_url}
              alt=""
              onError={() => setImageFailed(true)}
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
            />
          ) : (
            <span style={{ color: 'var(--text-muted, #9ca3af)', fontSize: 12 }}>{t('no_image')}</span>
          )}
        </div>

        <h2 style={{ margin: '16px 0 12px', fontSize: 20, overflowWrap: 'anywhere' }}>
          {displayValue(item.display_name || item.name)}
        </h2>

        <Row icon={<IconText />} label={t('label_description')} wrap>
          {displayValue(description)}
        </Row>
        <Row icon={<IconTag />} label={t('label_categories')}>
          {categories.length ? categories.join(', ') : displayValue(null)}
        </Row>
        <Row icon={<IconLeaf />} label={t('nutritional_qualities_label')}>
          {qualities.length ? qualities.join(', ') : displayValue(null)}
        </Row>
        {item.status && (
          <Row icon={<IconCheck />} label={t('col_status')}>
            {t(`status_${item.status}` as any)}
          </Row>
        )}
        {translations.length > 0 && (
          <Row icon={<IconGlobe />} label={t('label_translations')}>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {translations.map(([locale, value]) => (
                <span key={locale}>{label(`locale_${locale}`, locale.toUpperCase())}: {value}</span>
              ))}
            </span>
          </Row>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button type="button" onClick={onClose} style={btnStyle('#444')}>{t('close')}</button>
        </div>
      </div>
    </div>
  );
}

/** What the modal needs of a row: the library's own row, or a minimal one from a plan item. */
export type FoodDetailsRow = Pick<NutritionLibraryItemRow, 'id' | 'name' | 'image_url'> &
  Partial<Omit<NutritionLibraryItemRow, 'id' | 'name' | 'image_url'>> & { display_description?: string | null };

function Row({ icon, label, children, wrap }: { icon: React.ReactNode; label: string; children: React.ReactNode; wrap?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--card-border, #f0f0f0)', alignItems: 'flex-start' }}>
      <span style={{ color: 'var(--text-muted, #666)', display: 'inline-flex', flexShrink: 0, marginTop: 1 }}>{icon}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted, #888)', marginBottom: 2 }}>{label}</div>
        <div style={{ fontSize: 13.5, color: 'var(--gd-text, #333)', overflowWrap: 'anywhere', ...(wrap ? { whiteSpace: 'pre-wrap' } : {}) }}>
          {children}
        </div>
      </div>
    </div>
  );
}

const imageFrameStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 320,
  aspectRatio: '1 / 1',
  margin: '0 auto',
  borderRadius: 12,
  border: '1px solid var(--card-border, #e5e7eb)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
  background: 'var(--gd-input-bg, #f6f6f6)',
};

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}
const IconText = () => <Svg><path d="M4 6h16M4 12h16M4 18h10" /></Svg>;
const IconTag = () => <Svg><path d="M20 12l-8 8-9-9V3h8z" /><circle cx="7.5" cy="7.5" r="1" /></Svg>;
const IconLeaf = () => <Svg><path d="M5 19c0-9 5-14 15-14 0 10-5 15-14 15" /><path d="M5 19l8-8" /></Svg>;
const IconCheck = () => <Svg><circle cx="12" cy="12" r="9" /><path d="M8 12l3 3 5-6" /></Svg>;
const IconGlobe = () => <Svg><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></Svg>;
