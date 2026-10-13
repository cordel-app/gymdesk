'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode, type KeyboardEvent, type TouchEvent } from 'react';
import { memberTheme } from '@/lib/memberChrome';
import { clampIndex } from '@/lib/trainingDayStatus';

/**
 * #1527: the exercises of ONE block as a horizontal scroll-snap track, the
 * Nutrition carousel's pattern (NutritionFoodCarousel): the browser owns swipe
 * and trackpad scrolling, the arrows and keys only move the scroll position and
 * `onScroll` re-derives the current card, so every method agrees. The caller
 * passes only that block's cards, so blocks are never mixed. Presentational —
 * labels arrive resolved.
 */
export function BlockExerciseCarousel({
  cards, positionLabel, prevLabel, nextLabel, groupLabel,
}: { cards: ReactNode[]; positionLabel: (index: number, count: number) => string; prevLabel: string; nextLabel: string; groupLabel: string }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [current, setCurrent] = useState(0);
  const count = cards.length;

  const scrollToIndex = useCallback((i: number) => {
    const track = trackRef.current;
    const next = clampIndex(i, count);
    const slide = track?.children[next] as HTMLElement | undefined;
    if (!track || !slide) return;
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    track.scrollTo({ left: slide.offsetLeft - track.offsetLeft, behavior: reduce ? 'auto' : 'smooth' });
    setCurrent(next);
  }, [count]);

  const onScroll = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const centre = track.scrollLeft + track.clientWidth / 2;
    let nearest = 0;
    let shortest = Number.POSITIVE_INFINITY;
    Array.from(track.children).forEach((child, i) => {
      const el = child as HTMLElement;
      const d = Math.abs(el.offsetLeft - track.offsetLeft + el.clientWidth / 2 - centre);
      if (d < shortest) { shortest = d; nearest = i; }
    });
    setCurrent((p) => (p === nearest ? p : nearest));
  }, []);

  useEffect(() => { setCurrent((c) => clampIndex(c, count)); }, [count]);

  if (count <= 1) return <>{cards[0] ?? null}</>;

  function onKey(e: KeyboardEvent) {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); scrollToIndex(current - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); scrollToIndex(current + 1); }
  }
  // Keep the page's own week-swipe from also firing on a card swipe.
  const stop = (e: TouchEvent) => e.stopPropagation();

  const atStart = current === 0;
  const atEnd = current === count - 1;

  return (
    <section role="region" aria-roledescription="carousel" aria-label={groupLabel}>
      <div style={styles.wrap}>
        <button type="button" onClick={() => scrollToIndex(current - 1)} disabled={atStart} aria-label={prevLabel}
                style={{ ...styles.arrow, left: 4, ...(atStart ? styles.arrowOff : null) }}>‹</button>
        <div ref={trackRef} onScroll={onScroll} onKeyDown={onKey} onTouchStart={stop} onTouchEnd={stop} tabIndex={0} style={styles.track}>
          {cards.map((card, i) => (
            <div key={i} role="group" aria-roledescription="slide" aria-label={positionLabel(i + 1, count)} style={styles.slide}>{card}</div>
          ))}
        </div>
        <button type="button" onClick={() => scrollToIndex(current + 1)} disabled={atEnd} aria-label={nextLabel}
                style={{ ...styles.arrow, right: 4, ...(atEnd ? styles.arrowOff : null) }}>›</button>
      </div>
      <div style={styles.position} aria-live="polite">{positionLabel(current + 1, count)}</div>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { position: 'relative' },
  track: {
    display: 'flex', gap: 12, overflowX: 'auto', overflowY: 'hidden', scrollSnapType: 'x mandatory',
    overscrollBehaviorX: 'contain', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none', padding: '2px 2px 6px',
  },
  // Cards are narrower than the track so the neighbour peeks on a phone and
  // sits beside it on a wide screen.
  slide: { flex: '0 0 min(300px, 78%)', scrollSnapAlign: 'center', minWidth: 0 },
  arrow: {
    position: 'absolute', top: '40%', zIndex: 2, width: 40, height: 40, borderRadius: '50%', padding: 0,
    border: `1px solid ${memberTheme.cardBorderColor}`, background: memberTheme.surface, color: memberTheme.text,
    fontSize: 22, lineHeight: 1, cursor: 'pointer',
  },
  arrowOff: { opacity: 0.35, cursor: 'default' },
  position: { textAlign: 'center', fontSize: 13, fontWeight: 600, color: memberTheme.textMuted },
};
