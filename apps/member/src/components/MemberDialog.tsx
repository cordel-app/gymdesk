'use client';

import type { CSSProperties, ReactNode } from 'react';
import { memberTheme } from '@/lib/memberChrome';

/**
 * #1036 §19 — the Members App's dialog.
 *
 * The app already had this shape: the Calendar's event panel and the
 * impersonation dialog both render a dimmed backdrop with a sheet over it, and
 * each had drawn it for itself. My Goals needs two of them (`Add goal` / `Edit`
 * and the `Remove goal?` confirmation), and a third and fourth hand-drawn copy
 * is exactly the "custom one-off styling" §19 rules out — so the shape lives
 * here once and takes its surface, its text and its separator from
 * `lib/memberChrome.ts` like every other Members App surface (#983). It spells
 * no colour of its own; the two values that are not themed are the backdrop
 * veil and the sheet's shadow, which are the modal's own depth rather than a
 * colour a gym configures, exactly as the Calendar panel treats them.
 *
 * It is a **bottom sheet on a phone and a centred card above it** through one
 * rule rather than two components: `alignItems: center` with the sheet capped
 * at `480px` and its own margin, which on a narrow viewport fills the width and
 * on a wide one sits in the middle. §20's "no unusable mobile modals" is why
 * the body scrolls rather than the page, and why the sheet is bounded to the
 * viewport (`maxHeight: 85vh`).
 *
 * It decides nothing else: the title, the body and the actions are the
 * caller's, so a page's buttons keep their own labels, gates and handlers.
 */
export function MemberDialog({
  title, onClose, children, actions, labelledBy,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
  labelledBy: string;
}) {
  return (
    <div
      style={styles.backdrop}
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        style={styles.sheet}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={labelledBy} style={styles.title}>{title}</h2>
        <div style={styles.body}>{children}</div>
        <div style={styles.actions}>{actions}</div>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 60,
    // The veil, not a theme colour: it is the depth between the sheet and the
    // page, and the Calendar's own panel darkens it the same way.
    background: 'rgba(0,0,0,0.4)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16,
  },
  sheet: {
    width: '100%', maxWidth: 480, maxHeight: '85vh', overflowY: 'auto',
    background: memberTheme.surface,
    borderRadius: 16,
    padding: '20px 18px',
    boxShadow: '0 8px 30px rgba(0,0,0,0.18)',
  },
  title: { margin: '0 0 14px', fontSize: 17, fontWeight: 700, color: memberTheme.title2 },
  body: { display: 'flex', flexDirection: 'column', gap: 12 },
  actions: {
    display: 'flex', gap: 10, marginTop: 18,
    borderTop: `1px solid ${memberTheme.separator}`, paddingTop: 14,
  },
};
