'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { ActivityMetaIcon } from './ActivityMetaIcon';
import { memberTheme } from '@/lib/memberChrome';
import {
  addableMembers, canToggleParticipant, participantsValid, toggleParticipant, type FamilyMember,
} from '@/lib/familyParticipants';

/**
 * #2674 — the family members who attend a family group booking, shown inline
 * before Book. Calendar and My Bookings render this one component; the page
 * holds the selection (partner ids) and sends it as `participant_member_ids`.
 * Every family member is listed with a toggle (the owner's 2026-11-12 answer):
 * the booker first, on and locked; the others alphabetically, on as §2 seeds
 * them. Every rule is `lib/familyParticipants.ts`', and the server enforces
 * them again.
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
  const others = addableMembers(bookerId, family, []);
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
          <Toggle on disabled label={t('attends', { name: nameOf(bookerId) })} />
        </li>
        {others.map((m) => {
          const on = partnerIds.includes(m.member_id);
          const movable = canToggleParticipant(partnerIds, m.member_id, min, max);
          return (
            <li key={m.member_id} style={styles.row}>
              <span style={styles.name}>{m.name}</span>
              <Toggle
                on={on}
                disabled={!movable}
                label={t('attends', { name: m.name })}
                title={movable ? undefined : on ? t('min_reached', { min }) : t('max_reached', { max })}
                onToggle={() => onChange(toggleParticipant(bookerId, family, partnerIds, m.member_id, min, max))}
              />
            </li>
          );
        })}
      </ul>
      {!valid && (
        <p role="alert" style={styles.error}>
          {count < min ? t('below_min', { min }) : t('above_max', { max })}
        </p>
      )}
    </div>
  );
}

/** One family member's on/off switch, in the theme's primary button colour. */
function Toggle({ on, disabled, label, title, onToggle }: {
  on: boolean; disabled?: boolean; label: string; title?: string; onToggle?: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onToggle}
      style={{ ...styles.track, ...(on ? styles.trackOn : null), ...(disabled ? styles.disabled : null) }}
    >
      <span style={{ ...styles.knob, ...(on ? styles.knobOn : null) }} />
    </button>
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
  track: { position: 'relative', flex: '0 0 auto', width: 40, height: 22, padding: 0, borderRadius: 999, border: `1px solid ${memberTheme.separator}`, background: memberTheme.pageBackground, cursor: 'pointer', transition: 'background 0.15s' },
  trackOn: { background: memberTheme.primaryButton, borderColor: memberTheme.primaryButton },
  knob: { position: 'absolute', top: 2, left: 2, width: 16, height: 16, borderRadius: '50%', background: memberTheme.surface, border: `1px solid ${memberTheme.separator}`, boxSizing: 'border-box', transition: 'left 0.15s' },
  knobOn: { left: 20 },
  disabled: { opacity: 0.5, cursor: 'not-allowed' },
  error: { color: memberTheme.statusError, fontSize: 13, margin: 0 },
};
