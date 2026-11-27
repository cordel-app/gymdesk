'use client';

import { useTranslations } from 'next-intl';
import { ImagePreviewButton } from './ImagePreview';
import { MemberAvatar } from './MemberAvatar';

/**
 * #3490 — a Nutrition Goal's or a Dietary Restriction's small circular thumbnail
 * on the Home summary.
 *
 * The circle is the app's one avatar rendering (`MemberAvatar`: the picture
 * cropped to a circle, the name's initials when there is none), and a tap opens
 * the same enlarged-image dialog My Nutrition opens for that item
 * (`ImagePreviewButton`), so no second modal exists. Presentation only: the name,
 * the detail line and the image URL are the caller's.
 */
export function NutritionItemThumbnail({ name, imageUrl, detail = null, size }: {
  name: string;
  imageUrl: string | null | undefined;
  detail?: string | null;
  size: number;
}) {
  const t = useTranslations();
  return (
    <span style={{ width: size, height: size, flexShrink: 0, display: 'inline-flex' }}>
      <ImagePreviewButton
        src={imageUrl ?? null}
        alt={t('nutrition.food_image_alt', { name })}
        title={name}
        description={detail}
        style={{ width: size, height: size, borderRadius: '50%' }}
      >
        <MemberAvatar member={{ name, image_url: imageUrl ?? null }} size={size} />
      </ImagePreviewButton>
    </span>
  );
}
