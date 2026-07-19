'use client';

import React, { useState, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu } from '@/components/ContextMenu';
import { HierBlock, HierExercise, blockSummary, exerciseSummary } from './summaries';
import { BlockModal } from './BlockModal';
import { ExerciseModal } from './ExerciseModal';
import { BLOCK_TYPES, RESULT_TYPES, isBlockFieldVisible, BLOCK_TYPE_MAX_EXERCISES } from './blockFieldConfig';

/* Shape returned by GET /workout-templates/:id (template + aggregated blocks). */
export interface WtHierarchy {
  id: number; name: string; status: string;
  blocks: HierBlock[] | null;
}

/* Drag ids share one page-level DndContext (page.tsx):
 *   block:<templateId>:<blockId>      sortable block row
 *   ex:<templateId>:<blockId>:<exId>  sortable exercise row
 *   tmpl:<templateId>                 droppable template name cell (cross-template move)
 */
export const blockDragId = (templateId: number, blockId: number) => `block:${templateId}:${blockId}`;
export const exerciseDragId = (templateId: number, blockId: number, exId: number) => `ex:${templateId}:${blockId}:${exId}`;
export const templateDropId = (templateId: number) => `tmpl:${templateId}`;

/** Wraps the Name cell so a block dragged from another template can be dropped
 *  onto the row itself (works for collapsed rows too — appends at the end). */
export function TemplateDropTarget({ templateId, children }: { templateId: number; children: React.ReactNode }) {
  const { setNodeRef, isOver, active } = useDroppable({ id: templateDropId(templateId) });
  const activeId = active != null ? String(active.id) : '';
  const foreignBlock = activeId.startsWith('block:') && !activeId.startsWith(`block:${templateId}:`);
  return (
    <div
      ref={setNodeRef}
      style={{
        margin: '-6px -8px', padding: '6px 8px', borderRadius: 6,
        background: isOver && foreignBlock ? '#eef0ff' : undefined,
        outline: isOver && foreignBlock ? '2px dashed #6c63ff' : 'none',
        transition: 'background 0.1s',
      }}
    >
      {children}
    </div>
  );
}

