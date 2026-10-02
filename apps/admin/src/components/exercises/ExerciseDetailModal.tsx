'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { ViewAuditLogButton, AuditLogScope } from '@/components/ViewAuditLogButton';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';
import { exerciseName } from '@/lib/exerciseNames';
import {
  exerciseDisplayValue,
  formatExerciseTimestamp,
  type ExerciseAuditRow,
} from './exerciseForm';

/**
 * `⋮ → Details` for an Exercise (#965 §11–§13): the **technical metadata** and
 * the View Audit Log deep link, and nothing else.
 *
 * It is the other half of the split the ticket draws. The expanded card is where
 * an exercise is understood — General, Configuration, Allowed Result Types,
 * Muscles, Media — and `⋮ → Edit` is where it is changed; this modal is where the
 * system's own record of it is inspected. Which is why it deliberately no longer
 * restates the configuration: it did until #965, so the same five sections were
 * rendered twice on one page by two components that had already drifted (the
 * modal showed `video_url` as text where the card showed the poster), and §12 is
 * explicit that it must not duplicate what the card already shows.
 *
 * It renders the **list row** it was handed rather than fetching a detail endpoint
 * of its own (#799's rule): every column below comes back with the row from both
 * `GET /exercises` and `GET /platform/exercises`, so there is no second Exercise
 * model to keep in step, and no spinner between opening the menu and reading the
 * dates.
 *
 * The actor names resolve differently per side and that is the router's business,
 * not this component's: a gym exercise's creator is the `gym_memberships` row the
 * gym router joins, while a **Base** exercise's is the snapshot migration 208
 * added, because a superadmin has no membership row to point at. A base exercise
 * written before that migration carries no name and reads as the em dash — the
 * Audit Log link is what covers its history.
 *
 * One component serves both pages; `scope` is what decides which Audit Log it
 * opens ('platform' for Cordel → Base Exercises).
 */
export function ExerciseDetailModal({ exercise, scope = 'gym', onClose }: {
  exercise: ExerciseAuditRow;
  scope?: AuditLogScope;
  onClose: () => void;
}) {
  const t = useTranslations('exercises');

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 520, maxHeight: '90vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('detail_title')}</h2>
        {/* #967: the modal names the exercise in the reader's own language. */}
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>{exerciseName(exercise)}</p>

        <p style={sectionLabelStyle}>{t('section_audit')}</p>
        {/* §12: the internal identifier belongs here and nowhere else — it is the
            number a support request or an Audit Log filter is quoted by. */}
        <Field label={t('detail_exercise_id')} value={String(exercise.id)} />
        <Field label={t('col_created_at')} value={formatExerciseTimestamp(exercise.created_at)} />
        <Field label={t('col_created_by')} value={exerciseDisplayValue(exercise.created_by_name)} />
        {/* An exercise never modified since creation still shows both rows, with
            the same empty-value convention every other Details modal uses. */}
        <Field label={t('detail_modified_at')} value={formatExerciseTimestamp(exercise.modified_at)} />
        <Field label={t('detail_modified_by')} value={exerciseDisplayValue(exercise.modified_by_name)} />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          {/* #675: the shared deep link, filtered to this exercise — never a hand-rolled one. */}
          <ViewAuditLogButton entityType="exercise" entityId={exercise.id} scope={scope} onNavigate={onClose} />
          <button type="button" onClick={onClose} style={btnStyle('#444')}>{t('close')}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--gd-card-border, #f5f5f5)' }}>
      <span style={{ width: 160, flexShrink: 0, fontSize: 13, color: '#888', fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 13, color: '#333' }}>{value}</span>
    </div>
  );
}

const sectionLabelStyle: React.CSSProperties = {
  margin: '0 0 4px', fontSize: 11, fontWeight: 700, color: '#aaa',
  textTransform: 'uppercase', letterSpacing: '0.06em',
};
