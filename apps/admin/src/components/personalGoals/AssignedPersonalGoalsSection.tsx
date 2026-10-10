'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ContextMenu } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, Column } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';
import { FilterBar, FilterField, filterControlStyle } from '@/components/FilterBar';
import { listNameBadgeStyle } from '@/components/listChrome';
import {
  cardSectionLabelStyle, formFieldLabelStyle, formValueStyle, secondaryBtnSmall,
} from '@/components/formChrome';
import { cardSurfaceStyle, primaryBtnStyle, readOnlyStyle } from '@/components/ui';
import { GOAL_API_ROOTS, GoalListResponse, GoalRow, goalAvailability, goalDisplayName } from '@/components/goalLibrary/goalProfile';
import { AddReadingModal } from './AddReadingModal';
import { AssignedPersonalGoalDetailsModal } from './AssignedPersonalGoalDetailsModal';
import { GoalReadingHeader } from './GoalReadingHeader';
import { GoalReadingChart } from './GoalReadingChart';
import { GoalReadingHistory } from './GoalReadingHistory';
import { GoalReadingsResponse, ReadingKind, formatProgress } from './goalReadings';
import { AssignedPersonalGoalForm, GoalOption, MemberOption } from './AssignedPersonalGoalForm';
import {
  ASSIGNED_GOAL_STATUSES, ASSIGNED_PERSONAL_GOALS_ROOT, AssignedGoalStatus,
  AssignedPersonalGoalFormValues, AssignedPersonalGoalListResponse, AssignedPersonalGoalRow,
  assignedPersonalGoalFormError, emptyAssignedPersonalGoalForm, formatGoalPeriod, formatTarget,
  toAssignedPersonalGoalCreatePayload, toAssignedPersonalGoalFormValues,
  toAssignedPersonalGoalUpdatePayload,
} from './assignedPersonalGoalProfile';

const LIMIT = 20;

/**
 * #948 §4 — **Assigned Personal Goals**: the goals a gym's members actually hold.
 *
 * The interaction model is the one every list in the admin follows: **expanding a
 * row reads and `⋮ → Edit` writes** (#797–#800), the form is inline in the row
 * rather than a modal, `+ Assign Personal Goal` opens that same form body at the
 * top of the list (#805), and `⋮ → Details` carries the audit information plus the
 * View Audit Log link. The chrome is `DataTable` + `FilterBar` + `listChrome`, the
 * same constants the Nutrition Plan Templates list beside it is built from (#724)
 * — the ticket's "do not create a new visual pattern specifically for Assigned
 * Personal Goals" is satisfied by not declaring one here at all.
 *
 * It names no permission: `canWrite` and `readOnlyTitle` are the page's, as is the
 * label resolver (#806/#901). What it does own is the two reads it needs — the
 * assignments and the Personal Goals catalogue the picker offers — because the
 * catalogue is what makes a goal assignable and a page that fetched it separately
 * would be a second copy of that rule.
 */
