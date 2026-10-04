'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ContextMenu } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, Column } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';
import { FilterBar, FilterField, filterControlStyle } from '@/components/FilterBar';
import { listNameBadgeStyle } from '@/components/listChrome';
import {
  cardSectionLabelStyle, formControlStyle, formErrorStyle, formFieldLabelStyle, formValueStyle,
  inlineActionsRowStyle, secondaryBtnSmall,
} from '@/components/formChrome';
import { cardSurfaceStyle, primaryBtnSmall, primaryBtnStyle, readOnlyStyle } from '@/components/ui';
import { displayValue } from '@/components/nutritionLibrary/nutritionItemProfile';
import { GoalDetailsModal } from './GoalDetailsModal';
import {
  GOAL_API_ROOTS, GoalFormValues, GoalKind, GoalListResponse, GoalRow, GoalScope,
  emptyGoalForm, goalDisplayName, isSystemGoal, toGoalFormValues, toGoalPayload,
} from './goalProfile';

const LIMIT = 20;

/**
 * #947 §3/§4/§6 — one tab of the Nutrition Library's two goal catalogues:
 * its own search, its own list, its own `+ Add` and its own row actions.
 *
 * **One section component for four screens** (two kinds × two libraries), the way
 * one Exercise editor serves a gym's page and the platform's (#806): the kind
 * decides the locale keys and the audit entity type, the scope decides the API
 * root, and nothing here knows an endpoint or decides a permission — `basePath`,
 * `canWrite` and `readOnlyTitle` are the page's (`GOAL_API_ROOTS` is the one place
 * the four roots are written down).
 *
 * The interaction model is the library's, unchanged: **expanding a row reads and
 * `⋮ → Edit` writes** (#797–#800), the inline form is in the row rather than a
 * modal, creation opens the same form body at the top of the list (#805), and
 * `⋮ → Details` carries the audit information plus the View Audit Log link.
 *
 * A **System** row (`gym_id IS NULL`) is read-only in a gym's library — it is
 * administered from Cordel — so it offers Details and nothing else there. On the
 * platform side every row is a System row and every one of them is editable.
 */
