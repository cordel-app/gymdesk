'use client';

import { useState } from 'react';

export const FOOD_THUMBNAIL_SIZE = 32;

/**
 * Small circular food picture shown before the name in both Foods lists
 * (Gym and Cordel Base). A food with no image, or one that fails to load,
 * renders a neutral placeholder of the same size so rows stay aligned.
 */
export function FoodThumbnail({ imageUrl, version }: { imageUrl: string | null; version?: string | null }) {
  const [failed, setFailed] = useState(false);
  const box = {
    width: FOOD_THUMBNAIL_SIZE,
    height: FOOD_THUMBNAIL_SIZE,
    minWidth: FOOD_THUMBNAIL_SIZE,
    borderRadius: '50%',
    flexShrink: 0,
    display: 'inline-block',
    overflow: 'hidden',
    verticalAlign: 'middle',
  } as const;
  if (!imageUrl || failed) {
    return <span aria-hidden="true" style={{ ...box, background: 'var(--gd-input-bg, #f1f1f1)', border: '1px solid var(--gd-card-border, #e0e0e0)' }} />;
  }
  const src = version ? `${imageUrl}?v=${encodeURIComponent(version)}` : imageUrl;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} style={{ ...box, objectFit: 'cover' }} />
  );
}