export function AssignedPersonalGoalsSection({
  canWrite, readOnlyTitle, label, goalLabel, ready = true,
}: {
  canWrite: boolean;
  readOnlyTitle?: string;
  /** Resolves a key in the page's own `assigned_personal_goals` namespace. */
  /** The page's own resolver (#901). `values` interpolates, e.g. `chart_target`. */
  label: (key: string, values?: Record<string, string | number>) => string;
  /** Resolves a key in `goal_library`, where a System goal's label was written. */
  goalLabel: (key: string) => string;
  ready?: boolean;
}) {
  const locale = useLocale();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [rows, setRows] = useState<AssignedPersonalGoalRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | AssignedGoalStatus>('');
  const [memberFilter, setMemberFilter] = useState('');

  const [members, setMembers] = useState<MemberOption[]>([]);
  const [goals, setGoals] = useState<GoalRow[]>([]);

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [detailRow, setDetailRow] = useState<AssignedPersonalGoalRow | null>(null);
  const [deleting, setDeleting] = useState<AssignedPersonalGoalRow | null>(null);

  // #1037 — one assignment's reading history, loaded when its row is expanded and
  // kept per row, so collapsing and re-expanding costs nothing. The five header
  // fields are already on the row (they are derived on every read), so this read
  // is only for the history list.
  const [readings, setReadings] = useState<Record<number, GoalReadingsResponse>>({});
  const [reading, setReading] = useState<{ row: AssignedPersonalGoalRow; kind: ReadingKind } | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<AssignedPersonalGoalFormValues>(emptyAssignedPersonalGoalForm());
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  const [creating, setCreating] = useState(false);
  const [newForm, setNewForm] = useState<AssignedPersonalGoalFormValues>(emptyAssignedPersonalGoalForm());
  const [newError, setNewError] = useState<string | null>(null);
  const [newSaving, setNewSaving] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  useEffect(() => { setOffset(0); }, [search, statusFilter, memberFilter]);

  const load = useCallback(async () => {
    if (!ready) { setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      if (memberFilter) params.set('member_id', memberFilter);
      params.set('limit', String(LIMIT));
      params.set('offset', String(offset));
      const data = await apiFetch<AssignedPersonalGoalListResponse>(
        `${ASSIGNED_PERSONAL_GOALS_ROOT}?${params.toString()}`,
      );
      setRows(data.items);
      setTotal(data.total);
    } catch (err: any) {
      toast(err.message ?? label('error_generic'));
    } finally { setLoading(false); }
    // `label` and `toast` are deliberately not dependencies: the page hands the
    // label resolver as an inline arrow, so a new identity on every render would
    // make this effect re-run, set state and re-render for ever — the exclusion
    // `GoalLibrarySection` makes for the same reason.
  }, [apiFetch, ready, search, statusFilter, memberFilter, offset]);

  useEffect(() => { load(); }, [load]);

  const loadReadings = useCallback(async (id: number) => {
    try {
      const data = await apiFetch<GoalReadingsResponse>(`${ASSIGNED_PERSONAL_GOALS_ROOT}/${id}/readings`);
      setReadings((prev) => ({ ...prev, [id]: data }));
    } catch {
      // A failed history read leaves the card's own figures standing: they are
      // the row's, and an empty accordion is better than an error over a card
      // that is otherwise correct.
    }
  }, [apiFetch]);

  // The two catalogues the pickers and the filters offer. Read once: neither
  // changes while this screen is open, and the assignment list is what moves.
  useEffect(() => {
    if (!ready) return;
    apiFetch<MemberOption[]>('/members').then(setMembers).catch(() => {});
    apiFetch<GoalListResponse>(`${GOAL_API_ROOTS.gym.personal}?limit=200`)
      // #1181 — a goal the gym deactivated is not offered for a new assignment
      // (the server refuses it either way); the picker lists what it may pick.
      .then((data) => setGoals(data.items.filter((goal) => goalAvailability(goal) === 'active')))
      .catch(() => {});
  }, [apiFetch, ready]);

  /** A goal's label: a System slug's locale key, else the stored name (#947). */
  const nameOfGoal = useCallback(
    (row: Pick<AssignedPersonalGoalRow, 'goal_slug' | 'goal_name'>) =>
      goalDisplayName({ slug: row.goal_slug, name: row.goal_name }, 'personal', goalLabel),
    [goalLabel],
  );

  const goalOptions: GoalOption[] = useMemo(
    () => goals
      .map((g) => ({
        id: g.id,
        name: goalDisplayName(g, 'personal', goalLabel),
        gym_id: g.gym_id,
        // #1034: the catalogue's own target, so the picker pre-fills it.
        target_value: g.target_value ?? null,
        target_unit: g.target_unit ?? null,
        target_type: g.target_type ?? 'absolute',
      }))
      .sort((a, b) => a.name.localeCompare(b.name, locale)),
    [goals, goalLabel, locale],
  );

  function toggleExpand(id: number) {
    if (editingId === id) return; // never collapse the row being edited
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else { next.add(id); if (!readings[id]) loadReadings(id); }
      return next;
    });
  }

  function openInlineNew() {
    setNewForm(emptyAssignedPersonalGoalForm(memberFilter ? Number(memberFilter) : undefined));
    setNewError(null);
    setCreating(true);
  }

  async function saveInlineNew() {
    const invalid = assignedPersonalGoalFormError(newForm);
    if (invalid) { setNewError(label(invalid)); return; }
    setNewSaving(true); setNewError(null);
    try {
      await apiFetch(ASSIGNED_PERSONAL_GOALS_ROOT, {
        method: 'POST',
        body: JSON.stringify(toAssignedPersonalGoalCreatePayload(newForm)),
      });
      setCreating(false);
      load();
    } catch (e: any) {
      // The form stays open with the user's input intact (#800).
      setNewError(e.message ?? label('error_generic'));
    } finally { setNewSaving(false); }
  }

  function openInlineEdit(row: AssignedPersonalGoalRow) {
    setEditingId(row.id);
    setEditForm(toAssignedPersonalGoalFormValues(row));
    setEditError(null);
    // `⋮ → Edit` expands the row it opens, so Cancel reveals the read-only view
    // rather than collapsing the row (#797).
    setExpanded((prev) => new Set(prev).add(row.id));
  }

  async function saveInlineEdit(row: AssignedPersonalGoalRow) {
    const invalid = assignedPersonalGoalFormError(editForm);
    if (invalid) { setEditError(label(invalid)); return; }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`${ASSIGNED_PERSONAL_GOALS_ROOT}/${row.id}`, {
        method: 'PUT',
        body: JSON.stringify(toAssignedPersonalGoalUpdatePayload(editForm)),
      });
      setEditingId(null);
      load();
    } catch (e: any) {
      setEditError(e.message ?? label('error_generic'));
    } finally { setEditSaving(false); }
  }

  /**
   * `⋮ → Add reading` expands the row it was launched from, so the header, the
   * history and the figure that just changed are all on screen when the dialog
   * closes — the same reason `⋮ → Edit` expands its row (#797).
   */
  function openReading(row: AssignedPersonalGoalRow, kind: ReadingKind) {
    setExpanded((prev) => new Set(prev).add(row.id));
    setReading({ row, kind });
  }

  /**
   * §30 — a saved reading updates the header and the history with no manual
   * refresh: the list read re-derives the five fields and the history read
   * re-lists the rows.
   */
  async function readingSaved(id: number) {
    setReading(null);
    await Promise.all([load(), loadReadings(id)]);
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`${ASSIGNED_PERSONAL_GOALS_ROOT}/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      load();
    } catch (e: any) {
      toast(e.message ?? label('error_generic'));
      setDeleting(null);
    }
  }

  /**
   * The chart's three strings. Resolved here rather than in the chart, which
   * knows no locale key (#901), and the target is interpolated **before** it is
   * handed over: next-intl prints a missing key verbatim, so a label composed
   * from two calls would be the one place a `t()` fallback could hide.
   */
  function chartLabels(row: AssignedPersonalGoalRow) {
    return {
      title: label('section_progress_chart'),
      ariaLabel: label('chart_aria_label'),
      // An assignment with no target gets an unlabelled chart rather than a
      // line captioned `Target —`: the reference line is not drawn either.
      target: row.target_value === null
        ? null
        : label('chart_target', { value: formatTarget(row) }),
    };
  }

  /**
   * The expanded row: #1037 §5's structured header first, then the assignment's
   * own remaining fields, then §13's progress chart and §18's reading history.
   *
   * The order is §12's — header, chart, history — and the body holds
   * **no control**: Add reading and Change initial reading are `⋮` items, because
   * expanding a row reads and the menu is the single entry point into a write
   * (#797). The history's own caret is presentation, not a write (#955).
   */
  function renderReadOnly(row: AssignedPersonalGoalRow) {
    return (
      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <GoalReadingHeader
          goalName={nameOfGoal(row)}
          target={formatTarget(row)}
          unit={row.target_unit}
          summary={row}
          label={label}
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          <ReadOnlyField label={label('label_member')} value={row.member_name} />
          <ReadOnlyField label={label('label_period')} value={formatGoalPeriod(row, locale)} />
          <ReadOnlyField label={label('label_status')} value={label(`status_${row.status}`)} />
          <div style={{ gridColumn: '1 / -1' }}>
            <ReadOnlyField label={label('label_notes')} value={row.notes ?? '—'} wrap />
          </div>
        </div>
        {/* §12 — header, chart, history, in that order. */}
        <GoalReadingChart
          readings={readings[row.id]?.readings ?? []}
          unit={row.target_unit}
          target={row.effective_target}
          locale={locale}
          labels={chartLabels(row)}
        />
        <GoalReadingHistory
          readings={readings[row.id]?.readings ?? []}
          unit={row.target_unit}
          locale={locale}
          label={label}
        />
      </div>
    );
  }

  const columns: Column<AssignedPersonalGoalRow>[] = [
    {
      // #1011: the Member identifies the row; the goal itself is read in the
      // expanded body, which is where every other hidden column is read too.
      header: label('col_member'),
      mobile: 'name',
      title: (row) => row.member_name,
      render: (row) => <strong>{row.member_name}</strong>,
    },
    {
      header: label('col_goal'),
      mobile: 'secondary',
      render: (row) => (
        <span>
          {nameOfGoal(row)}
          {/* The quiet pill every list uses for "what kind of row is this" (#724). */}
          {row.goal_gym_id === null && <span style={listNameBadgeStyle}>{label('ownership_system')}</span>}
        </span>
      ),
    },
    { header: label('col_target'), width: 140, mobile: 'secondary', render: (row) => <span style={cellStyle}>{formatTarget(row)}</span> },
    {
      // #1037 §11 — the figure the ticket's own header leads with, reported by
      // the server and never computed here. `—` for an assignment with no
      // readings or no target, which is not the same fact as `0%`.
      header: label('col_progress'),
      width: 110,
      mobile: 'secondary',
      render: (row) => <span style={cellStyle}>{formatProgress(row.progress_percent)}</span>,
    },
    {
      header: label('col_period'),
      width: 220,
      mobile: 'secondary',
      render: (row) => <span style={cellStyle}>{formatGoalPeriod(row, locale)}</span>,
    },
    {
      header: label('col_status'),
      width: 140,
      mobile: 'keep',
      render: (row) => <StatusBadge status={row.status} label={label(`status_${row.status}`)} />,
    },
    {
      header: '',
      width: 40,
      mobile: 'actions',
      render: (row) => (
        <ContextMenu items={[
          { label: label('edit'), onClick: () => openInlineEdit(row), disabled: !canWrite, title: readOnlyTitle },
          // #1037 §3/§21 — two writers, two items: a measurement, and a new
          // baseline every later percentage is computed from. Neither is a flag
          // on the other, and both are gated like any write action.
          { label: label('add_reading'), onClick: () => openReading(row, 'reading'), disabled: !canWrite, title: readOnlyTitle },
          { label: label('set_initial_reading'), onClick: () => openReading(row, 'initial'), disabled: !canWrite, title: readOnlyTitle },
          { label: label('unassign'), onClick: () => setDeleting(row), disabled: !canWrite, title: readOnlyTitle, danger: true },
          // Details is always last (#802's rule for a page that fixes its order).
          { label: label('details'), onClick: () => setDetailRow(row) },
        ]} />
      ),
    },
  ];

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + LIMIT, total);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <FilterBar>
          <FilterField label={label('search')}>
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={label('search_placeholder')}
              style={{ ...filterControlStyle, minWidth: 200 }}
            />
          </FilterField>
          <FilterField label={label('col_member')}>
            <select value={memberFilter} onChange={(e) => setMemberFilter(e.target.value)} style={filterControlStyle}>
              <option value="">{label('filter_all_members')}</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </FilterField>
          <FilterField label={label('col_status')}>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as '' | AssignedGoalStatus)}
              style={filterControlStyle}
            >
              <option value="">{label('filter_all_statuses')}</option>
              {ASSIGNED_GOAL_STATUSES.map((s) => <option key={s} value={s}>{label(`status_${s}`)}</option>)}
            </select>
          </FilterField>
        </FilterBar>
        <button
          type="button"
          style={{ ...readOnlyStyle(primaryBtnStyle(), !canWrite), marginBottom: 16 }}
          onClick={openInlineNew}
          disabled={!canWrite || creating}
          title={readOnlyTitle}
        >
          {label('assign')}
        </button>
      </div>

      {creating && (
        <div style={{ ...cardSurfaceStyle, overflow: 'hidden', marginBottom: 12 }}>
          <p style={{ ...cardSectionLabelStyle, padding: '12px 20px 0' }}>{label('assign')}</p>
          <AssignedPersonalGoalForm
            mode="create"
            form={newForm}
            goals={goalOptions}
            members={members}
            error={newError}
            saving={newSaving}
            label={label}
            onChange={setNewForm}
            onCancel={() => { setCreating(false); setNewError(null); }}
            onSave={saveInlineNew}
            saveLabel={label('create')}
          />
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={loading}
        loadingText={label('loading')}
        emptyText={label('empty')}
        renderExpanded={(row) => (
          editingId === row.id
            ? (
              <AssignedPersonalGoalForm
                mode="edit"
                form={editForm}
                goals={goalOptions}
                memberName={row.member_name}
                goalName={nameOfGoal(row)}
                error={editError}
                saving={editSaving}
                label={label}
                onChange={setEditForm}
                onCancel={() => { setEditingId(null); setEditError(null); }}
                onSave={() => saveInlineEdit(row)}
                saveLabel={label('save')}
              />
            )
            : renderReadOnly(row)
        )}
        expandedRowKeys={new Set([...expanded, ...(editingId !== null ? [editingId] : [])])}
        onToggleExpand={(row) => toggleExpand(row.id)}
      />

      {total > 0 && (
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, color: 'var(--gd-text-muted, #666)' }}>{pageStart}–{pageEnd} / {total}</span>
          <button type="button" onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0} style={secondaryBtnSmall}>‹</button>
          <button type="button" onClick={() => setOffset(offset + LIMIT)} disabled={pageEnd >= total} style={secondaryBtnSmall}>›</button>
        </div>
      )}

      {detailRow && (
        <AssignedPersonalGoalDetailsModal
          row={detailRow}
          goalName={nameOfGoal(detailRow)}
          label={label}
          onClose={() => setDetailRow(null)}
        />
      )}

      {reading && (
        <AddReadingModal
          assignmentId={reading.row.id}
          kind={reading.kind}
          goalName={nameOfGoal(reading.row)}
          unit={reading.row.target_unit}
          label={label}
          onClose={() => setReading(null)}
          onSaved={() => readingSaved(reading.row.id)}
        />
      )}

      {deleting && (
        <ConfirmDialog
          open
          message={label('unassign_confirm')}
          confirmLabel={label('unassign')}
          cancelLabel={label('cancel')}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function ReadOnlyField({ label: fieldLabel, value, wrap }: { label: string; value: string; wrap?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={formFieldLabelStyle}>{fieldLabel}</span>
      {/* `formValueStyle` carries the control's padding and border width, so a
          value sits exactly where its input does when `⋮ → Edit` opens (#929). */}
      <span style={{ ...formValueStyle, ...(wrap ? { whiteSpace: 'pre-wrap' } : {}) }}>{value}</span>
    </div>
  );
}

const cellStyle: React.CSSProperties = { fontSize: 13 };
