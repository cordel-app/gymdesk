'use client';

/**
 * #2609 stage 3 — the family member each unit of the plan's Individual Products is for.
 *
 * Read-only outside the card's Edit mode (#797): one line per Product, the members its
 * units go to. Inside it, and only while the assignment is a Draft ("before confirming
 * the plan"), each unit is a select over the owner and their family; Save sends only the
 * lines that changed. The default distribution, the eligibility and the validation are
 * the server's; this component draws and submits.
 */

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { CardSection } from '@/components/CardSection';
import { SectionEditButton } from '@/components/SectionEditButton';
import { primaryBtnSmall } from '@/components/ui';
import {
  formControlStyle, formErrorStyle, formHelpTextStyle, formValueStyle, inlineActionsRowStyle, secondaryBtnSmall,
} from '@/components/formChrome';
import {
  changedUnitLines, showsUnitAssignees, unitAssigneeLines, unitLineKey,
} from '@/lib/planUnitAssignees';
import type { AssignedPlanSnapshot } from './types';

interface Option { member_id: number; name: string }

export function PlanUnitAssignees({
  assignedPlanId, snapshot, cardEditing, canWrite, readOnlyTitle, onChanged,
}: {
  assignedPlanId: number;
  snapshot: AssignedPlanSnapshot;
  cardEditing: boolean;
  canWrite: boolean;
  readOnlyTitle?: string;
  onChanged: () => void;
}) {
  const t = useTranslations('assigned_plans_page');
  const { apiFetch } = useApiClient();
  const lines = unitAssigneeLines(snapshot);
  const [options, setOptions] = useState<Option[]>([]);
  const [editable, setEditable] = useState(false);
  const [draft, setDraft] = useState<Record<string, number[]> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (lines.length === 0) return;
    apiFetch<{ editable: boolean; eligible: Option[] }>(`/user-memberships/${assignedPlanId}/benefit-assignees`)
      .then((r) => { if (alive) { setOptions(r.eligible); setEditable(r.editable); } })
      .catch(() => { if (alive) setOptions([]); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignedPlanId, lines.length]);

  useEffect(() => { if (!cardEditing) { setDraft(null); setError(null); } }, [cardEditing]);

  if (!showsUnitAssignees(lines, options.length)) return null;

  const canEdit = cardEditing && canWrite && editable;

  function open() {
    setError(null);
    setDraft(Object.fromEntries(lines.map((l) => [unitLineKey(l), [...l.assignees]])));
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      for (const l of changedUnitLines(lines, draft)) {
        await apiFetch(`/user-memberships/${assignedPlanId}/benefit-assignees`, {
          method: 'PUT',
          body: JSON.stringify({ section: l.section, product_id: l.product_id, assignees: l.assignees }),
        });
      }
      setDraft(null);
      onChanged();
    } catch (err: any) {
      setError(err?.body?.message ?? err?.body?.error ?? err?.message ?? t('unit_assignees_save_error'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <CardSection
      label={t('unit_assignees_title')}
      action={canEdit && !draft
        ? <SectionEditButton label={t('action_edit')} onClick={open} title={canWrite ? undefined : readOnlyTitle} />
        : null}
    >
      {lines.map((l) => (
        <div key={unitLineKey(l)} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, margin: '6px 0' }}>
          <span style={{ ...formValueStyle, fontWeight: 600, minWidth: 160 }}>{l.item_name}</span>
          {draft
            ? (draft[unitLineKey(l)] ?? l.assignees).map((memberId, i) => (
              <select
                key={i}
                aria-label={t('unit_assignees_unit_label', { product: l.item_name, unit: i + 1 })}
                value={memberId}
                disabled={saving}
                style={{ ...formControlStyle, width: 'auto' }}
                onChange={(e) => {
                  const next = [...(draft[unitLineKey(l)] ?? l.assignees)];
                  next[i] = Number(e.target.value);
                  setDraft({ ...draft, [unitLineKey(l)]: next });
                }}
              >
                {options.map((o) => <option key={o.member_id} value={o.member_id}>{o.name}</option>)}
              </select>
            ))
            : <span style={formValueStyle}>{l.names.join(', ')}</span>}
        </div>
      ))}
      {draft && (
        <>
          <p style={formHelpTextStyle}>{t('unit_assignees_hint')}</p>
          {error && <p style={formErrorStyle}>{error}</p>}
          <div style={inlineActionsRowStyle}>
            <button type="button" onClick={() => { setDraft(null); setError(null); }} disabled={saving} style={secondaryBtnSmall}>{t('cancel')}</button>
            <button type="button" onClick={save} disabled={saving} style={primaryBtnSmall()}>
              {saving ? t('saving') : t('save_changes')}
            </button>
          </div>
        </>
      )}
    </CardSection>
  );
}
