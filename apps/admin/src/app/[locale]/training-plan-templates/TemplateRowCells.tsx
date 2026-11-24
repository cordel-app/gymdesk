'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu';
import { SourceChip } from '@/components/SourceChip';
import { listCellClasses, type ListGridColumn } from '@/components/listChrome';
import { templateSource, toNumDays } from './trainingPlanTemplateList';

// ─── List columns ─────────────────────────────────────────────────────────────

export interface ListColumn extends ListGridColumn {
  /** Header label, a key in the `training_plan_templates` namespace. Absent = no title. */
  labelKey?: string;
  /** Fixed track width in px — also the minimum for a flexible column. */
  width: number;
  /** Set on a flexible column: it becomes minmax(width, growfr). */
  grow?: number;
}

/**
 * One declaration for both lists (#1011's shape): the Exercises list's columns,
 * with Days in place of Primary Muscles. The template's name is the row's
 * identity and its status the one state worth seeing on a phone; the rest is
 * read in the expanded row or the card.
 */
export const LIST_COLUMNS: ListColumn[] = [
  { key: 'name', labelKey: 'col_name', width: 140, grow: 2, mobile: 'name' },
  { key: 'description', labelKey: 'col_description', width: 160, grow: 3, mobile: 'secondary' },
  { key: 'days', labelKey: 'col_days', width: 60, mobile: 'secondary' },
  { key: 'created_at', labelKey: 'col_created_at', width: 90, mobile: 'secondary' },
  { key: 'created_by', labelKey: 'col_created_by', width: 120, mobile: 'secondary' },
  { key: 'source', labelKey: 'col_source', width: 110, mobile: 'secondary' },
  { key: 'status', labelKey: 'col_status', width: 80, mobile: 'keep' },
  // The chevron is the row's own affordance rather than a value, so it stays.
  { key: 'expand', width: 13, mobile: 'keep' },
  { key: 'actions', width: 32, mobile: 'actions' },
];

export const LIST_COLUMN_GAP = 12;
/** The list's own horizontal inset — a card row. */
export const ROW_PADDING_X = 20;

export const LIST_GRID_COLUMNS = LIST_COLUMNS
  .map((c) => (c.grow ? `minmax(${c.width}px, ${c.grow}fr)` : `${c.width}px`))
  .join(' ');

/** Tracks + gaps + a row's horizontal padding: below this the list scrolls. */
export const LIST_MIN_WIDTH =
  LIST_COLUMNS.reduce((sum, c) => sum + c.width, 0)
  + LIST_COLUMN_GAP * (LIST_COLUMNS.length - 1)
  + ROW_PADDING_X * 2;

/** The mobile class a column's header cell and its row cells share (#1011). */
export const CELL_CLASS = listCellClasses(LIST_COLUMNS);

export interface TemplateRowCellsRow {
  name: string;
  description: string | null;
  status: string;
  num_days?: unknown;
  source?: string | null;
  gym_id?: unknown;
  created_at: string;
  created_by: string | null;
}

/**
 * The cells of one row, in `LIST_COLUMNS` order — shared by the gym list and
 * Cordel's Base list so neither restates a cell. `expanded` is `null` for a
 * row with no expansion (the Base list), which leaves the chevron cell empty.
 */
export function TemplateRowCells({
  template, expanded, menuItems, fmtDate,
}: {
  template: TemplateRowCellsRow;
  expanded: boolean | null;
  menuItems: ContextMenuItem[];
  fmtDate: (iso: string) => string;
}) {
  const t = useTranslations('training_plan_templates');
  const tStatus = useTranslations('status');
  const system = templateSource(template) === 'system';
  return (
    <>
      <span className={CELL_CLASS.name} title={template.name} style={{ fontWeight: 600, fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {template.name}
      </span>
      <span className={CELL_CLASS.description} title={template.description ?? undefined} style={{ fontSize: 13.5, color: '#888', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {template.description || '—'}
      </span>
      <span className={CELL_CLASS.days} style={{ fontSize: 13, color: '#555' }}>
        {toNumDays(template.num_days)}
      </span>
      <span className={CELL_CLASS.created_at} style={{ fontSize: 13, color: '#888' }}>
        {template.created_at ? fmtDate(template.created_at) : '—'}
      </span>
      <span className={CELL_CLASS.created_by} style={{ fontSize: 13, color: '#888', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {template.created_by ?? '—'}
      </span>
      <span className={CELL_CLASS.source}>
        <SourceChip system={system} label={system ? t('source_system') : t('source_custom')} />
      </span>
      <span className={CELL_CLASS.status}>
        <StatusBadge status={template.status} label={tStatus(template.status as any)} />
      </span>
      <span className={CELL_CLASS.expand} style={{ fontSize: 13, color: '#aaa', display: 'inline-block', transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
        {expanded === null ? null : '▾'}
      </span>
      <span className={CELL_CLASS.actions} onClick={(e) => e.stopPropagation()}>
        <ContextMenu ariaLabel={t('col_actions')} items={menuItems} />
      </span>
    </>
  );
}
