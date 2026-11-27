'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { memberTheme, sectionCardStyle } from '@/lib/memberChrome';

/**
 * #3491 — My Nutrition's plan header: the Assigned Nutrition Plan's name and
 * its Member Notes, in a Section Card marked by the Theme's accent (the
 * primary button colour) on its left edge. It decides nothing about the plan
 * and resolves no locale key: the page hands it the name, the notes and the
 * two accessible labels.
 *
 * Notes that fit in two lines are shown whole. Longer ones are clamped to two
 * lines with an ellipsis, and the clamped text is a button that expands them;
 * pressing it again collapses them. No notes means no notes area at all.
 */
export function NutritionPlanHeader({ name, notes, expandLabel, collapseLabel }: {
  name: string;
  notes: string | null | undefined;
  expandLabel: string;
  collapseLabel: string;
}) {
  const text = notes?.trim() ? notes : null;
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  // A new text starts collapsed and is measured again.
  useLayoutEffect(() => { setExpanded(false); }, [text]);

  // Measured while clamped: the notes overflow two lines when the clamped box
  // is shorter than its content. Re-measured when the width changes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <section style={styles.card}>
      <h2 style={styles.name}>{name}</h2>
      {text && (overflows || expanded ? (
        <button type="button" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}
                title={expanded ? collapseLabel : expandLabel} style={styles.toggle}>
          <span ref={ref} style={{ ...styles.notes, ...(expanded ? {} : styles.clamped) }}>{text}</span>
        </button>
      ) : (
        <span ref={ref} style={{ ...styles.notes, ...styles.clamped }}>{text}</span>
      ))}
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    ...sectionCardStyle,
    borderLeftWidth: 4,
    borderLeftStyle: 'solid',
    borderLeftColor: memberTheme.primaryButton,
    padding: '16px 18px',
    marginBottom: 20,
  },
  name: {
    margin: 0, fontSize: 20, fontWeight: 700, lineHeight: 1.25,
    color: memberTheme.title1, fontFamily: memberTheme.title1Font, overflowWrap: 'anywhere',
  },
  notes: {
    display: 'block', margin: '8px 0 0', fontSize: 14, lineHeight: 1.45, color: memberTheme.textSecondary,
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', textAlign: 'left',
  },
  clamped: {
    display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden',
  },
  toggle: {
    display: 'block', width: '100%', padding: 0, margin: 0, background: 'none', border: 'none',
    font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer',
  },
};
