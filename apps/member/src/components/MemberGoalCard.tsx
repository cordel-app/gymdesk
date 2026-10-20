'use client';

import { type CSSProperties, type ReactNode, useState } from 'react';
import { ImagePreviewButton } from './ImagePreview';
import { memberTheme, rowDividerStyle, sectionCardStyle } from '@/lib/memberChrome';

/**
 * #1115 / #1826 — one **Personal Goal card** in the Members App.
 *
 * ```text
 * ┌──────────────────────────────────────────────┐
 * │ [img]  Weight Loss                           │   ← header: tap to expand
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
  title, summary, expanded, onToggle, actions, imageUrl, previewUrl, imageAlt, imageFallback, imageDescription, children, headingId,
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
  /** #1873 — the larger picture shown in the enlarged view; defaults to `imageUrl`. */
  previewUrl?: string | null;
  imageAlt?: string;
  /** The text shown where there is no picture. */
  imageFallback?: string;
  /** #1873 — the goal's description, shown under the enlarged picture. */
  imageDescription?: string | null;
  children?: ReactNode;
  headingId?: string;
}) {
  const [imageBroken, setImageBroken] = useState(false);
  const showImage = imageFallback !== undefined;
  const imageSrc = imageBroken ? null : imageUrl;

  const imageBlock = showImage && (
    <span style={styles.imageBox}>
      {imageSrc ? (
        <ImagePreviewButton src={previewUrl ?? imageSrc} alt={imageAlt ?? ''} title={title} description={imageDescription ?? null}>
          <img
            src={imageSrc}
            alt={imageAlt ?? ''}
            loading="lazy"
            decoding="async"
            style={styles.image}
            onError={() => setImageBroken(true)}
          />
        </ImagePreviewButton>
      ) : (
        <span style={styles.placeholder}>{imageFallback}</span>
      )}
    </span>
  );

  const headingText = (
    <span style={styles.headerText}>
      <span id={headingId} style={styles.title}>{title}</span>
      {summary && <span style={styles.summary}>{summary}</span>}
    </span>
  );

  return (
    <article style={styles.card}>
      <div style={styles.row}>
        {imageBlock}
        <div style={styles.content}>
          {onToggle ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              style={styles.header}
            >
              {headingText}
            </button>
          ) : (
            <div style={{ ...styles.header, cursor: 'default' }}>{headingText}</div>
          )}
          {actions && <div style={styles.actions}>{actions}</div>}
        </div>
      </div>

      {expanded && children && <div style={styles.body}>{children}</div>}
    </article>
  );
}

const styles: Record<string, CSSProperties> = {
  card:        { ...sectionCardStyle, overflow: 'hidden' },
  // #1873 — the picture fills the card's height on the left; the text column
  // and the action sit to its right.
  row:         { display: 'flex', alignItems: 'stretch', gap: 12 },
  content:     { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 },
  header:      {
    display: 'flex', alignItems: 'center', gap: 12, width: '100%', boxSizing: 'border-box',
    padding: '14px 18px 8px 0', minHeight: 44,
    background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', font: 'inherit',
    color: 'inherit',
  },
  imageBox:    {
    width: 112, minHeight: 112, flexShrink: 0, alignSelf: 'stretch', overflow: 'hidden',
    display: 'flex', alignItems: 'stretch', justifyContent: 'center',
    background: memberTheme.separator,
  },
  image:       { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  placeholder: { fontSize: 10, lineHeight: 1.2, textAlign: 'center', padding: 4, color: memberTheme.textMuted, alignSelf: 'center' },
  headerText:  { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 },
  title:       { fontSize: 16, fontWeight: 700, color: memberTheme.text, overflowWrap: 'anywhere' },
  summary:     { fontSize: 13, color: memberTheme.textSecondary, overflowWrap: 'anywhere' },
  actions:     { display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0 18px 14px 0' },
  body:        { padding: '0 18px 16px', marginTop: 2, paddingTop: 12, ...rowDividerStyle },
};
