'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';

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
export function NutritionItemRow({ name, imageUrl = null, detail = null }: {
  name: string;
  imageUrl?: string | null;
  detail?: string | null;
}) {
  const t = useTranslations();
  const [imageBroken, setImageBroken] = useState(false);

  const imageSrc = imageBroken ? null : imageUrl;

  return (
    <div style={styles.row}>
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
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row:         { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid #f0f0f0' },
  imageBox:    { flex: '0 0 auto', width: 56, aspectRatio: '1 / 1', borderRadius: 10, overflow: 'hidden', background: '#fafafa', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  image:       { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
  placeholder: { color: '#a1a1aa', fontSize: 9, lineHeight: 1.2, textAlign: 'center', padding: '0 4px' },
  body:        { minWidth: 0 },
  name:        { margin: 0, fontSize: 14, fontWeight: 500, color: '#18181b' },
  detail:      { margin: '2px 0 0', fontSize: 12, color: '#71717a' },
};
