'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';

interface ClassType { id: number; name: string }

/**
 * P2.7: multi-select of class types this plan grants access to.
 * An empty selection means the plan grants no restricted-type access — it
 * doesn't hide the class from anyone; class types with NO plan mappings
 * remain open to all members.
 */
export function PlanClassTypesModal({ planId, planName, onClose }: { planId: number; planName: string; onClose: () => void }) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const [classTypes, setClassTypes] = useState<ClassType[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [all, mine] = await Promise.all([
        apiFetch<ClassType[]>('/class-types'),
        apiFetch<ClassType[]>(`/membership-plans/${planId}/class-types`),
      ]);
      setClassTypes(all);
      setSelected(new Set(mine.map((c) => c.id)));
    } catch (err: any) { toast(err.message ?? t('plans.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [planId]);

  async function save() {
    setSaving(true);
    try {
      await apiFetch(`/membership-plans/${planId}/class-types`, {
        method: 'PUT', body: JSON.stringify({ class_type_ids: Array.from(selected) }),
      });
      onClose();
    } catch (err: any) { toast(err.message ?? t('plans.error_generic')); }
    finally { setSaving(false); }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 480 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('plans.class_access_title')}</h2>
        <p style={{ margin: '0 0 16px', color: '#666', fontSize: 14 }}>{planName}</p>

        {loading ? (
          <p style={{ color: '#666' }}>{t('plans.loading')}</p>
        ) : classTypes.length === 0 ? (
          <p style={{ color: '#666' }}>{t('plans.class_access_empty')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 300, overflowY: 'auto' }}>
            {classTypes.map((ct) => (
              <label key={ct.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                <input type="checkbox" checked={selected.has(ct.id)}
                       onChange={(e) => {
                         const next = new Set(selected);
                         if (e.target.checked) next.add(ct.id); else next.delete(ct.id);
                         setSelected(next);
                       }} />
                {ct.name}
              </label>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnStyle('#aaa')} disabled={saving}>{t('plans.cancel')}</button>
          <button onClick={save} style={btnStyle('#6c63ff')} disabled={saving || loading}>
            {saving ? t('plans.saving') : t('plans.save_changes')}
          </button>
        </div>
      </div>
    </div>
  );
}
