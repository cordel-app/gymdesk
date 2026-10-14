'use client';

import React from 'react';
import { InlineStyle } from '@/components/InlineStyle';
import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';

/**
 * The one responsive card grid (#1530, shared by every card view in #1575). It is
 * driven by the width of its own container rather than the viewport, because the
 * sidebar changes the room a page has: one card per row on a phone, two on a
 * tablet, three by default and four once each card can keep about 300px. Layout
 * only — it filters and sorts nothing, and `min-width: 0` keeps a card from
 * pushing past its container.
 */
const GRID_CSS = `
.gd-card-grid-wrap { container-type: inline-size; min-width: 0; }
.gd-card-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.gd-card-grid > * { min-width: 0; }
@container (min-width: 640px) { .gd-card-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; } }
@container (min-width: 960px) { .gd-card-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; } }
@container (min-width: 1272px) { .gd-card-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
`;

export function CardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="gd-card-grid-wrap">
      <InlineStyle css={GRID_CSS} />
      <div className="gd-card-grid">{children}</div>
    </div>
  );
}

/**
 * A card's image area: always square (the source images are 1080 × 1080), the
 * picture filling it with `object-fit: cover` so it is cropped, never stretched.
 * A missing or broken image shows the caller's placeholder in the same square.
 */
export function CardSquareImage({
  src, alt, placeholder, version,
}: {
  src: string | null | undefined;
  alt: string;
  placeholder: React.ReactNode;
  /** Cache-buster, normally the row's `modified_at`. */
  version?: string | null;
}) {
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => { setBroken(false); }, [src]);
  const show = !!src && SAFE_IMAGE_SRC.test(src) && !broken;
  return (
    <div style={{ aspectRatio: '1 / 1', width: '100%', overflow: 'hidden', background: 'var(--gd-app-bg, #f3f4f6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {show ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`${src}${src!.includes('?') ? '&' : '?'}v=${encodeURIComponent(version ?? '')}`}
          alt={alt}
          loading="lazy"
          onError={() => setBroken(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : placeholder}
    </div>
  );
}
