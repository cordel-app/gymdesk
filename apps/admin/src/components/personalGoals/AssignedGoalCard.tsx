'use client';

import React from 'react';
import { StatusBadge } from '@/components/StatusBadge';
import { innerCardStyle } from '@/components/formChrome';

/**
 * #2133 item 4 — the one **collapsible card** an Assigned Personal Goal is drawn
 * as, on both screens that administer an assignment (#806): the gym-wide Assigned
 * Personal Goals section and the Member card's PERSONAL GOALS section.
 *
 * It is presentation only. The title, the summary line and the status are already
 * resolved by the caller, and so is the body (the reading header, chart and
 * history stay `GoalReadingHeader` / `GoalReadingChart` / `GoalReadingHistory`).
 * Expanding fetches nothing (#955) — the caller decides what loads and when.
 *
 * The header toggle and the `actions` slot are **siblings**, not nested: tapping
 * the `⋮` must neither expand nor collapse the card, and a button inside a button
 * is invalid HTML (the Members App's `MemberGoalCard` draws the same shape, #1115).
 * The card declares no colour: surface and badge come from the shared chrome.
 */
export function AssignedGoalCard({
  title, subtitle, summary, status, statusLabel, open, onToggle, actions, children,
}: {
  title: string;
  /** e.g. the Member's name on the gym-wide list; omitted on the Member card. */
  subtitle?: string;
  /** One already-formatted line: target and progress. */
  summary: string;
  status: string;
  statusLabel: string;
  open: boolean;
  onToggle: () => void;
  /** The row's `⋮` menu, when the caller has one. */
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ ...innerCardStyle, padding: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px' }}>
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          style={toggleStyle}
        >
          <span aria-hidden style={{ width: 14, flexShrink: 0 }}>{open ? '▾' : '▸'}</span>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
            <strong style={ellipsis}>{title}{subtitle ? ` · ${subtitle}` : ''}</strong>
            <span style={{ ...ellipsis, fontSize: 12.5, opacity: 0.75 }}>{summary}</span>
          </span>
          <StatusBadge status={status} label={statusLabel} />
        </button>
        {actions}
      </div>
      {open && (
        <div style={{ padding: '0 14px 12px', borderTop: '1px solid var(--gd-card-border, #e2e2e6)' }}>
          <div style={{ paddingTop: 10 }}>{children}</div>
        </div>
      )}
    </div>
  );
}

const toggleStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0,
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  textAlign: 'left', font: 'inherit', color: 'inherit',
};

const ellipsis: React.CSSProperties = {
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
