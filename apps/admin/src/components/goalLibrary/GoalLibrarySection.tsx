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
  cardSectionLabelStyle, formControlStyle, formErrorStyle, formFieldLabelStyle, formHelpTextStyle,
  formValueStyle, inlineActionsRowStyle, secondaryBtnSmall,
} from '@/components/formChrome';
import { cardSurfaceStyle, primaryBtnSmall, primaryBtnStyle, readOnlyStyle } from '@/components/ui';
import { displayValue, formatTimestamp } from '@/components/nutritionLibrary/nutritionItemProfile';
import {
  IMAGE_PREVIEW_THUMBNAIL_SIZE, imagePreviewFrameStyle, imagePreviewImageStyle,
} from '@/components/imagePreviewFrame';
import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';
import { GoalDetailsModal } from './GoalDetailsModal';
import { GoalImageField } from './GoalImageField';
import {
  GOAL_API_ROOTS, GoalFormValues, GoalKind, GoalListResponse, GoalRow, GoalScope,
  emptyGoalForm, formatGoalTarget, goalAvailability, goalDisplayName, goalFormError, goalKindHasImage,
  goalKindIsGymConfigurable, isMeasurableGoalKind, isSystemGoal, toGoalFormValues, toGoalPayload,
  truncateDescription,
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
export function GoalLibrarySection({
  kind, scope, canWrite, readOnlyTitle, label, ready = true, onAssign,
}: {
  kind: GoalKind;
  scope: GoalScope;
  canWrite: boolean;
  readOnlyTitle?: string;
  /** Resolves a key in the calling page's own namespace (#901). */
  label: (key: string) => string;
  /** False while the page still has no gym context to read with. */
  ready?: boolean;
  /**
   * #1034 §4 — an opt-in `Assign goal to member` item for the row's `⋮`. Omitted
   * means the item is **absent**, which is what keeps Cordel's Base library out
   * of it: a platform goal has no gym whose members it could be assigned to, so
   * the action belongs to the page that has one and not to this component. The
   * section only *opens* it — the modal, its request and its catalogues are the
   * page's, exactly as `basePath` and `canWrite` are (#806).
   */
  onAssign?: (goal: GoalRow) => void;
}) {
  const basePath = GOAL_API_ROOTS[scope][kind];
  // #1034 §1: asked once, so the column, the read-only field and both halves of
  // the form cannot disagree about whether this kind has a target.
  const measurable = isMeasurableGoalKind(kind);
  // #1035 stage 2: asked once, so the read-only preview and the Edit control
  // cannot disagree about whether this kind has an image — and for a kind that
  // has none, neither is rendered at all.
  const hasImage = goalKindHasImage(kind);
  // #1181: asked once, so the Status column, the Duplicate and the Activate /
  // Deactivate items cannot disagree about whether this kind is one a gym
  // configures — and only a gym's own library configures anything: the
  // platform list has no gym whose state it could hold.
  const configurable = scope === 'gym' && goalKindIsGymConfigurable(kind);
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
    const invalid = goalFormError(newForm, kind);
    if (invalid) { setNewError(label(invalid)); return; }
    setNewSaving(true); setNewError(null);
    try {
      await apiFetch(basePath, { method: 'POST', body: JSON.stringify(toGoalPayload(newForm, kind)) });
      setCreating(false);
      load();
    } catch (e: any) {
      // The form stays open with the user's input intact (#800).
      setNewError(e.message ?? label('error_generic'));
    } finally { setNewSaving(false); }
  }

  /**
   * The row the image control just changed, as the API returned it.
   *
   * Patched in place rather than reloading the list: the upload answers with the
   * whole goal, so a second read would buy nothing — and it would also fight the
   * open editor, whose draft is this component's own state. The row carries its
   * new `modified_at`, which is what cache-busts the preview.
   */
  function applyGoalChange(updated: GoalRow) {
    setGoals((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
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
    const invalid = goalFormError(editForm, kind);
    if (invalid) { setEditError(label(invalid)); return; }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`${basePath}/${goal.id}`, { method: 'PUT', body: JSON.stringify(toGoalPayload(editForm, kind)) });
      setEditingId(null);
      load();
    } catch (e: any) {
      setEditError(e.message ?? label('error_generic'));
    } finally { setEditSaving(false); }
  }

  /* ── Duplicate, Activate / Deactivate (#1181) ───────────────────────────── */

  /** An immediate action (no confirmation): the new gym-owned copy is in the reloaded list. */
  async function duplicate(goal: GoalRow) {
    try {
      await apiFetch(`${basePath}/${goal.id}/duplicate`, { method: 'POST' });
      toast(label('duplicated'));
      load();
    } catch (e: any) {
      toast(e.message ?? label('error_generic'));
    }
  }

  /**
   * The gym's own availability state for the goal — never the goal's row, and
   * never a soft delete: a System goal deactivated here is still the platform's
   * and still another gym's, and an existing assignment of it stands.
   */
  async function setAvailability(goal: GoalRow, action: 'activate' | 'deactivate') {
    try {
      const updated = await apiFetch<GoalRow>(`${basePath}/${goal.id}/${action}`, { method: 'POST' });
      applyGoalChange(updated);
      toast(label(action === 'activate' ? 'activated' : 'deactivated'));
    } catch (e: any) {
      toast(e.message ?? label('error_generic'));
    }
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
    /**
     * The persisted goal this form is editing, or `undefined` while one is being
     * created. The image control needs it: the object key is built from the row's
     * id, which does not exist yet on a create — so that half says to upload it
     * from Edit rather than offering a control that has nowhere to write (the
     * Base Nutrition Library's own answer, #715, and #974's rule about never
     * rendering a control the route would ignore).
     */
    goal?: GoalRow,
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
        {/* #1034 §1/§3 — the measurable pair, on one row, in the app's own form
            chrome (§3/§14: no custom styling, no numeric input of its own). Absent
            for a kind that has no such columns rather than disabled, because a
            control whose `PUT` is ignored is the thing #974 forbids. */}
        {measurable && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={formFieldLabelStyle}>{label('label_target_value')}</label>
              <input
                type="number"
                min={form.target_type === 'relative' ? undefined : 0}
                step="0.01"
                value={form.target_value}
                onChange={(e) => setForm({ ...form, target_value: e.target.value })}
                style={formControlStyle}
              />
              <span style={formHelpTextStyle}>{label('help_target_value')}</span>
            </div>
            <div>
              <label style={formFieldLabelStyle}>{label('label_target_type')}</label>
              <select
                value={form.target_type}
                onChange={(e) => setForm({ ...form, target_type: e.target.value === 'relative' ? 'relative' : 'absolute' })}
                style={formControlStyle}
              >
                <option value="absolute">{label('target_type_absolute')}</option>
                <option value="relative">{label('target_type_relative')}</option>
              </select>
              <span style={formHelpTextStyle}>{label('help_target_type')}</span>
            </div>
            <div>
              <label style={formFieldLabelStyle}>{label('label_target_unit')}</label>
              <input
                value={form.target_unit}
                onChange={(e) => setForm({ ...form, target_unit: e.target.value })}
                placeholder={label('placeholder_target_unit')}
                maxLength={20}
                style={formControlStyle}
              />
            </div>
          </div>
        )}
        {/* #1035 stage 2 — not a form field: the upload and the removal act on
            the server straight away, so Save and Cancel neither carry nor undo
            them. It belongs to Edit mode all the same (#797/#799 §17: the
            expanded card reads, `⋮ → Edit` writes). */}
        {hasImage && (
          <div style={{ marginBottom: 12 }}>
            <label style={formFieldLabelStyle}>{label('label_image')}</label>
            {goal ? (
              <GoalImageField
                goal={goal}
                basePath={basePath}
                /* A System goal's object lives under `cordel/goals/`, which no
                   gym's bucket gates (#823) — so Cordel's page must not be
                   blocked by whichever gym a superadmin has selected. */
                requiresGymStorage={scope !== 'platform'}
                disabled={!canWrite}
                disabledTitle={readOnlyTitle}
                label={label}
                onChanged={applyGoalChange}
              />
            ) : (
              <span style={formHelpTextStyle}>{label('image_after_create')}</span>
            )}
          </div>
        )}
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
        {measurable && <ReadOnlyField label={label('label_target')} value={formatGoalTarget(goal)} />}
        {/* A value, not a control: the read-only half of the card holds no
            affordance of any kind (#797). */}
        {hasImage && (
          <ReadOnlyImage
            label={label('label_image')}
            url={goal.image_url ?? null}
            stamp={goal.modified_at ?? goal.created_at}
            emptyText={label('image_none')}
          />
        )}
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
    // #1181 §3 — the standard entity columns: Name, Description, Target,
    // Created At, Created By, Status, Actions. The description is clipped for
    // the row and whole in the expanded row and in Details; the value stored is
    // never touched.
    {
      header: label('label_description'),
      mobile: 'secondary',
      render: (goal) => (
        <span style={{ fontSize: 13 }} title={goal.description ?? undefined}>
          {goal.description ? truncateDescription(goal.description) : '—'}
        </span>
      ),
    },
    // Declared conditionally rather than rendered as `—` for a kind that has no
    // such column at all: this is not a value a Nutrition Goal is missing, it is
    // a field that kind does not have (`Column.mobile` keeps a *present* column's
    // cell, #1011).
    ...(measurable ? [{
      header: label('col_target'),
      width: 120,
      mobile: 'secondary' as const,
      render: (goal: GoalRow) => <span style={{ fontSize: 13 }}>{formatGoalTarget(goal)}</span>,
    }] : []),
    {
      header: label('created_at'),
      width: 150,
      mobile: 'secondary',
      render: (goal) => <span style={{ fontSize: 13 }}>{formatTimestamp(goal.created_at)}</span>,
    },
    {
      // The actor snapshot, masked for a System row by the API (#799): a gym is
      // shown `—`, never a Cordel employee's name.
      header: label('created_by'),
      width: 150,
      mobile: 'secondary',
      render: (goal) => <span style={{ fontSize: 13 }}>{displayValue(goal.created_by_name)}</span>,
    },
    {
      // This gym's availability state for a configurable kind (#1181), the
      // row's own lifecycle otherwise — two different axes, and soft deletion
      // is never shown here because a deleted row is not listed.
      header: label('col_status'),
      width: 120,
      mobile: 'keep',
      render: (goal) => {
        const status = configurable ? goalAvailability(goal) : goal.status;
        return <StatusBadge status={status} label={label(`status_${status}`)} />;
      },
    },
    {
      header: '',
      width: 40,
      mobile: 'actions',
      render: (goal) => {
        // A gym may not edit or delete a System row; Cordel administers those.
        const writable = scope === 'platform' || !isSystemGoal(goal);
        const available = goalAvailability(goal) === 'active';
        return (
          <ContextMenu items={[
            // #1181 — Duplicate first, for a System goal and the gym's own alike:
            // the copy is always a new gym-owned goal. Immediate, no dialog.
            ...(configurable ? [
              { label: label('duplicate'), onClick: () => duplicate(goal), disabled: !canWrite, title: readOnlyTitle },
            ] : []),
            // #1181 — the gym's own availability state. Deactivate takes the
            // shared danger styling (it removes the goal from what members and
            // staff may pick), Activate the normal one — the Professional
            // Services pattern.
            ...(configurable ? [
              available
                ? { label: label('deactivate'), onClick: () => setAvailability(goal, 'deactivate'), disabled: !canWrite, title: readOnlyTitle, danger: true }
                : { label: label('activate'), onClick: () => setAvailability(goal, 'activate'), disabled: !canWrite, title: readOnlyTitle },
            ] : []),
            ...(writable ? [
              { label: label('edit'), onClick: () => openInlineEdit(goal), disabled: !canWrite, title: readOnlyTitle },
            ] : []),
            // #1034 §4 — offered for a System goal as well as the gym's own: a
            // gym may not *edit* a platform row but may certainly assign it,
            // which is the catalogue's own gym-facing visibility rule (#947 §5)
            // and exactly what `POST /member-personal-goals` already accepts.
            // It is not destructive, so it carries no `danger` flag. Since
            // #1181 an inactive goal is not assignable — the server refuses it
            // — so the item is disabled, with the reason, rather than offered.
            ...(onAssign ? [{
              label: label('assign_to_member'),
              onClick: () => onAssign(goal),
              disabled: !canWrite || !available,
              title: !available ? label('inactive_assign_hint') : readOnlyTitle,
            }] : []),
            ...(writable ? [
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
              () => saveInlineEdit(goal), label('save'), undefined, goal,
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

/**
 * A goal's image as a **value** — the read-only counterpart of
 * `GoalImageField`, drawn in the app's one 1:1 frame at thumbnail size and
 * carrying no control at all (#797). A goal with none reads as the frame's own
 * empty text rather than as a broken image or a placeholder asset: there is no
 * default picture in this app and no fallback to another goal's (#716's rule).
 */
function ReadOnlyImage({ label, url, stamp, emptyText }: {
  label: string; url: string | null; stamp: string | null; emptyText: string;
}) {
  // Cache-busted on the row's own timestamp, because the object key is
  // deterministic and a replacement rewrites it.
  const src = url ? `${url}?v=${encodeURIComponent(stamp ?? '')}` : null;
  const drawable = src != null && SAFE_IMAGE_SRC.test(src);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={formFieldLabelStyle}>{label}</span>
      <div style={imagePreviewFrameStyle(IMAGE_PREVIEW_THUMBNAIL_SIZE)}>
        {drawable ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src!} alt="" loading="lazy" style={imagePreviewImageStyle} />
        ) : (
          <span style={{ ...formHelpTextStyle, margin: 0, fontSize: 11, textAlign: 'center', padding: 4 }}>{emptyText}</span>
        )}
      </div>
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
