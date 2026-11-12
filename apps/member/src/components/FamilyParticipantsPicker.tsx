'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { ActivityMetaIcon } from './ActivityMetaIcon';
import { inputStyle, memberTheme } from '@/lib/memberChrome';
import {
  addableMembers, canAddParticipant, canRemoveParticipant, participantsValid, type FamilyMember,
} from '@/lib/familyParticipants';

/**
 * #2674 — the family members who attend a family group booking, shown inline
 * before Book. Calendar and My Bookings render this one component; the page
 * holds the selection (partner ids) and sends it as `participant_member_ids`.
 * The booker is always first and cannot be removed; every rule is
 * `lib/familyParticipants.ts`', and the server enforces them again.
 */
export function FamilyParticipantsPicker({ bookerId, family, partnerIds, min, max, onChange }: {
  bookerId: number;
  family: FamilyMember[];
  partnerIds: number[];
  min: number;
  max: number;
  onChange: (next: number[]) => void;
}) {
  const t = useTranslations('family_participants');
  const nameOf = (id: number) => family.find((m) => m.member_id === id)?.name ?? `#${id}`;
  const addable = addableMembers(bookerId, family, partnerIds);
  const canAdd = canAddParticipant(partnerIds, max) && addable.length > 0;
  const canRemove = canRemoveParticipant(partnerIds, min);
  const valid = participantsValid(partnerIds, min, max);
  const count = 1 + partnerIds.length;

  return (
    <div style={styles.wrap} onClick={(e) => e.stopPropagation()}>
      <div style={styles.title}>
        <ActivityMetaIcon name="service" size={15} />
        <span>{t('title')}</span>
        <span style={styles.count}>{t('count', { n: count, min, max })}</span>
      </div>
      <ul style={styles.list} aria-label={t('title')}>
        <li style={styles.row}>
          <span style={styles.name}>{nameOf(bookerId)}</span>
          <span style={styles.chip}>{t('you')}</span>
        </li>
        {partnerIds.map((id) => (
          <li key={id} style={styles.row}>
            <span style={styles.name}>{nameOf(id)}</span>
            <button
              type="button"
              onClick={() => onChange(partnerIds.filter((p) => p !== id))}
              disabled={!canRemove}
              aria-label={t('remove', { name: nameOf(id) })}
              title={canRemove ? undefined : t('min_reached', { min })}
              style={{ ...styles.remove, ...(canRemove ? null : styles.disabled) }}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      {canAdd && (
        <select
          value=""
          aria-label={t('add')}
          onChange={(e) => { const id = Number(e.target.value); if (id) onChange([...partnerIds, id]); }}
          style={{ ...inputStyle, fontSize: 14 }}
        >
          <option value="">{t('add')}</option>
          {addable.map((m) => <option key={m.member_id} value={m.member_id}>{m.name}</option>)}
        </select>
      )}
      {!valid && (
        <p role="alert" style={styles.error}>
          {count < min ? t('below_min', { min }) : t('above_max', { max })}
        </p>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 8, margin: '10px 0' },
  title: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: memberTheme.textMuted },
  count: { marginLeft: 'auto', fontWeight: 400, color: memberTheme.textSecondary },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: 8, borderRadius: 10, border: `1px solid ${memberTheme.separator}` },
  name: { flex: 1, minWidth: 0, fontSize: 14, color: memberTheme.text, overflowWrap: 'anywhere' },
  chip: { flex: '0 0 auto', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: memberTheme.pageBackground, color: memberTheme.textSecondary, border: `1px solid ${memberTheme.separator}` },
  remove: { flex: '0 0 auto', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: memberTheme.textSecondary, padding: 4 },
  disabled: { opacity: 0.4, cursor: 'not-allowed' },
  error: { color: memberTheme.statusError, fontSize: 13, margin: 0 },
};
