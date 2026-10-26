'use client';

// #1779 / #2103 — presentation only: every string arrives resolved and no colour
// is spelled here (#983). The balance is the API's (`GET /me/professional-services`);
// nothing is summed or derived in the browser. A row is the thumbnail (only when
// the service has an image), the name and the sessions still available.
import { useState, type CSSProperties } from 'react';
import { memberTheme, noticeStyle, rowDividerStyle, sectionCardStyle } from '@/lib/memberChrome';
import { MemberDialog } from '@/components/MemberDialog';

export interface MemberServiceBalanceItem {
  professional_service_id: number;
  name: string;
  description?: string | null;
  image_url?: string | null;
  total: number;
  used: number;
  remaining: number;
}

interface Props {
  items: MemberServiceBalanceItem[] | null;
  labels: {
    empty: string;
    error: string;
    available: (count: number) => string;
    close: string;
    imageAlt: string;
  };
}

const small: CSSProperties = { fontSize: 12, color: memberTheme.textMuted };

export function MemberProfessionalServices({ items, labels }: Props) {
  const [selected, setSelected] = useState<MemberServiceBalanceItem | null>(null);
  if (items === null) return <p style={{ ...noticeStyle('error'), padding: 12 }}>{labels.error}</p>;
  if (items.length === 0) return <p style={{ ...small, fontSize: 14, margin: '12px 0' }}>{labels.empty}</p>;
  return (
    <div style={{ ...sectionCardStyle, padding: 4 }}>
      {items.map((item, index) => (
        <div
          key={item.professional_service_id}
          style={{
            ...(index > 0 ? rowDividerStyle : null),
            padding: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          {item.image_url ? (
            <button
              type="button"
              onClick={() => setSelected(item)}
              aria-label={item.name}
              style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer', flex: '0 0 auto', lineHeight: 0 }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.image_url}
                alt=""
                width={40}
                height={40}
                style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', display: 'block' }}
              />
            </button>
          ) : null}
          <strong style={{ color: memberTheme.text, flex: '1 1 auto', minWidth: 0 }}>{item.name}</strong>
          <span style={{ ...small, fontSize: 13, whiteSpace: 'nowrap' }}>{labels.available(item.remaining)}</span>
        </div>
      ))}
      {selected && selected.image_url ? (
        <MemberDialog
          title={selected.name}
          labelledBy="service-image-title"
          onClose={() => setSelected(null)}
          actions={
            <button type="button" onClick={() => setSelected(null)} style={{ cursor: 'pointer' }}>
              {labels.close}
            </button>
          }
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={selected.image_url}
            alt={labels.imageAlt}
            style={{ width: '100%', maxHeight: '55vh', aspectRatio: '1 / 1', objectFit: 'contain', display: 'block' }}
          />
          {selected.description ? (
            <p style={{ margin: 0, color: memberTheme.text, whiteSpace: 'pre-wrap' }}>{selected.description}</p>
          ) : null}
        </MemberDialog>
      ) : null}
    </div>
  );
}
