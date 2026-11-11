'use client';

import React from 'react';
import { StatusBadge } from '@/components/StatusBadge';
import { innerCardStyle } from '@/components/formChrome';
import { MemberAvatar } from '@/components/MemberAvatar';
import {
  LIST_GRID_ROW_CLASS, LIST_NAME_VALUE_CLASS, ListGridColumn, listCellClasses,
  listHeaderCellStyle, listHeaderRowStyle,
} from '@/components/listChrome';

/**
 * #2667 — the columns of the gym-wide Assigned Personal Goals list, declared
 * once so the header band and every card's collapsed row share one grid and
 * cannot drift out of line. What each one is on a phone is `listChrome`'s
 * vocabulary (#1011): the rows expand, so the secondary columns collapse and
 * are read in the expanded card instead, while the goal and its status stay.
 */
export const ASSIGNED_GOAL_LIST_COLUMNS = [
  { key: 'goal', labelKey: 'col_goal', mobile: 'name' },
  { key: 'member', labelKey: 'col_member', mobile: 'secondary' },
  { key: 'target', labelKey: 'col_target', mobile: 'secondary' },
  { key: 'progress', labelKey: 'col_progress', mobile: 'secondary' },
  { key: 'status', labelKey: 'col_status', mobile: 'keep' },
] as const satisfies readonly (ListGridColumn & { labelKey: string })[];

export type AssignedGoalColumnKey = typeof ASSIGNED_GOAL_LIST_COLUMNS[number]['key'];

/** The tracks both the header band and a card's row are laid out on. */
const GRID_TEMPLATE = 'minmax(0, 2fr) minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 0.8fr) 130px';
const GRID_GAP = 12;
/** The `⋮` slot's width, reserved on the header too so the last column lines up. */
const ACTIONS_WIDTH = 32;
/** The chevron's width, reserved on the header for the same reason. */
const CHEVRON_WIDTH = 14;
const CELL_CLASS = listCellClasses(ASSIGNED_GOAL_LIST_COLUMNS);

const gridStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: GRID_TEMPLATE, columnGap: GRID_GAP,
  alignItems: 'center', flex: 1, minWidth: 0,
};

/**
 * The header band above the cards: the same chevron and `⋮` slots as a card's
 * collapsed row, then the column titles on the same grid. The titles are the
 * page's (#901): `label` resolves each column's key in its namespace.
 */
export function AssignedGoalListHeader({ label }: { label: (key: string) => string }) {
  return (
    <div
      style={{
        ...listHeaderRowStyle, borderRadius: 8, marginBottom: 8,
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
      }}
    >
      <span aria-hidden style={{ width: CHEVRON_WIDTH, flexShrink: 0 }} />
      <div className={LIST_GRID_ROW_CLASS} style={gridStyle}>
        {ASSIGNED_GOAL_LIST_COLUMNS.map((c) => (
          <span key={c.key} className={CELL_CLASS[c.key]} style={{ ...listHeaderCellStyle, padding: 0, ...ellipsisInline }}>
            {label(c.labelKey)}
          </span>
        ))}
      </div>
      <span aria-hidden style={{ width: ACTIONS_WIDTH, flexShrink: 0 }} />
    </div>
  );
}

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
  title, imageUrl, subtitle, summary, status, statusLabel, open, onToggle, actions, children, cells,
}: {
  title: string;
  /** The goal's thumbnail (#2152); with none, nothing is drawn — no placeholder. */
  imageUrl?: string | null;
  /** e.g. the Member's name on the gym-wide list; omitted on the Member card. */
  subtitle?: string;
  /** One already-formatted line: target and progress. */
  summary: string;
  /** Header badge; omitted where the status is shown elsewhere (Member card, #2564). */
  status?: string;
  statusLabel?: string;
  open: boolean;
  onToggle: () => void;
  /** The row's `⋮` menu, when the caller has one. */
  actions?: React.ReactNode;
  children?: React.ReactNode;
  /**
   * #2667 — the gym-wide list's collapsed row, one value per
   * `ASSIGNED_GOAL_LIST_COLUMNS` column, aligned under `AssignedGoalListHeader`.
   * When given it replaces the title / summary / badge layout; the Member card,
   * which has no header band, keeps that layout.
   */
  cells?: Record<AssignedGoalColumnKey, React.ReactNode>;
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
          <span aria-hidden style={{ width: CHEVRON_WIDTH, flexShrink: 0 }}>{open ? '▾' : '▸'}</span>
          {cells ? (
            <span className={LIST_GRID_ROW_CLASS} style={gridStyle}>
              <span className={CELL_CLASS.goal} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                {imageUrl && <MemberAvatar name={title} imageUrl={imageUrl} size={36} />}
                <strong className={LIST_NAME_VALUE_CLASS} style={ellipsis} title={title}>{cells.goal}</strong>
              </span>
              {ASSIGNED_GOAL_LIST_COLUMNS.filter((c) => c.key !== 'goal').map((c) => (
                <span key={c.key} className={CELL_CLASS[c.key]} style={{ ...ellipsis, minWidth: 0 }}>
                  {cells[c.key]}
                </span>
              ))}
            </span>
          ) : (
            <>
              {imageUrl && <MemberAvatar name={title} imageUrl={imageUrl} size={36} />}
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                <strong style={ellipsis}>{title}{subtitle ? ` · ${subtitle}` : ''}</strong>
                <span style={{ ...ellipsis, fontSize: 12.5, opacity: 0.75 }}>{summary}</span>
              </span>
              {status && statusLabel && <StatusBadge status={status} label={statusLabel} />}
            </>
          )}
        </button>
        {cells
          ? <span style={{ width: ACTIONS_WIDTH, flexShrink: 0, display: 'flex', justifyContent: 'flex-end' }}>{actions}</span>
          : actions}
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

const ellipsisInline: React.CSSProperties = { ...ellipsis, minWidth: 0 };
