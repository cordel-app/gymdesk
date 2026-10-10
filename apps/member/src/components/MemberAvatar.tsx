'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { memberAvatarColors, memberAvatarSrc, memberInitials } from '@/lib/memberAvatar';

/**
 * #1375 — the one rendering of a member's avatar: their photo when there is one
 * (#1374's `image_url`), the initials circle otherwise, and the initials again
 * if the photo fails to load — never a broken-image icon.
 *
 * Presentation only: the `src` and the colour pair are `lib/memberAvatar.ts`'s
 * (every colour a `memberChrome` role, #983), and the size is the caller's,
 * because that is the one thing the top bar (32px) and the Profile page (96px)
 * legitimately differ on. Rendered by `MemberUserMenu` and the Profile page;
 * a third surface renders this rather than an `<img>` of its own.
 */
export function MemberAvatar({
  member, size, style,
}: {
  member: { id?: number | null; name?: string | null; image_url?: string | null; modified_at?: string | null } | null;
  size: number;
  style?: CSSProperties;
}) {
  const src = memberAvatarSrc(member?.image_url, member?.modified_at);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);

  const base: CSSProperties = {
    width: size, height: size, flexShrink: 0, borderRadius: '50%', overflow: 'hidden',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: Math.round(size * 0.4), fontWeight: 700, lineHeight: 1,
    ...memberAvatarColors(member?.id ?? member?.name),
    ...style,
  };

  if (src && !failed) {
    return (
      <span style={base} aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt=""
          onError={() => setFailed(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      </span>
    );
  }
  return <span style={base} aria-hidden="true">{memberInitials(member?.name) || '◉'}</span>;
}
