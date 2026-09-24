'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { NutritionFoodItem, formatQuantity } from '@/lib/nutritionFood';

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
    ? translated(t, `nutrition.component_type.${item.component_type}`, humanize(item.component_type))
    : null;
  const qualities = item.qualities ?? [];
  const imageSrc = imageBroken ? null : item.image_url ?? null;

  return (
    <article style={styles.card}>
      <div style={styles.imageBox}>
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
                {translated(t, `nutrition.quality.${quality.slug}`, humanize(quality.slug))}
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

/**
 * A label for a value that comes from the database, not from the code: a
 * `component_type` the CHECK constraint gains later, or a nutritional quality
 * slug a migration adds (#644 added two). next-intl has no locale fallback, so
 * an unknown key would otherwise render its raw dotted path to the member —
 * the humanised slug is shown instead until a translation exists.
 */
function translated(t: (key: any, values?: any) => string, key: string, fallback: string): string {
  try {
    const value = t(key as any);
    return !value || value === key ? fallback : value;
  } catch {
    return fallback;
  }
}

function humanize(slug: string): string {
  const spaced = slug.replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : slug;
}

const styles: Record<string, React.CSSProperties> = {
  card:        { background: '#fff', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.05)', overflow: 'hidden', height: '100%', display: 'flex', flexDirection: 'column' },
  imageBox:    { aspectRatio: '1 / 1', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fafafa' },
  image:       { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
  placeholder: { color: '#a1a1aa', fontSize: 12, textAlign: 'center', padding: '0 12px' },
  body:        { padding: '12px 14px 14px' },
  name:        { margin: 0, fontSize: 15, fontWeight: 700, color: '#18181b' },
  quantity:    { margin: '4px 0 0', fontSize: 13, color: '#52525b' },
  role:        { margin: '2px 0 0', fontSize: 12, color: '#71717a' },
  chips:       { display: 'flex', flexWrap: 'wrap', gap: 6, listStyle: 'none', margin: '10px 0 0', padding: 0 },
  chip:        { background: '#f4f4f5', color: '#3f3f46', borderRadius: 999, padding: '3px 9px', fontSize: 11, fontWeight: 600 },
};
