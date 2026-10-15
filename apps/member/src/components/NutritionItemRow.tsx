'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { memberTheme, sectionCardStyle } from '@/lib/memberChrome';

/**
 * #932 §4 — one image-plus-name row of My Nutrition, shared by the plan's
 * **Dietary Restrictions** and its **Nutrition Goals** so the two sections
 * cannot drift apart: image size, aspect ratio, border radius, alignment,
 * spacing, typography and the missing-image fallback are decided here and
 * nowhere else.
 *
 * Deliberately dumb, like `NutritionFoodCard` (#722): it renders the strings it
 * is handed and resolves nothing. The image is the Nutrition Library item's own
 * transparent PNG, so it is drawn `contain` at 1:1 and never stretched, and one
 * that is missing or fails to load falls back to the same `nutrition.no_image`
 * placeholder the food card uses (§3) — the name stays visible either way.
 *
 * A goal passes `imageUrl={null}` today and therefore reads as that fallback:
 * `member_nutrition_plan_goals` carries no link to a food, and giving it one is
 * the follow-up work tracked on the issue. When that link lands, this row fills
 * itself with no change here.
 */
export function NutritionItemRow({ name, imageUrl = null, detail = null, actions = null }: {
  name: string;
  imageUrl?: string | null;
  detail?: string | null;
  /** Rendered under the card's text (mark-done buttons). */
  actions?: React.ReactNode;
}) {
  const t = useTranslations();
  const [imageBroken, setImageBroken] = useState(false);

  const imageSrc = imageBroken ? null : imageUrl;

  return (
    <article style={styles.card}>
      <div style={styles.imageBox}>
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={t('nutrition.food_image_alt', { name })}
            loading="lazy"
            decoding="async"
            style={styles.image}
            onError={() => setImageBroken(true)}
          />
        ) : (
          <span style={styles.placeholder}>{t('nutrition.no_image')}</span>
        )}
      </div>
      <div style={styles.body}>
        <p style={styles.name}>{name}</p>
        {detail && <p style={styles.detail}>{detail}</p>}
      </div>
      {actions && <div style={styles.actions}>{actions}</div>}
    </article>
  );
}

/** #1602 — the grid both sections lay their cards out in (like My Training Plan). */
export const nutritionItemGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
  gap: 12,
  padding: '14px 0',
};

const styles: Record<string, React.CSSProperties> = {
  card:        { ...sectionCardStyle, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  imageBox:    { aspectRatio: '1 / 1', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: memberTheme.pageBackground },
  image:       { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
  placeholder: { color: memberTheme.textMuted, fontSize: 12, textAlign: 'center', padding: '0 12px' },
  body:        { padding: '10px 12px 12px', minWidth: 0 },
  name:        { margin: 0, fontSize: 14, fontWeight: 700, color: memberTheme.text },
  detail:      { margin: '2px 0 0', fontSize: 12, color: memberTheme.textMuted },
  actions:     { padding: '0 12px 12px' },
};
