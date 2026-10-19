'use client';

import { type CSSProperties, type ReactNode, useState } from 'react';
import { memberTheme, rowDividerStyle, sectionCardStyle } from '@/lib/memberChrome';

/**
 * #1115 / #1826 — one **Personal Goal card** in the Members App.
 *
 * ```text
 * ┌──────────────────────────────────────────────┐
 * │ [img]  Weight Loss                         ▸ │   ← header: tap to expand
 * │        Target: 70 kg · 65%                   │
 * │        [ Add reading ]                       │   ← the goal's own action
 * ├──────────────────────────────────────────────┤
 * │ (the goal's own content, when expanded)      │   ← full card width
 * └──────────────────────────────────────────────┘
 * ```
 *
 * It owns the card's **shape** and nothing about goals: the title, the summary
 * line and the image arrive already resolved, exactly as `GoalHeaderFields`
 * (#1037) and `NutritionItemRow` (#932) take theirs, so this file calls no
 * `t()` and reads no row. The expanded content is the caller's children.
 *
 * * **The header is one button and the action is another.** A nested button is
 *   invalid HTML, so `actions` sit beside the toggling header (under the text,
 *   outside the `<button>`), which is also why they stay available collapsed.
 * * **The image is on the left and is never an empty box.** A missing or broken
 *   picture falls back to `imageFallback` (the same placeholder the nutrition
 *   cards use), at the same 1:1 size, so the text column never shifts.
 * * **It is collapsed by default, and the page says so.** The open state is the
 *   caller's; a card with **no** `onToggle` renders the same chrome with no
 *   affordance at all.
 * * **It spells no colour.** Every surface and type colour is `memberChrome.ts`'s
 *   (#983).
 */
export function MemberGoalCard({
  title, summary, expanded, onToggle, actions, imageUrl, imageAlt, imageFallback, children, headingId,
}: {
  title: string;
  /** `Target: 70 kg · 65%`, or `null` for a goal that has neither (§1). */
  summary?: string | null;
  expanded: boolean;
  /** Omitted on a card whose body is a form: there is nothing to collapse. */
  onToggle?: () => void;
  /** The goal's own actions, shown collapsed and expanded alike. */
  actions?: ReactNode;
  /** #1826 — the goal's picture; `undefined` hides the image slot entirely. */
  imageUrl?: string | null;
  imageAlt?: string;
  /** The text shown where there is no picture. */
  imageFallback?: string;
  children?: ReactNode;
  headingId?: string;
}) {
  const [imageBroken, setImageBroken] = useState(false);
  const showImage = imageFallback !== undefined;
  const imageSrc = imageBroken ? null : imageUrl;

  const heading = (
    <>
      {showImage && (
        <span style={styles.imageBox}>
          {imageSrc ? (
            <img
              src={imageSrc}
              alt={imageAlt ?? ''}
              loading="lazy"
              decoding="async"
              style={styles.image}
              onError={() => setImageBroken(true)}
            />
          ) : (
            <span style={styles.placeholder}>{imageFallback}</span>
          )}
        </span>
      )}
      <span style={styles.headerText}>
        <span id={headingId} style={styles.title}>{title}</span>
        {summary && <span style={styles.summary}>{summary}</span>}
      </span>
    </>
  );

  return (
    <article style={styles.card}>
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          style={styles.header}
        >
          {heading}
          {/* The affordance only: the accessible name is the goal's own name,
              and `aria-expanded` above is what says which way it points. */}
          <span style={styles.caret} aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        </button>
      ) : (
        <div style={{ ...styles.header, cursor: 'default' }}>{heading}</div>
      )}
      {actions && <div style={styles.actions}>{actions}</div>}

      {expanded && children && <div style={styles.body}>{children}</div>}
    </article>
  );
}

const styles: Record<string, CSSProperties> = {
  card:        { ...sectionCardStyle },
  header:      {
    display: 'flex', alignItems: 'center', gap: 12, width: '100%', boxSizing: 'border-box',
    // §5 — a compact layout with a comfortable target: the whole header is
    // tappable rather than the caret alone.
    padding: '14px 18px', minHeight: 44,
    background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', font: 'inherit',
    color: 'inherit',
  },
  imageBox:    {
    width: 72, height: 72, flexShrink: 0, aspectRatio: '1 / 1', borderRadius: 10, overflow: 'hidden',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: memberTheme.separator,
  },
  image:       { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
  placeholder: { fontSize: 10, lineHeight: 1.2, textAlign: 'center', padding: 4, color: memberTheme.textMuted },
  headerText:  { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 },
  title:       { fontSize: 16, fontWeight: 700, color: memberTheme.text, overflowWrap: 'anywhere' },
  summary:     { fontSize: 13, color: memberTheme.textSecondary, overflowWrap: 'anywhere' },
  caret:       { fontSize: 12, color: memberTheme.textMuted, flexShrink: 0 },
  actions:     { display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0 18px 14px' },
  body:        { padding: '0 18px 16px', marginTop: 2, paddingTop: 12, ...rowDividerStyle },
};
