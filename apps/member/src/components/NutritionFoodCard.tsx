'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { NutritionFoodItem, formatQuantity, humanizeSlug, translatedLabel } from '@/lib/nutritionFood';
import { memberTheme, sectionCardStyle } from '@/lib/memberChrome';

/**
 * #722 — one food of a member's nutrition plan: its image on top, then the
 * information the plan carries about it.
 *
 * Deliberately dumb, like Admin's `ExerciseMediaThumbnails` (#720): it renders
 * the fields `GET /me/nutrition-plan` already returns and computes nothing.
 * Every line below the image is optional and is omitted — not blanked — when
 * the plan has no value for it (§10), so a food with only a name renders a card
 * with only a name.
 *
 * The image is the Nutrition Library item's own (a transparent PNG), so it is
 * drawn `contain` over the card's surface at 1:1 and never stretched (§2). It
 * is lazy-loaded unless it is the first card of the carousel, and one that
 * fails to load falls back to the same placeholder as a food with no image at
 * all (§9) — the information stays visible either way.
 */
export function NutritionFoodCard({ item, eager = false }: {
  item: NutritionFoodItem;
  eager?: boolean;
}) {
  const t = useTranslations();
  const [imageBroken, setImageBroken] = useState(false);

  const quantity = formatQuantity(item.quantity, item.unit);
  const role = item.component_type
    ? translatedLabel(t, `nutrition.component_type.${item.component_type}`, humanizeSlug(item.component_type))
    : null;
  const qualities = item.qualities ?? [];
  const imageSrc = imageBroken ? null : item.image_url ?? null;

  return (
    <article style={styles.card}>
      <style>{FOOD_IMAGE_MOBILE_CSS}</style>
      <div className="gd-food-image" style={styles.imageBox}>
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={t('nutrition.food_image_alt', { name: item.item_name })}
            loading={eager ? 'eager' : 'lazy'}
            decoding="async"
            style={styles.image}
            onError={() => setImageBroken(true)}
          />
        ) : (
          <span style={styles.placeholder}>{t('nutrition.no_image')}</span>
        )}
      </div>

      <div style={styles.body}>
        <p style={styles.name}>{item.item_name}</p>
        {quantity && <p style={styles.quantity}>{quantity}</p>}
        {role && <p style={styles.role}>{role}</p>}
        {qualities.length > 0 && (
          <ul style={styles.chips}>
            {qualities.map((quality) => (
              <li key={quality.id} style={styles.chip}>
                {translatedLabel(t, `nutrition.quality.${quality.slug}`, humanizeSlug(quality.slug))}
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

/**
 * #1241 — on a phone the 1:1 image is a third of the screen; shrink it (still
 * square, still centred) so more of the meal is visible. Inline styles cannot
 * carry a media query, hence a rule in a sheet (`!important` beats the inline
 * width). Desktop and tablet keep the full-width image.
 */
export const FOOD_IMAGE_MOBILE_CSS =
  '@media (max-width: 768px) { .gd-food-image { width: 50% !important; margin: 0 auto; } }';

const styles: Record<string, React.CSSProperties> = {
  card:        { ...sectionCardStyle, boxShadow: '0 1px 3px rgba(0,0,0,0.05)', overflow: 'hidden', height: '100%', display: 'flex', flexDirection: 'column' },
  imageBox:    { aspectRatio: '1 / 1', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: memberTheme.pageBackground },
  image:       { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
  placeholder: { color: memberTheme.textMuted, fontSize: 12, textAlign: 'center', padding: '0 12px' },
  body:        { padding: '12px 14px 14px' },
  name:        { margin: 0, fontSize: 15, fontWeight: 700, color: memberTheme.text },
  quantity:    { margin: '4px 0 0', fontSize: 13, color: memberTheme.textSecondary },
  role:        { margin: '2px 0 0', fontSize: 12, color: memberTheme.textMuted },
  chips:       { display: 'flex', flexWrap: 'wrap', gap: 6, listStyle: 'none', margin: '10px 0 0', padding: 0 },
  chip:        { background: memberTheme.pageBackground, color: memberTheme.textSecondary, borderRadius: 999, padding: '3px 9px', fontSize: 11, fontWeight: 600 },
};
