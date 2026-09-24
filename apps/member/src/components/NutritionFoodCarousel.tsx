'use client';

import React, { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { NutritionFoodCard } from './NutritionFoodCard';
import { NutritionFoodItem } from '@/lib/nutritionFood';

/**
 * #722 — the foods of one meal, as a horizontal carousel the member swipes
 * through with their finger.
 *
 * The Member app has no carousel component and no gesture library (the
 * dependency list is Next, next-intl, Clerk and FullCalendar), so the swipe is
 * the browser's own: a flex row that scrolls on the x axis with CSS scroll
 * snapping. That is what makes it feel native on a phone, and it is also why
 * nothing here listens for `touchmove` or calls `preventDefault` — vertical
 * page scrolling keeps working exactly as it did (§13), which a hand-rolled
 * gesture handler is precisely how you break.
 *
 * The buttons and the dots are conveniences on top of that scroll position,
 * never the source of truth: `onScroll` re-derives the current card from where
 * the track actually is, so a swipe, an arrow key, a button and a trackpad all
 * agree on which dot is filled.
 */

/** Above this many foods the dots become a "3 / 12" counter instead (§7). */
const MAX_DOTS = 8;

export function NutritionFoodCarousel({ items, label }: {
  items: NutritionFoodItem[];
  label: string;
}) {
  const t = useTranslations();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [current, setCurrent] = useState(0);

  const scrollToIndex = useCallback((index: number) => {
    const track = trackRef.current;
    if (!track) return;
    const clamped = Math.max(0, Math.min(index, items.length - 1));
    const slide = track.children[clamped] as HTMLElement | undefined;
    if (!slide) return;
    track.scrollTo({ left: slide.offsetLeft - track.offsetLeft, behavior: 'smooth' });
    setCurrent(clamped);
  }, [items.length]);

  /** The card nearest the middle of the viewport is the current one. */
  const handleScroll = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const centre = track.scrollLeft + track.clientWidth / 2;
    let nearest = 0;
    let shortest = Number.POSITIVE_INFINITY;
    Array.from(track.children).forEach((child, index) => {
      const slide = child as HTMLElement;
      const middle = slide.offsetLeft - track.offsetLeft + slide.clientWidth / 2;
      const distance = Math.abs(middle - centre);
      if (distance < shortest) { shortest = distance; nearest = index; }
    });
    setCurrent((previous) => (previous === nearest ? previous : nearest));
  }, []);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight') { event.preventDefault(); scrollToIndex(current + 1); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); scrollToIndex(current - 1); }
  }, [current, scrollToIndex]);

  if (items.length === 0) return null;

  const position = t('nutrition.carousel_position', { current: current + 1, total: items.length });

  return (
    <section
      role="region"
      aria-roledescription="carousel"
      aria-label={t('nutrition.carousel_label', { meal: label })}
    >
      <div
        ref={trackRef}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        style={styles.track}
      >
        {items.map((item, index) => (
          <div
            key={item.id}
            role="group"
            aria-roledescription="slide"
            aria-label={t('nutrition.carousel_position', { current: index + 1, total: items.length })}
            style={styles.slide}
          >
            <NutritionFoodCard item={item} eager={index === 0} />
          </div>
        ))}
      </div>

      {items.length > 1 && (
        <div style={styles.controls}>
          <button
            type="button"
            onClick={() => scrollToIndex(current - 1)}
            disabled={current === 0}
            aria-label={t('nutrition.previous_food')}
            style={{ ...styles.navButton, ...(current === 0 ? styles.navButtonDisabled : null) }}
          >
            ‹
          </button>

          {items.length <= MAX_DOTS && (
            // Decorative: the position is announced by the counter next to it,
            // which is also what keeps the current card legible without relying
            // on the dot's colour alone (§14).
            <span style={styles.dots} aria-hidden="true">
              {items.map((item, index) => (
                <span
                  key={item.id}
                  style={{ ...styles.dot, ...(index === current ? styles.dotCurrent : null) }}
                />
              ))}
            </span>
          )}

          <span aria-live="polite" style={styles.position}>{position}</span>

          <button
            type="button"
            onClick={() => scrollToIndex(current + 1)}
            disabled={current === items.length - 1}
            aria-label={t('nutrition.next_food')}
            style={{ ...styles.navButton, ...(current === items.length - 1 ? styles.navButtonDisabled : null) }}
          >
            ›
          </button>
        </div>
      )}
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // `overscrollBehaviorX: contain` keeps a swipe that runs off the last card
  // from turning into a browser back-gesture; `overflowY: hidden` keeps the
  // track itself out of the page's vertical scrolling.
  track: {
    display: 'flex', gap: 12, overflowX: 'auto', overflowY: 'hidden',
    scrollSnapType: 'x mandatory', overscrollBehaviorX: 'contain',
    WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none',
    padding: '2px 2px 6px', margin: '8px -2px 0',
  },
  // One card at a time on a phone with the next one peeking (§1); on a wider
  // screen the same 320px cards simply sit side by side (§8).
  slide:    { flex: '0 0 min(320px, 82%)', scrollSnapAlign: 'center', minWidth: 0 },
  controls: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 8 },
  navButton: {
    width: 36, height: 36, borderRadius: 18, border: '1px solid #e4e4e7', background: '#fff',
    color: '#3f3f46', fontSize: 18, lineHeight: 1, cursor: 'pointer', flex: '0 0 auto',
  },
  navButtonDisabled: { color: '#d4d4d8', cursor: 'default' },
  dots:       { display: 'inline-flex', alignItems: 'center', gap: 6 },
  dot:        { width: 6, height: 6, borderRadius: 3, background: '#d4d4d8' },
  dotCurrent: { width: 10, height: 10, borderRadius: 5, background: '#52525b' },
  position:   { fontSize: 12, color: '#71717a' },
};
