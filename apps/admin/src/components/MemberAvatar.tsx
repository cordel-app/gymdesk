'use client';

import React, { useEffect, useState } from 'react';
import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';
import { memberImagePreviewSrc } from '@/components/MemberImageField';

/**
 * #1376 — a Member's profile image as a small circle in the Members list.
 *
 * Reads the `image_url` the list already returns (#1374) — no request of its
 * own — cache-busted by `memberImagePreviewSrc()`. A Member with no image, or
 * one whose image fails to load, gets a neutral circle with their initial
 * rather than a broken-image icon.
 */
export const MEMBER_AVATAR_SIZE = 32;

export function MemberAvatar({
  name, imageUrl, stamp, size = MEMBER_AVATAR_SIZE,
}: {
  name: string;
  imageUrl: string | null | undefined;
  stamp?: string | null;
  size?: number;
}) {
  const src = memberImagePreviewSrc(imageUrl, stamp);
  // Tested inline so the guard sits at the sink (#767).
  const drawable = src != null && SAFE_IMAGE_SRC.test(src);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);

  const frame: React.CSSProperties = {
    width: size, height: size, borderRadius: '50%', flexShrink: 0,
    overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,0.08)', color: 'inherit', fontSize: Math.round(size * 0.42), fontWeight: 600,
  };
  return (
    <div style={frame} aria-hidden="true">
      {drawable && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src!} alt="" loading="lazy" onError={() => setFailed(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <span>{(name.trim().charAt(0) || '?').toUpperCase()}</span>
      )}
    </div>
  );
}
