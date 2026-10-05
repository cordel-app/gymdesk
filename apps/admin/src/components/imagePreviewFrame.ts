/**
 * The 1:1 frame an image preview is drawn in, declared once (#1035 stage 2).
 *
 * It is the frame #715 introduced for a Base Nutrition Library food and #719
 * reused for an Exercise: a square box, `object-fit: contain` on the `<img>` so
 * the picture is never distorted, and a checkerboard behind it so a transparent
 * background reads as transparency rather than as white. Both of those were
 * spelled inline in their own components, which is how a third upload control
 * comes to invent a fourth look — so the style lives here and the components
 * spread it, the same one-place rule `formChrome.ts` is for the inside of a card
 * and `listChrome.ts` is for a list.
 *
 * Only the **size** is the caller's, because that is the one thing a surface
 * legitimately differs on (a 140px editor frame, a 64px row thumbnail): the
 * border, the radius, the centring and the checkerboard are not, and a caller
 * that spells one of those again is restating chrome.
 */
import type React from 'react';

/** The editor-sized frame every upload control uses. */
export const IMAGE_PREVIEW_FRAME_SIZE = 140;

/** The compact frame a read-only card draws beside a row's own fields. */
export const IMAGE_PREVIEW_THUMBNAIL_SIZE = 72;

export function imagePreviewFrameStyle(size: number = IMAGE_PREVIEW_FRAME_SIZE): React.CSSProperties {
  return {
    width: size,
    height: size,
    flexShrink: 0,
    borderRadius: 8,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    border: '1px solid var(--gd-card-border, #e5e7eb)',
    backgroundColor: '#fff',
    backgroundImage:
      'linear-gradient(45deg, #eee 25%, transparent 25%), linear-gradient(-45deg, #eee 25%, transparent 25%),'
      + ' linear-gradient(45deg, transparent 75%, #eee 75%), linear-gradient(-45deg, transparent 75%, #eee 75%)',
    backgroundSize: '16px 16px',
    backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
  };
}

/** What the `<img>` inside the frame wears, so the picture is contained rather than cropped. */
export const imagePreviewImageStyle: React.CSSProperties = {
  maxWidth: '100%',
  maxHeight: '100%',
  objectFit: 'contain',
};