export function GoalLibrarySection({ kind, scope, canWrite, readOnlyTitle, label, ready = true }: {
  kind: GoalKind;
  scope: GoalScope;
  canWrite: boolean;
  readOnlyTitle?: string;
  /** Resolves a key in the calling page's own namespace (#901). */
  label: (key: string) => string;
  /** False while the page still has no gym context to read with. */
  ready?: boolean;
}) {
  const basePath = GOAL_API_ROOTS[scope][kind];
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [detailGoal, setDetailGoal] = useState<GoalRow | null>(null);
  const [deleting, setDeleting] = useState<GoalRow | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<GoalFormValues>(emptyGoalForm());
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [newForm, setNewForm] = useState<GoalFormValues>(emptyGoalForm());
  const [newSaving, setNewSaving] = useState(false);
  const [newError, setNewError] = useState<string | null>(null);
  const newNameRef = useRef<HTMLInputElement>(null);

  /** The label of a goal — a System slug's locale key, else the stored name. */
  const nameOf = useCallback((goal: GoalRow) => goalDisplayName(goal, kind, label), [kind, label]);

  /**
   * The three labels that name the catalogue rather than the action — the `+ Add`
   * button (§7), the empty state and the delete confirmation — are keyed per kind
   * in the same namespace, so "Add Personal Goal" and "Add Nutrition Goal" are two
   * sentences a translator writes rather than one with a noun interpolated into it.
   */
  const kindLabel = useCallback((key: string) => label(`${kind}_${key}`), [kind, label]);

  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  useEffect(() => { setOffset(0); }, [search]);

  const load = useCallback(async () => {
    if (!ready) { setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      params.set('limit', String(LIMIT));
      params.set('offset', String(offset));
      const data = await apiFetch<GoalListResponse>(`${basePath}?${params.toString()}`);
      setGoals(data.items);
      setTotal(data.total);
    } catch (err: any) {
      toast(err.message ?? label('error_generic'));
    } finally { setLoading(false); }
    // `label` and `toast` are deliberately not dependencies: the page hands the
    // label resolver as an inline arrow, so a new identity on every render would
    // make this effect re-run, set state and re-render for ever. Same exclusion
    // the Foods list beside it makes for its own `t`/`toast`.
  }, [apiFetch, basePath, ready, search, offset]);

  useEffect(() => { load(); }, [load]);

  function toggleExpand(id: number) {
    if (editingId === id) return; // never collapse the row being edited
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /* ── Inline create (#805: the same form body, at the top of the list) ────── */

  function openInlineNew() {
    setNewForm(emptyGoalForm());
    setNewError(null);
    setCreating(true);
    setTimeout(() => newNameRef.current?.focus(), 50);
  }

  async function saveInlineNew() {
    if (!newForm.name.trim()) { setNewError(label('error_required')); return; }
    setNewSaving(true); setNewError(null);
    try {
      await apiFetch(basePath, { method: 'POST', body: JSON.stringify(toGoalPayload(newForm)) });
      setCreating(false);
      load();
    } catch (e: any) {
      // The form stays open with the user's input intact (#800).
      setNewError(e.message ?? label('error_generic'));
    } finally { setNewSaving(false); }
  }

  /* ── Inline edit ────────────────────────────────────────────────────────── */

  function openInlineEdit(goal: GoalRow) {
    setEditingId(goal.id);
    setEditForm(toGoalFormValues(goal));
    setEditError(null);
    // `⋮ → Edit` expands the row it opens, so Cancel reveals the read-only view
    // rather than collapsing the row (#797).
    setExpanded((prev) => new Set(prev).add(goal.id));
  }

  async function saveInlineEdit(goal: GoalRow) {
    if (!editForm.name.trim()) { setEditError(label('error_required')); return; }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`${basePath}/${goal.id}`, { method: 'PUT', body: JSON.stringify(toGoalPayload(editForm)) });
      setEditingId(null);
      load();
    } catch (e: any) {
      setEditError(e.message ?? label('error_generic'));
    } finally { setEditSaving(false); }
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`${basePath}/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      load();
    } catch (e: any) {
      toast(e.message ?? label('error_generic'));
      setDeleting(null);
    }
  }

  /* ── Both halves of one body: the inline form, and the read-only view ───── */

  function renderInlineForm(
    form: GoalFormValues,
    setForm: (f: GoalFormValues) => void,
    error: string | null,
    saving: boolean,
    onCancel: () => void,
    onSave: () => void,
    saveLabel: string,
    autoFocusRef?: React.RefObject<HTMLInputElement>,
  ) {
    return (
      <div style={{ padding: '16px 20px' }}>
        <div style={{ marginBottom: 12 }}>
          <label style={formFieldLabelStyle}>{label('label_name')} *</label>
          <input
            ref={autoFocusRef}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            style={formControlStyle}
            autoFocus={!autoFocusRef}
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={formFieldLabelStyle}>{label('label_description')}</label>
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            rows={3}
            style={{ ...formControlStyle, resize: 'vertical' }}
          />
        </div>
        {error && <p style={formErrorStyle}>{error}</p>}
        <div style={inlineActionsRowStyle}>
          <button type="button" onClick={onCancel} style={secondaryBtnSmall}>{label('cancel')}</button>
          <button type="button" onClick={onSave} disabled={saving} style={primaryBtnSmall()}>
            {saving ? label('saving') : saveLabel}
          </button>
        </div>
      </div>
    );
  }

  function renderReadOnly(goal: GoalRow) {
    return (
      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ReadOnlyField label={label('label_name')} value={nameOf(goal)} />
        <ReadOnlyField label={label('label_description')} value={displayValue(goal.description)} wrap />
        <ReadOnlyField
          label={label('ownership')}
          value={goal.gym_id === null ? label('ownership_system') : label('ownership_gym')}
        />
      </div>
    );
  }

  const columns: Column<GoalRow>[] = [
    {
      header: label('label_name'),
      mobile: 'name',
      title: (goal) => nameOf(goal),
      render: (goal) => (
        <span>
          <strong>{nameOf(goal)}</strong>
          {/* The quiet pill every list uses for "what kind of row is this" (#724). */}
          {isSystemGoal(goal) && <span style={listNameBadgeStyle}>{label('ownership_system')}</span>}
        </span>
      ),
    },
    {
      header: label('col_type'),
      width: 120,
      mobile: 'secondary',
      render: (goal) => (
        <span style={{ fontSize: 13 }}>
          {goal.gym_id === null ? label('ownership_system') : label('ownership_gym')}
        </span>
      ),
    },
    {
      header: label('col_status'),
      width: 120,
      mobile: 'keep',
      render: (goal) => <StatusBadge status={goal.status} label={label(`status_${goal.status}`)} />,
    },
    {
      header: '',
      width: 40,
      mobile: 'actions',
      render: (goal) => {
        // A gym may not edit or delete a System row; Cordel administers those.
        const writable = scope === 'platform' || !isSystemGoal(goal);
        return (
          <ContextMenu items={[
            ...(writable ? [
              { label: label('edit'), onClick: () => openInlineEdit(goal), disabled: !canWrite, title: readOnlyTitle },
              { label: label('delete'), onClick: () => setDeleting(goal), disabled: !canWrite, title: readOnlyTitle, danger: true },
            ] : []),
            // Details is always last (#802's rule for a page that fixes its order).
            { label: label('details'), onClick: () => setDetailGoal(goal) },
          ]} />
        );
      },
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
              style={{ ...filterControlStyle, minWidth: 220 }}
            />
          </FilterField>
        </FilterBar>
        <button
          type="button"
          style={{ ...readOnlyStyle(primaryBtnStyle(), !canWrite), marginBottom: 16 }}
          onClick={openInlineNew}
          disabled={!canWrite || creating}
          title={readOnlyTitle}
        >
          {kindLabel('add')}
        </button>
      </div>

      {creating && (
        <div style={{ ...cardSurfaceStyle, overflow: 'hidden', marginBottom: 12 }}>
          <p style={{ ...cardSectionLabelStyle, padding: '12px 20px 0' }}>{kindLabel('add')}</p>
          {renderInlineForm(
            newForm, setNewForm, newError, newSaving,
            () => { setCreating(false); setNewError(null); },
            saveInlineNew, label('create'), newNameRef,
          )}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={goals}
        rowKey={(goal) => goal.id}
        loading={loading}
        loadingText={label('loading')}
        emptyText={kindLabel('empty')}
        renderExpanded={(goal) => (
          editingId === goal.id
            ? renderInlineForm(
              editForm, setEditForm, editError, editSaving,
              () => { setEditingId(null); setEditError(null); },
              () => saveInlineEdit(goal), label('save'),
            )
            : renderReadOnly(goal)
        )}
        expandedRowKeys={new Set([...expanded, ...(editingId !== null ? [editingId] : [])])}
        onToggleExpand={(goal) => toggleExpand(goal.id)}
      />

      {total > 0 && (
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, color: 'var(--gd-text-muted, #666)' }}>{pageStart}–{pageEnd} / {total}</span>
          <button type="button" onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0} style={secondaryBtnSmall}>‹</button>
          <button type="button" onClick={() => setOffset(offset + LIMIT)} disabled={pageEnd >= total} style={secondaryBtnSmall}>›</button>
        </div>
      )}

      {detailGoal && (
        <GoalDetailsModal
          goal={detailGoal}
          kind={kind}
          scope={scope === 'platform' ? 'platform' : 'gym'}
          name={nameOf(detailGoal)}
          label={label}
          onClose={() => setDetailGoal(null)}
        />
      )}

      {deleting && (
        <ConfirmDialog
          open
          message={kindLabel('delete_confirm')}
          confirmLabel={label('delete')}
          cancelLabel={label('cancel')}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function ReadOnlyField({ label, value, wrap }: { label: string; value: string; wrap?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={formFieldLabelStyle}>{label}</span>
      {/* `formValueStyle` carries the control's padding and border width, so a value
          sits exactly where its input does when `⋮ → Edit` opens (#929). */}
      <span style={{ ...formValueStyle, ...(wrap ? { whiteSpace: 'pre-wrap' } : {}) }}>{value}</span>
    </div>
  );
}
