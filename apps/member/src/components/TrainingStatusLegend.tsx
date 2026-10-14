'use client';

import { MemberDialog } from '@/components/MemberDialog';
import { memberTheme, secondaryButtonStyle } from '@/lib/memberChrome';
import type { NutritionDayStatus } from '@/lib/trainingDayStatus';

/** The colour role each day status reads in — the app's status tokens, plus a neutral for rest. */
export const DAY_STATUS_COLOR: Record<NutritionDayStatus, string> = {
  completed: memberTheme.statusSuccess,
  partial: `linear-gradient(90deg, ${memberTheme.statusSuccess} 50%, ${memberTheme.statusError} 50%)`,
  pending: memberTheme.statusError,
  scheduled: memberTheme.statusWarning,
  rest: memberTheme.textMuted,
};

/** #1527: informational only — it changes no status. */
export function TrainingStatusLegend({
  title, closeLabel, items, onClose,
}: { title: string; closeLabel: string; items: { status: NutritionDayStatus; label: string }[]; onClose: () => void }) {
  return (
    <MemberDialog title={title} onClose={onClose} labelledBy="training-status-legend-title"
      actions={<button type="button" onClick={onClose} style={{ ...secondaryButtonStyle, padding: '8px 14px', borderRadius: 6 }}>{closeLabel}</button>}>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((i) => (
          <li key={i.status} style={{ display: 'flex', alignItems: 'center', gap: 10, color: memberTheme.text, fontSize: 14 }}>
            <span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: '50%', background: DAY_STATUS_COLOR[i.status], flexShrink: 0 }} />
            {i.label}
          </li>
        ))}
      </ul>
    </MemberDialog>
  );
}
