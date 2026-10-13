'use client';

import { useState, type ReactNode, type TouchEvent, type KeyboardEvent } from 'react';
import { memberTheme, secondaryButtonStyle } from '@/lib/memberChrome';
import { swipeWeekDelta } from '@/lib/trainingWeek';
import { clampIndex } from '@/lib/trainingDayStatus';

/**
 * #1527: one exercise card at a time for the exercises of ONE block. The caller
 * passes only that block's cards, so exercises of different blocks are never
 * grouped. Presentational — labels arrive resolved.
 */
export function BlockExerciseCarousel({
  cards, positionLabel, prevLabel, nextLabel, groupLabel,
}: { cards: ReactNode[]; positionLabel: (index: number, count: number) => string; prevLabel: string; nextLabel: string; groupLabel: string }) {
  const [index, setIndex] = useState(0);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const count = cards.length;
  const current = clampIndex(index, count);
  const go = (delta: number) => setIndex(clampIndex(current + delta, count));

  if (count <= 1) return <>{cards[0] ?? null}</>;

  function onTouchEnd(e: TouchEvent) {
    // Keep the page's own week-swipe from also firing.
    e.stopPropagation();
    if (!start) return;
    const t = e.changedTouches[0];
    const d = swipeWeekDelta(t.clientX - start.x, t.clientY - start.y);
    setStart(null);
    if (d !== 0) go(d);
  }
  function onKey(e: KeyboardEvent) {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  }

  return (
    <div role="group" aria-roledescription="carousel" aria-label={groupLabel} tabIndex={0} onKeyDown={onKey}
         onTouchStart={(e) => { e.stopPropagation(); setStart({ x: e.touches[0].clientX, y: e.touches[0].clientY }); }} onTouchEnd={onTouchEnd}
         style={{ outlineOffset: 2 }}>
      <div style={styles.nav}>
        <button type="button" onClick={() => go(-1)} disabled={current === 0} aria-label={prevLabel} style={styles.arrow}>‹</button>
        <span style={styles.position} aria-live="polite">{positionLabel(current + 1, count)}</span>
        <button type="button" onClick={() => go(1)} disabled={current === count - 1} aria-label={nextLabel} style={styles.arrow}>›</button>
      </div>
      {cards[current]}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  nav: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  arrow: { ...secondaryButtonStyle, width: 36, height: 36, borderRadius: '50%', padding: 0, fontSize: 20, lineHeight: 1 },
  position: { fontSize: 13, fontWeight: 600, color: memberTheme.textMuted },
};
