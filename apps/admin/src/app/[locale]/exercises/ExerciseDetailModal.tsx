'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';

interface ExerciseDetail {
  id: number;
  name: string;
  description: string | null;
  video_url: string | null;
  image_url: string | null;
  min_reps_default: number | null;
  max_reps_default: number | null;
  sets_default: number | null;
  rest_default_seconds: number | null;
  notes_default: string | null;
  status: string;
  muscles: { key: string; role: string }[] | null;
  allowed_result_types: { id: number; name: string; slug: string }[] | null;
  created_at: string;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_name: string | null;
  deleted_at: string | null;
}

export function ExerciseDetailModal({ exerciseId, exerciseName, onClose }: {
  exerciseId: number;
  exerciseName: string;
  onClose: () => void;
}) {
  const t = useTranslations('exercises');
  const tStatus = useTranslations('status');
  const { apiFetch } = useApiClient();
  const [detail, setDetail] = useState<ExerciseDetail | null>(null);

  useEffect(() => {
    apiFetch<ExerciseDetail>(`/exercises/${exerciseId}`)
      .then(setDetail)
      .catch(() => {});
  }, [exerciseId]);

  const field = (label: string, value: string | null | undefined) => (
    <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid #f5f5f5' }}>
      <span style={{ width: 180, flexShrink: 0, fontSize: 13, color: '#888', fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 13, color: '#333' }}>{value || '—'}</span>
    </div>
  );

  const principalMuscles = (detail?.muscles ?? []).filter((m) => m.role === 'principal').map((m) => m.key).join(', ') || '—';
  const secondaryMuscles = (detail?.muscles ?? []).filter((m) => m.role === 'secondary').map((m) => m.key).join(', ') || '—';
  const resultTypes = (detail?.allowed_result_types ?? []).map((rt) => rt.name).join(', ') || '—';

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 540, maxHeight: '90vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('detail_title')}</h2>
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>{exerciseName}</p>

        {!detail ? (
          <p style={{ color: '#888', fontSize: 13 }}>{t('loading')}</p>
        ) : (
          <>
            <p style={sectionLabelSt}>{t('section_general')}</p>
            {field(t('label_name'), detail.name)}
            {field(t('label_description'), detail.description)}
            {field(t('label_status'), tStatus(detail.status as any))}
            {field(t('label_result_types'), resultTypes)}

            <p style={{ ...sectionLabelSt, marginTop: 20 }}>{t('section_configuration')}</p>
            {field(t('label_min_reps_default'), detail.min_reps_default != null ? String(detail.min_reps_default) : null)}
            {field(t('label_max_reps_default'), detail.max_reps_default != null ? String(detail.max_reps_default) : null)}
            {field(t('label_sets_default'), detail.sets_default != null ? String(detail.sets_default) : null)}
            {field(t('label_rest_default_seconds'), detail.rest_default_seconds != null ? String(detail.rest_default_seconds) : null)}
            {field(t('label_notes_default'), detail.notes_default)}

            <p style={{ ...sectionLabelSt, marginTop: 20 }}>{t('section_muscles')}</p>
            {field(t('role_principal'), principalMuscles)}
            {field(t('role_secondary'), secondaryMuscles)}

            <p style={{ ...sectionLabelSt, marginTop: 20 }}>{t('section_media')}</p>
            {field(t('label_video_url'), detail.video_url)}
            {field(t('label_image_url'), detail.image_url)}

            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '2px solid #f0f0f0' }}>
              <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Audit</p>
              {field(t('col_created_by'), detail.created_by_name)}
              {field(t('col_created_at'), detail.created_at?.slice(0, 10))}
              {field(t('detail_modified_by'), detail.modified_by_name)}
              {field(t('detail_modified_at'), detail.modified_at?.slice(0, 10))}
              {detail.deleted_at && field(t('detail_deleted_at'), detail.deleted_at?.slice(0, 10))}
            </div>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('cancel')}</button>
        </div>
      </div>
    </div>
  );
}

const sectionLabelSt: React.CSSProperties = { margin: '0 0 4px', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em' };