export function WorkoutTemplateTree({ templateId, hierarchy, canWrite, onChanged }: {
  templateId: number;
  hierarchy: WtHierarchy;
  canWrite: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const blocks = hierarchy.blocks ?? [];

  const [editingBlockId, setEditingBlockId] = useState<number | null>(null);
  const [addBlockModal, setAddBlockModal] = useState(false);
  const [exerciseModal, setExerciseModal] = useState<{ block: HierBlock; item: HierExercise | null } | null>(null);
  const [deletingBlock, setDeletingBlock] = useState<HierBlock | null>(null);
  const [deletingExercise, setDeletingExercise] = useState<{ block: HierBlock; item: HierExercise } | null>(null);
  // pendingBlockId: the block the user wants to open after resolving unsaved changes (null = just close)
  const [unsavedGuard, setUnsavedGuard] = useState<{ pendingBlockId: number | null } | null>(null);

  // Ref to the save function of the currently open inline editor, so we can trigger save from the guard.
  const inlineEditorSaveRef = useRef<(() => Promise<void>) | null>(null);
  const isDirtyRef = useRef(false);

  function requestEditBlock(blockId: number) {
    if (editingBlockId === blockId) return; // already editing this one
    if (editingBlockId !== null && isDirtyRef.current) {
      setUnsavedGuard({ pendingBlockId: blockId });
    } else {
      setEditingBlockId(blockId);
    }
  }

  function closeInlineEditor() {
    setEditingBlockId(null);
    isDirtyRef.current = false;
    inlineEditorSaveRef.current = null;
  }

  async function handleGuardSave() {
    if (inlineEditorSaveRef.current) {
      await inlineEditorSaveRef.current();
      // onChanged() is called inside the editor's save; we just switch after.
    }
    const next = unsavedGuard?.pendingBlockId ?? null;
    setUnsavedGuard(null);
    isDirtyRef.current = false;
    setEditingBlockId(next);
  }

  function handleGuardDiscard() {
    const next = unsavedGuard?.pendingBlockId ?? null;
    setUnsavedGuard(null);
    isDirtyRef.current = false;
    setEditingBlockId(next);
  }

  async function deleteBlock() {
    if (!deletingBlock) return;
    try {
      await apiFetch(`/workout-templates/${templateId}/blocks/${deletingBlock.id}`, { method: 'DELETE' });
      if (editingBlockId === deletingBlock.id) closeInlineEditor();
      setDeletingBlock(null);
      await onChanged();
    } catch (err: any) {
      setDeletingBlock(null);
      toast(err.message ?? t('workout_template_blocks.error_generic'));
    }
  }

  async function deleteExercise() {
    if (!deletingExercise) return;
    try {
      await apiFetch(`/workout-templates/${templateId}/blocks/${deletingExercise.block.id}/exercises/${deletingExercise.item.id}`, { method: 'DELETE' });
      setDeletingExercise(null);
      await onChanged();
    } catch (err: any) {
      setDeletingExercise(null);
      toast(err.message ?? t('block_exercises.error_generic'));
    }
  }

  return (
    <div style={{ padding: '12px 20px 18px 44px' }}>
      {canWrite && (
        <button onClick={() => setAddBlockModal(true)} style={inlineAddStyle}>
          {t('workout_templates.tree_add_block')}
        </button>
      )}

      {blocks.length === 0 ? (
        <p style={{ color: '#888', fontSize: 14, margin: '8px 0 4px' }}>{t('workout_templates.tree_no_blocks')}</p>
      ) : (
        <SortableContext items={blocks.map((b) => blockDragId(templateId, b.id))} strategy={verticalListSortingStrategy}>
          {blocks.map((b) => (
            <BlockRow
              key={b.id}
              templateId={templateId}
              block={b}
              canWrite={canWrite}
              isEditing={editingBlockId === b.id}
              onEditInline={() => requestEditBlock(b.id)}
              onDelete={() => setDeletingBlock(b)}
              onAddExercise={() => setExerciseModal({ block: b, item: null })}
              onEditExercise={(ex) => setExerciseModal({ block: b, item: ex })}
              onDeleteExercise={(ex) => setDeletingExercise({ block: b, item: ex })}
              onInlineSaved={async () => { closeInlineEditor(); await onChanged(); }}
              onInlineCancelled={closeInlineEditor}
              registerSave={(fn) => { inlineEditorSaveRef.current = fn; }}
              onDirtyChange={(dirty) => { isDirtyRef.current = dirty; }}
            />
          ))}
        </SortableContext>
      )}

      {addBlockModal && (
        <BlockModal
          workoutTemplateId={templateId}
          block={null}
          onCancel={() => setAddBlockModal(false)}
          onSaved={async () => { setAddBlockModal(false); await onChanged(); }}
        />
      )}
      {exerciseModal && (
        <ExerciseModal
          workoutTemplateId={templateId}
          blockId={exerciseModal.block.id}
          item={exerciseModal.item}
          onCancel={() => setExerciseModal(null)}
          onSaved={async () => { setExerciseModal(null); await onChanged(); }}
        />
      )}

      {/* Unsaved-changes guard: shown inline inside the currently-editing block.
          We use a ConfirmDialog for the Discard/Cancel half and handle Save separately. */}
      {unsavedGuard && (
        <UnsavedChangesDialog
          onSave={handleGuardSave}
          onDiscard={handleGuardDiscard}
          onCancel={() => setUnsavedGuard(null)}
        />
      )}

      <ConfirmDialog
        open={deletingBlock !== null}
        message={t('workout_template_blocks.confirm_delete')}
        confirmLabel={t('workout_template_blocks.delete')}
        cancelLabel={t('workout_template_blocks.cancel')}
        onConfirm={deleteBlock}
        onCancel={() => setDeletingBlock(null)}
      />
      <ConfirmDialog
        open={deletingExercise !== null}
        message={t('block_exercises.confirm_delete')}
        confirmLabel={t('block_exercises.delete')}
        cancelLabel={t('block_exercises.cancel')}
        onConfirm={deleteExercise}
        onCancel={() => setDeletingExercise(null)}
      />
    </div>
  );
}

function UnsavedChangesDialog({ onSave, onDiscard, onCancel }: {
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations();
  return (
    <div style={overlayStyle}>
      <div style={dialogStyle}>
        <p style={{ margin: '0 0 16px', fontSize: 14 }}>{t('workout_template_blocks.unsaved_changes')}</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={btnSecondary}>{t('workout_template_blocks.cancel')}</button>
          <button onClick={onDiscard} style={btnSecondary}>{t('workout_template_blocks.unsaved_discard')}</button>
          <button onClick={onSave} style={btnPrimary}>{t('workout_template_blocks.unsaved_save')}</button>
        </div>
      </div>
    </div>
  );
}

function BlockRow({ templateId, block, canWrite, isEditing, onEditInline, onDelete, onAddExercise, onEditExercise, onDeleteExercise, onInlineSaved, onInlineCancelled, registerSave, onDirtyChange }: {
  templateId: number;
  block: HierBlock;
  canWrite: boolean;
  isEditing: boolean;
  onEditInline: () => void;
  onDelete: () => void;
  onAddExercise: () => void;
  onEditExercise: (ex: HierExercise) => void;
  onDeleteExercise: (ex: HierExercise) => void;
  onInlineSaved: () => void;
  onInlineCancelled: () => void;
  registerSave: (fn: () => Promise<void>) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useTranslations();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: blockDragId(templateId, block.id) });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    background: isEditing ? '#fafafe' : '#fff',
    border: isEditing ? '1.5px solid #b9b5ee' : '1px solid #ececf0',
    borderRadius: 8,
    padding: '10px 14px',
    marginBottom: 10,
  };

  const exercises = block.exercises ?? [];
  const maxEx = BLOCK_TYPE_MAX_EXERCISES[block.type];
  const atLimit = maxEx !== null && exercises.length >= maxEx;

  return (
    <div ref={setNodeRef} style={style}>
      {isEditing ? (
        <BlockInlineEditor
          templateId={templateId}
          block={block}
          onSaved={onInlineSaved}
          onCancelled={onInlineCancelled}
          registerSave={registerSave}
          onDirtyChange={onDirtyChange}
        />
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {canWrite && (
            <span
              {...attributes}
              {...listeners}
              aria-label={t('workout_templates.tree_drag_handle')}
              style={{ cursor: 'grab', color: '#bbb', fontSize: 16, userSelect: 'none', touchAction: 'none' }}
            >
              ⠿
            </span>
          )}
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              {block.name || t(`workout_template_blocks.type_${block.type.toLowerCase()}`)}
              <span style={{ fontWeight: 400, color: '#999', fontSize: 12, marginLeft: 6 }}>
                ({exercises.length}{maxEx !== null ? `/${maxEx}` : ''})
              </span>
            </div>
            <div style={{ color: '#888', fontSize: 12.5 }}>{blockSummary(block, t)}</div>
          </div>
          <span style={{ flex: 1 }} />
          {canWrite && (
            <ContextMenu
              ariaLabel={t('workout_templates.col_actions')}
              items={[
                { label: t('workout_template_blocks.edit'), onClick: onEditInline },
                { label: t('workout_template_blocks.delete'), onClick: onDelete, danger: true },
              ]}
            />
          )}
        </div>
      )}

      <div style={{ marginTop: 6, paddingLeft: canWrite && !isEditing ? 26 : 0 }}>
        {canWrite && !atLimit && (
          <button onClick={onAddExercise} style={inlineAddStyle}>{t('workout_templates.tree_add_exercise')}</button>
        )}
        {exercises.length === 0 ? (
          <p style={{ color: '#bbb', fontSize: 12.5, margin: '4px 0 2px' }}>{t('workout_templates.tree_no_exercises')}</p>
        ) : (
          <SortableContext items={exercises.map((ex) => exerciseDragId(templateId, block.id, ex.id))} strategy={verticalListSortingStrategy}>
            {exercises.map((ex) => (
              <ExerciseRow
                key={ex.id}
                templateId={templateId}
                blockId={block.id}
                exercise={ex}
                canWrite={canWrite}
                onEdit={() => onEditExercise(ex)}
                onDelete={() => onDeleteExercise(ex)}
              />
            ))}
          </SortableContext>
        )}
      </div>
    </div>
  );
}

