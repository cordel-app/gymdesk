// #1779 — presentation only: every string arrives resolved and no colour is
// spelled here (#983). The balances are the API's (`GET /me/professional-services`);
// nothing is summed or derived in the browser.
import type { CSSProperties } from 'react';
import { memberTheme, noticeStyle, rowDividerStyle, sectionCardStyle } from '@/lib/memberChrome';

export interface MemberServiceBalanceItem {
  professional_service_id: number;
  name: string;
  total: number;
  used: number;
  remaining: number;
}

interface Props {
  items: MemberServiceBalanceItem[] | null;
  labels: { empty: string; error: string; total: string; used: string; remaining: string };
}

const cell: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 72 };
const small: CSSProperties = { fontSize: 12, color: memberTheme.textMuted };

export function MemberProfessionalServices({ items, labels }: Props) {
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
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <strong style={{ color: memberTheme.text }}>{item.name}</strong>
          <div style={{ display: 'flex', gap: 16 }}>
            <div style={cell}><span style={small}>{labels.total}</span><span>{item.total}</span></div>
            <div style={cell}><span style={small}>{labels.used}</span><span>{item.used}</span></div>
            <div style={cell}><span style={small}>{labels.remaining}</span><strong>{item.remaining}</strong></div>
          </div>
        </div>
      ))}
    </div>
  );
}
