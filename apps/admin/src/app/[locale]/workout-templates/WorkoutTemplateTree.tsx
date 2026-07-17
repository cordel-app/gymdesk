'use client';

import React, { useState } from 'react';
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

  const [blockModal, setBlockModal] = useState<{ block: HierBlock | null } | null>(null);
  const [exerciseModal, setExerciseModal] = useState<{ block: HierBlock; item: HierExercise | null } | null>(null);
  const [deletingBlock, setDeletingBlock] = useState<HierBlock | null>(null);
  const [deletingExercise, setDeletingExercise] = useState<{ block: HierBlock; item: HierExercise } | null>(null);

  async function deleteBlock() {
    if (!deletingBlock) return;
    try {
      await apiFetch(`/workout-templates/${templateId}/blocks/${deletingBlock.id}`, { method: 'DELETE' });
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
        <button onClick={() => setBlockModal({ block: null })} style={inlineAddStyle}>
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
              onEdit={() => setBlockModal({ block: b })}
              onDelete={() => setDeletingBlock(b)}
              onAddExercise={() => setExerciseModal({ block: b, item: null })}
              onEditExercise={(ex) => setExerciseModal({ block: b, item: ex })}
              onDeleteExercise={(ex) => setDeletingExercise({ block: b, item: ex })}
            />
          ))}
        </SortableContext>
      )}

      {blockModal && (
        <BlockModal
          workoutTemplateId={templateId}
          block={blockModal.block}
          onCancel={() => setBlockModal(null)}
          onSaved={async () => { setBlockModal(null); await onChanged(); }}
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

function BlockRow({ templateId, block, canWrite, onEdit, onDelete, onAddExercise, onEditExercise, onDeleteExercise }: {
  templateId: number;
  block: HierBlock;
  canWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onAddExercise: () => void;
  onEditExercise: (ex: HierExercise) => void;
  onDeleteExercise: (ex: HierExercise) => void;
}) {
  const t = useTranslations();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: blockDragId(templateId, block.id) });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    background: '#fff',
    border: '1px solid #ececf0',
    borderRadius: 8,
    padding: '10px 14px',
    marginBottom: 10,
  };

  const exercises = block.exercises ?? [];

  return (
    <div ref={setNodeRef} style={style}>
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
          </div>
          <div style={{ color: '#888', fontSize: 12.5 }}>{blockSummary(block, t)}</div>
        </div>
        <span style={{ flex: 1 }} />
        {canWrite && (
          <ContextMenu
            ariaLabel={t('workout_templates.col_actions')}
            items={[
              { label: t('workout_template_blocks.edit'), onClick: onEdit },
              { label: t('workout_template_blocks.delete'), onClick: onDelete, danger: true },
            ]}
          />
        )}
      </div>

      <div style={{ marginTop: 6, paddingLeft: canWrite ? 26 : 16 }}>
        {canWrite && (
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

const inlineAddStyle: React.CSSProperties = {
  background: 'none', border: '1px dashed #b9b5ee', color: '#6c63ff', borderRadius: 6,
  padding: '3px 10px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', marginBottom: 6,
};
