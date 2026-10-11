'use client';

import { memberTheme } from '@/lib/memberChrome';
import { ringGeometry } from '@/lib/trainingWeek';

const SIZE = 84;
const STROKE = 9;
const RADIUS = (SIZE - STROKE) / 2;

/** #1370: a labelled progress ring. Presentational — the label arrives resolved. */
export function ProgressDonut({ label, percent, detail }: { label: string; percent: number; detail?: string }) {
  const g = ringGeometry(percent, RADIUS);
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}
         role="img" aria-label={`${label}: ${g.percent}%${detail ? ` (${detail})` : ''}`}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ width: '100%', maxWidth: SIZE, height: 'auto' }} aria-hidden="true" focusable="false">
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke={memberTheme.separator} strokeWidth={STROKE} />
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke={memberTheme.primaryButton} strokeWidth={STROKE}
                strokeLinecap="round" strokeDasharray={g.circumference} strokeDashoffset={g.dashOffset}
                transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`} />
        <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central"
              style={{ fontSize: 18, fontWeight: 700, fill: memberTheme.text }}>{g.percent}%</text>
      </svg>
      <span style={{ fontSize: 12, fontWeight: 600, color: memberTheme.textMuted, textAlign: 'center' }}>{label}</span>
    </div>
  );
}
