'use client';

import { memberTheme, sectionCardStyle } from '@/lib/memberChrome';

export interface SummaryCard { label: string; percent: number; detail: string }

/** #1527: the Today / This Week / This Month cards. Presentational — labels arrive resolved. */
export function TrainingSummaryCards({ cards }: { cards: SummaryCard[] }) {
  return (
    <div style={styles.row}>
      {cards.map((c) => (
        <div key={c.label} style={styles.card} role="group" aria-label={`${c.label}: ${c.percent}% (${c.detail})`}>
          <span style={styles.label}>{c.label}</span>
          <span style={styles.percent}>{c.percent}%</span>
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: { display: 'flex', gap: 8, marginBottom: 16 },
  card: { ...sectionCardStyle, flex: 1, minWidth: 0, padding: '12px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 },
  label: { fontSize: 12, fontWeight: 600, color: memberTheme.textMuted, textAlign: 'center' },
  percent: { fontSize: 22, fontWeight: 700, color: memberTheme.text },
};
