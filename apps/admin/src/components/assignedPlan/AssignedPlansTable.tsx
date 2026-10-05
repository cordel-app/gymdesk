'use client';

/**
 * #1051 — one Assigned Plans list, rendered by every screen that shows
 * Assigned Plans.
 *
 * The Assigned Plans page (`financials/assigned-plans`) declared its columns,
 * its `DataTable` and its expansion inline, and the Member card drew the same
 * assignments a second way: a stack of metadata cards with `CardDetailRow`s and
 * its own `▸/▾` toggle. Two renderings of one entity is exactly what the ticket
 * removes — *"There should be one source of truth for the Assigned Plans UI so
 * future changes remain consistent across the application"* — so the table, its
 * columns, its chevron, its status presentation and the body it expands into
 * live here and both screens render this component.
 *
 * Three of its properties are the rule rather than the implementation:
 *
 *  * **The scope decides which column is the row's identity, and nothing else.**
 *    `gym` is the Assigned Plans page: it lists every member's assignments, so
 *    the Member names the row (#1011's `mobile: 'name'`) and the Plan is a
 *    secondary column — unchanged, byte for byte, from what that page declared.
 *    `member` is a list already scoped to one person, where repeating their name
 *    on every row identifies nothing and would leave a phone showing that name
 *    twice with the Plan hidden behind it, so the **Plan** names the row. Every
 *    other column, its header, its formatting and its order are the same.
 *  * **The actions are the caller's, not the table's.** `rowActions` is how a
 *    screen puts its own `⋮` on a row; the Assigned Plans page passes none, so
 *    it keeps the menu it already has — the one inside the expanded body —
 *    and the Member card keeps the three member-level actions its cards carried
 *    (`Assign New Plan` · `Cancel Plan` · `Details`).
 *  * **`embedded` is still #958's answer.** Expanding a plan on the Member card
 *    reads it; editing an assignment stays on the Assigned Plans page, where
 *    its own card lives, because `⋮ → Edit` is the single entry point into an
 *    Edit mode (#797). The flag is passed straight through to
 *    `AssignedPlanExpandedRow`, which is the one place that decides what it
 *    means.
 *
 * The column headers are the `assigned_plans_page` namespace on both screens,
 * per the ticket's *"the exact section naming should follow the terminology
 * already used by the Financials UI"* — a Member-card copy of them would be the
 * second place deciding what a column is called.
 */

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu';
import { DataTable, type Column } from '@/components/DataTable';
import { AssignedPlanExpandedRow } from '@/components/assignedPlan/AssignedPlanExpandedRow';

/** Which list this is, and therefore which column identifies a row. */
export type AssignedPlansScope = 'gym' | 'member';

/**
 * One row of the list. `member_name`/`member_nif_nie_passport` are read by the
 * `gym` scope alone, which is why they are optional: a member-scoped payload
 * has no reason to repeat the person the page is already about.
 */
export interface AssignedPlanTableRow {
  id: number;
  plan_name: string | null;
  starts_at: string | null;
  ends_at: string | null;
  /**
   * The date-aware projection of the stored `status`, decided once in SQL
   * (`LIFECYCLE_STATUS_SQL`, api/src/api/user-memberships.ts) so a future-dated
   * assignment cannot read `Pending` on one screen and `Active` on another.
   */
  lifecycle_status: string;
  member_name?: string | null;
  member_nif_nie_passport?: string | null;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

interface Props<T extends AssignedPlanTableRow> {
  rows: T[];
  loading?: boolean;
  loadingText: string;
  emptyText: string;
  /** Re-read the list after the expanded body changed the assignment. */
  onChanged: () => void;
  scope?: AssignedPlansScope;
  /** #958: a body expanded somewhere other than the plan's own card reads only. */
  embedded?: boolean;
  /** The `⋮` this screen puts on a row, if any. */
  rowActions?: (row: T) => ContextMenuItem[];
}

export function AssignedPlansTable<T extends AssignedPlanTableRow>({
  rows, loading, loadingText, emptyText, onChanged,
  scope = 'gym', embedded = false, rowActions,
}: Props<T>) {
  const t = useTranslations('assigned_plans_page');
  const tStatus = useTranslations('status');
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  function toggleExpand(row: T) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
      return next;
    });
  }

  const planCell = (row: T) => <span style={{ color: '#6b7280' }}>{row.plan_name ?? '—'}</span>;
  const startsCell = (row: T) => (
    <span style={{ whiteSpace: 'nowrap' }}>{row.starts_at ? fmtDate(row.starts_at) : '—'}</span>
  );
  const endsCell = (row: T) => (
    <span style={{ whiteSpace: 'nowrap' }}>
      {row.ends_at ? fmtDate(row.ends_at) : t('open_ended')}
    </span>
  );
  const statusCell = (row: T) => (
    <StatusBadge status={row.lifecycle_status} label={tStatus(row.lifecycle_status as never)} />
  );
  const actionsCell = (row: T) => (
    <ContextMenu
      ariaLabel={t('actions_for', { plan: row.plan_name ?? '' })}
      items={rowActions ? rowActions(row) : []}
    />
  );

  // Two complete declarations rather than one built conditionally: #1011's gate
  // reads the literal array, and exactly one column of it may say
  // `mobile: 'name'`.
  const gymColumns: Column<T>[] = [
    {
      // #1011: the Member identifies the row on a list of every member's plans.
      header: t('col_member'),
      mobile: 'name',
      title: (row) => row.member_name ?? undefined,
      render: (row) => (
        <>
          <div style={{ fontWeight: 500 }}>{row.member_name ?? '—'}</div>
          <div style={{ fontWeight: 400, fontSize: 12, color: '#6b7280' }}>
            {t('label_document')}: {row.member_nif_nie_passport || '—'}
          </div>
        </>
      ),
    },
    { header: t('col_plan'), mobile: 'secondary', render: planCell },
    { header: t('col_starts_at'), mobile: 'secondary', render: startsCell },
    { header: t('col_ends_at'), mobile: 'secondary', render: endsCell },
    { header: t('col_status'), mobile: 'keep', render: statusCell },
  ];

  const memberColumns: Column<T>[] = [
    {
      // Scoped to one Member already, so the Plan is what tells two rows apart.
      header: t('col_plan'),
      mobile: 'name',
      title: (row) => row.plan_name ?? undefined,
      render: (row) => <div style={{ fontWeight: 500 }}>{row.plan_name ?? '—'}</div>,
    },
    { header: t('col_starts_at'), mobile: 'secondary', render: startsCell },
    { header: t('col_ends_at'), mobile: 'secondary', render: endsCell },
    { header: t('col_status'), mobile: 'keep', render: statusCell },
    { header: '', mobile: 'actions', render: actionsCell },
  ];

  return (
    <DataTable
      columns={scope === 'member' ? memberColumns : gymColumns}
      rows={rows}
      rowKey={(row) => row.id}
      loading={loading}
      loadingText={loadingText}
      emptyText={emptyText}
      expandedRowKeys={expandedIds}
      onToggleExpand={toggleExpand}
      renderExpanded={(row) => (
        <AssignedPlanExpandedRow assignedPlanId={row.id} onChanged={onChanged} embedded={embedded} />
      )}
    />
  );
}
