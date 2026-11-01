'use client';

import React from 'react';
import { useDroppable } from '@dnd-kit/core';
import { treeDropTargetStyle } from '@/components/workoutChrome';
import { HierBlock } from './summaries';
import { WorkoutBlockBuilder } from './WorkoutBlockBuilder';

/* Shape returned by GET /workout-templates/:id */
export interface WtHierarchy {
  id: number; name: string; description: string | null; status: string;
  created_by: string | null; created_at: string;
  blocks: HierBlock[] | null;
}

export const blockDragId = (templateId: number, blockId: number) => `block:${templateId}:${blockId}`;
export const exerciseDragId = (templateId: number, blockId: number, exId: number) => `ex:${templateId}:${blockId}:${exId}`;
export const templateDropId = (templateId: number) => `tmpl:${templateId}`;

export function TemplateDropTarget({ templateId, children }: { templateId: number; children: React.ReactNode }) {
  const { setNodeRef, isOver, active } = useDroppable({ id: templateDropId(templateId) });
  const activeId = active != null ? String(active.id) : '';
  const foreignBlock = activeId.startsWith('block:') && !activeId.startsWith(`block:${templateId}:`);
  return (
    <div ref={setNodeRef} style={treeDropTargetStyle(isOver && foreignBlock)}>
      {children}
    </div>
  );
}

/**
 * #2226: a Workout Template's structure is drawn by the one shared
 * `WorkoutBlockBuilder` (the renderer Assigned Training Plans use). This page
 * keeps only what is its own: a page-level DndContext that moves blocks between
 * templates, hence the 'page' drag scheme.
 */
export function WorkoutTemplateTree({ templateId, hierarchy, canWrite, onChanged }: {
  templateId: number;
  hierarchy: WtHierarchy;
  canWrite: boolean;
  onChanged: () => Promise<void> | void;
}) {
  return (
    <div style={{ marginTop: 4 }}>
      <WorkoutBlockBuilder
        workoutKey={templateId}
        blocksUrl={`/workout-templates/${templateId}/blocks`}
        blocks={hierarchy.blocks ?? []}
        canWrite={canWrite}
        onChanged={onChanged}
        dragScheme="page"
      />
    </div>
  );
}