function BlockInlineEditor({ templateId, block, onSaved, onCancelled, registerSave, onDirtyChange }: {
  templateId: number;
  block: HierBlock;
  onSaved: () => void;
  onCancelled: () => void;
  registerSave: (fn: () => Promise<void>) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [form, setForm] = useState({
    name: block.name ?? '',
    description: block.description ?? '',
    type: block.type,
    result_type: block.result_type,
    rounds: block.rounds != null ? String(block.rounds) : '',
    duration_seconds: block.duration_seconds != null ? String(block.duration_seconds) : '',
    work_seconds: block.work_seconds != null ? String(block.work_seconds) : '',
    rest_seconds: block.rest_seconds != null ? String(block.rest_seconds) : '',
    is_optional: !!block.is_optional,
    notes: block.notes ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const currentExCount = block.exercises?.length ?? 0;
  const newMaxEx = BLOCK_TYPE_MAX_EXERCISES[form.type];
  const typeError = newMaxEx !== null && currentExCount > newMaxEx
    ? t('workout_templates.block_type_limit_exceeded', { type: t(`workout_template_blocks.type_${form.type.toLowerCase()}`), max: newMaxEx })
    : null;

  function update(patch: Partial<typeof form>) {
    setForm((f) => ({ ...f, ...patch }));
    onDirtyChange(true);
  }

  async function save() {
    if (typeError) return;
    setSaving(true);
    setFieldError(null);
    const body = {
      name: form.name.trim() || null,
      description: form.description.trim() || null,
      type: form.type,
      result_type: form.result_type,
      rounds: form.rounds ? parseInt(form.rounds, 10) : null,
      duration_seconds: form.duration_seconds ? parseInt(form.duration_seconds, 10) : null,
      work_seconds: form.work_seconds ? parseInt(form.work_seconds, 10) : null,
      rest_seconds: form.rest_seconds ? parseInt(form.rest_seconds, 10) : null,
      is_optional: form.is_optional,
      notes: form.notes.trim() || null,
    };
    try {
      await apiFetch(`/workout-templates/${templateId}/blocks/${block.id}`, { method: 'PUT', body: JSON.stringify(body) });
      onDirtyChange(false);
      onSaved();
    } catch (err: any) {
      toast(err.message ?? t('workout_template_blocks.error_generic'));
    } finally {
      setSaving(false);
    }
  }

  // Register save function so the unsaved-changes guard can call it.
  React.useEffect(() => {
    registerSave(save);
  });

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
        <Field label={t('workout_template_blocks.col_name')}>
          <input value={form.name} onChange={(e) => update({ name: e.target.value })} style={input} autoFocus />
        </Field>
        <Field label={t('workout_template_blocks.col_type')}>
          <select value={form.type} onChange={(e) => update({ type: e.target.value })} style={input}>
            {BLOCK_TYPES.map((ty) => <option key={ty} value={ty}>{t(`workout_template_blocks.type_${ty.toLowerCase()}`)}</option>)}
          </select>
          {typeError && <span style={{ color: '#c0392b', fontSize: 12, marginTop: 2 }}>{typeError}</span>}
        </Field>
        {isBlockFieldVisible(form.type, 'result_type') && (
          <Field label={t('workout_template_blocks.col_result_type')}>
            <select value={form.result_type} onChange={(e) => update({ result_type: e.target.value })} style={input}>
              {RESULT_TYPES.map((rt) => <option key={rt} value={rt}>{t(`workout_template_blocks.result_type_${rt.toLowerCase()}`)}</option>)}
            </select>
          </Field>
        )}
        {isBlockFieldVisible(form.type, 'rounds') && (
          <Field label={t('workout_template_blocks.col_rounds')}>
            <input type="number" min="0" value={form.rounds} onChange={(e) => update({ rounds: e.target.value })} style={input} />
          </Field>
        )}
        {isBlockFieldVisible(form.type, 'duration_seconds') && (
          <Field label={t('workout_template_blocks.col_duration')}>
            <input type="number" min="0" value={form.duration_seconds} onChange={(e) => update({ duration_seconds: e.target.value })} style={input} />
          </Field>
        )}
        {isBlockFieldVisible(form.type, 'work_seconds') && (
          <Field label={t('workout_template_blocks.col_work_seconds')}>
            <input type="number" min="0" value={form.work_seconds} onChange={(e) => update({ work_seconds: e.target.value })} style={input} />
          </Field>
        )}
        {isBlockFieldVisible(form.type, 'rest_seconds') && (
          <Field label={t('workout_template_blocks.col_rest_seconds')}>
            <input type="number" min="0" value={form.rest_seconds} onChange={(e) => update({ rest_seconds: e.target.value })} style={input} />
          </Field>
        )}
        <Field label={t('workout_template_blocks.col_optional')}>
          <input type="checkbox" checked={form.is_optional} onChange={(e) => update({ is_optional: e.target.checked })} />
        </Field>
      </div>
      <div style={{ marginTop: 10 }}>
        <Field label={t('workout_template_blocks.col_notes')}>
          <input value={form.notes} onChange={(e) => update({ notes: e.target.value })} style={{ ...input, width: '100%' }} />
        </Field>
      </div>
      {fieldError && <p style={{ color: '#c0392b', fontSize: 12, margin: '6px 0 0' }}>{fieldError}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button onClick={onCancelled} style={btnSecondary} disabled={saving}>
          {t('workout_template_blocks.cancel')}
        </button>
        <button onClick={save} style={btnPrimary} disabled={saving || !!typeError}>
          {saving ? t('workout_template_blocks.saving') : t('workout_template_blocks.save_changes')}
        </button>
      </div>
    </div>
  );
}

function ExerciseRow({ templateId, blockId, exercise, canWrite, onEdit, onDelete }: {
  templateId: number;
  blockId: number;
  exercise: HierExercise;
  canWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: exerciseDragId(templateId, blockId, exercise.id) });

  const summary = exerciseSummary(exercise, t);

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '3px 0',
      }}
    >
      {canWrite && (
        <span
          {...attributes}
          {...listeners}
          aria-label={t('workout_templates.tree_drag_handle')}
          style={{ cursor: 'grab', color: '#ccc', fontSize: 13, userSelect: 'none', touchAction: 'none' }}
        >
          ⠿
        </span>
      )}
      <span style={{ fontSize: 13.5 }}>{exercise.exercise_name}</span>
      {summary && <span style={{ color: '#999', fontSize: 12.5 }}>{summary}</span>}
      <span style={{ flex: 1 }} />
      {canWrite && (
        <ContextMenu
          ariaLabel={t('workout_templates.col_actions')}
          items={[
            { label: t('block_exercises.edit'), onClick: onEdit },
            { label: t('block_exercises.delete'), onClick: onDelete, danger: true },
          ]}
        />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: '#666' }}>{label}</span>
      {children}
    </div>
  );
}

const inlineAddStyle: React.CSSProperties = {
  background: 'none', border: '1px dashed #b9b5ee', color: '#6c63ff', borderRadius: 6,
  padding: '3px 10px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', marginBottom: 6,
};

const input: React.CSSProperties = {
  padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14,
  boxSizing: 'border-box', width: '100%',
};

const btnPrimary: React.CSSProperties = {
  background: '#6c63ff', color: '#fff', border: 'none', borderRadius: 6,
  padding: '7px 16px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer',
};

const btnSecondary: React.CSSProperties = {
  background: '#fff', color: '#444', border: '1px solid #ccc', borderRadius: 6,
  padding: '7px 16px', fontSize: 13.5, cursor: 'pointer',
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};

const dialogStyle: React.CSSProperties = {
  background: '#fff', borderRadius: 10, padding: '24px 28px',
  boxShadow: '0 8px 32px rgba(0,0,0,0.18)', minWidth: 320, maxWidth: 400,
};
