'use client';

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { memberTheme, rowDividerStyle, sectionCardStyle } from '@/lib/memberChrome';

/**
 * #1115 — one **Personal Goal card** in the Members App.
 *
 * ```text
 * ┌──────────────────────────────────────────────┐
 * │ Weight Loss                            ▸  ⋮ │   ← header: tap to expand
 * │ Target: 70 kg · 65%                          │
 * ├──────────────────────────────────────────────┤
 * │ (the goal's own content, when expanded)      │
 * └──────────────────────────────────────────────┘
 * ```
 *
 * It owns the card's **shape** and nothing about goals: the title, the summary
 * line and every menu label arrive already resolved and formatted, exactly as
 * `GoalHeaderFields` (#1037) and `NutritionItemRow` (#932) take theirs, so this
 * file calls no `t()` and reads no row. The expanded content is the caller's
 * children — which is what §1 means by "an expandable content area where the
 * progress visualization can be integrated separately".
 *
 * Four of its answers are the rule rather than the implementation.
 *
 * * **The header is one button and the menu is another.** §4 requires that
 *   tapping the menu neither expands nor collapses the card, and the only way
 *   that holds for certain is for the `⋮` to sit *outside* the element that
 *   toggles — a nested button is invalid HTML, and `stopPropagation()` on a
 *   click handler is a rule a later edit can forget.
 * * **It is collapsed by default, and the page says so.** The open state is the
 *   caller's (`expanded` / `onToggle`), because the page is what knows which
 *   card it has just put into an editing state and must show. A card with **no**
 *   `onToggle` — the one being edited, and the draft a new goal is typed into —
 *   renders the same chrome with no affordance at all rather than a toggle that
 *   does nothing: there is nothing to collapse while a form is open in it.
 * * **It spells no colour.** Every surface, separator and type colour is
 *   `memberChrome.ts`'s (#983). The two values that are not themed are the
 *   menu's shadow and its backdrop-free depth, which are the overlay's own
 *   elevation rather than a colour a gym configures — the same carve-out
 *   `MemberDialog` makes for its veil.
 * * **Touch first.** The header fills the card's width and the `⋮` is a 44px
 *   square, so §5's "comfortable on a phone" is a size rather than a hope.
 */
export interface MemberGoalCardMenuItem {
  key: string;
  label: string;
  /** A removal, worded and coloured as one. */
  danger?: boolean;
  onSelect: () => void;
}

export function MemberGoalCard({
  title, summary, expanded, onToggle, menu, children, headingId,
}: {
  title: string;
  /** `Target: 70 kg · 65%`, or `null` for a goal that has neither (§1). */
  summary?: string | null;
  expanded: boolean;
  /** Omitted on a card whose body is a form: there is nothing to collapse. */
  onToggle?: () => void;
  /** §4 — the card's contextual menu. Omitted while the card is being edited. */
  menu?: { label: string; items: MemberGoalCardMenuItem[] };
  children?: ReactNode;
  headingId?: string;
}) {
  const heading = (
    <span style={styles.headerText}>
      <span id={headingId} style={styles.title}>{title}</span>
      {summary && <span style={styles.summary}>{summary}</span>}
    </span>
  );

  return (
    <article style={styles.card}>
      <div style={styles.headerRow}>
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
        {menu && <CardMenu label={menu.label} items={menu.items} />}
      </div>

      {expanded && children && <div style={styles.body}>{children}</div>}
    </article>
  );
}

/**
 * The `⋮` and what it opens.
 *
 * It closes on Escape and on a pointer down anywhere outside itself, because a
 * menu left open behind a tap is the one way an overlay this small gets in the
 * way on a phone. It is `position: absolute` inside the card's own header
 * rather than fixed to the viewport: it belongs to the row it was opened from,
 * and a fixed overlay would need a backdrop, which is `MemberDialog`'s job.
 */
function CardMenu({ label, items }: { label: string; items: MemberGoalCardMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapper} style={styles.menuWrapper}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        style={styles.menuButton}
      >
        <span aria-hidden="true">⋮</span>
      </button>

      {open && (
        <div role="menu" style={styles.menu}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); item.onSelect(); }}
              style={{ ...styles.menuItem, ...(item.danger ? styles.menuItemDanger : null) }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  card:        { ...sectionCardStyle, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
  headerRow:   { display: 'flex', alignItems: 'stretch', gap: 4 },
  header:      {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    flex: 1, minWidth: 0,
    // §5 — a compact vertical layout with a comfortable target: the whole
    // header is tappable rather than the caret alone.
    padding: '14px 4px 14px 18px', minHeight: 44,
    background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', font: 'inherit',
    color: 'inherit',
  },
  headerText:  { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
  title:       { fontSize: 16, fontWeight: 700, color: memberTheme.text, overflowWrap: 'anywhere' },
  summary:     { fontSize: 13, color: memberTheme.textSecondary, overflowWrap: 'anywhere' },
  caret:       { fontSize: 12, color: memberTheme.textMuted, flexShrink: 0 },
  menuWrapper: { position: 'relative', flexShrink: 0, display: 'flex', alignItems: 'flex-start' },
  menuButton:  {
    width: 44, height: 44, marginTop: 7, marginRight: 6,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'none', border: 'none', borderRadius: 8,
    color: memberTheme.textMuted, fontSize: 20, lineHeight: 1, cursor: 'pointer',
  },
  menu:        {
    // Below the 44px button and its 7px offset, so it never covers the control
    // that opened it.
    position: 'absolute', top: 54, right: 4, zIndex: 20, minWidth: 180,
    display: 'flex', flexDirection: 'column',
    background: memberTheme.surface,
    border: `1px solid ${memberTheme.separator}`,
    borderRadius: 10,
    // The menu's own elevation, not a theme colour — `MemberDialog` darkens its
    // veil the same way.
    boxShadow: '0 8px 24px rgba(0,0,0,0.14)',
    padding: 4,
  },
  menuItem:    {
    padding: '11px 12px', minHeight: 44,
    background: 'none', border: 'none', borderRadius: 8,
    textAlign: 'left', font: 'inherit', fontSize: 14, cursor: 'pointer',
    color: memberTheme.text,
  },
  menuItemDanger: { color: memberTheme.statusError },
  body:        { padding: '0 18px 16px', marginTop: 2, paddingTop: 12, ...rowDividerStyle },
};
