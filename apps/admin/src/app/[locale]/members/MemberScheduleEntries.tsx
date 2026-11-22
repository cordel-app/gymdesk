'use client';

// #3090 stage 5 — the Professional Services Schedule as a list of entries the
// admin creates, edits and deletes. An entry is one weekly slot and the family
// members it is for. Everything is decided by
// /members/:memberId/personal-training-slots/entries; this file formats and
// builds requests (`scheduleEntriesView.ts`). Like the grid below it, the list
// reads until the section's Edit is pressed (#957): the `+ Add`, `Edit` and `✕`
// controls exist only in Edit mode. Since stage 6 that Edit button sits beside
// this list's title and is offered whether or not any slot exists.

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import {
  cardMutedTextStyle,
  cardSubLabelStyle,
  dashedAddBtnStyle,
  formControlStyle,
  formErrorStyle,
  formFieldLabelStyle,
  inlineActionsRowStyle,
  innerCardStyle,
  rowRemoveBtnStyle,
  secondaryBtnSmall,
} from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { cardSectionHeaderStyle } from '@/components/CardSectionHeader';
import type { FamilyMember } from './slotFamilyBooking';
import {
  canAddScheduleEntry, createEntryBody, deleteEntryBody, entryErrorKey, entrySlotKey, entrySlotOptions,
  initialEntryMembers, toggleEntryMember, updateEntryBody,
  type OfferedSlot, type ScheduleEntry,
} from './scheduleEntriesView';

interface Draft {
  /** null: a new entry; otherwise the entry being edited. */
  entry: ScheduleEntry | null;
  slotKey: string;
  memberIds: number[];
}

export function MemberScheduleEntries({
  memberId, days, family, editing, canWrite, headerAction, onChanged,
}: {
  memberId: number;
  days: { slots: OfferedSlot[] }[];
  family: FamilyMember[];
  editing: boolean;
  canWrite: boolean;
  /** #3090 stage 6: the section's Edit button, drawn beside the entries' title. */
  headerAction?: React.ReactNode;
  /** Re-reads the grid after a write, since a write books dates and changes the pattern. */
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations('members');
  const tWeekday = useTranslations('weekday');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const [entries, setEntries] = useState<ScheduleEntry[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ScheduleEntry | null>(null);

  const path = `/members/${memberId}/personal-training-slots/entries`;

  useEffect(() => {
    apiFetch<{ entries: ScheduleEntry[] }>(path)
      .then((r) => setEntries(r.entries))
      .catch(() => setEntries([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);

  // Leaving Edit mode closes an open form (#1029: no editor survives the mode).
  useEffect(() => {
    if (!editing) { setDraft(null); setError(null); }
  }, [editing]);

  // The family as the selector lists it: the card's member always among them.
  const people: FamilyMember[] = family.some((m) => m.member_id === memberId)
    ? family
    : [{ member_id: memberId, name: t('pt_entries_this_member'), is_owner: false }, ...family];

  function label(s: OfferedSlot): string {
    return [
      `${tWeekday(String(s.weekday % 7))} ${s.start_time}–${s.end_time}`,
      s.professional_service_name,
      s.activity_type_name,
      s.center_name,
    ].filter(Boolean).join(' · ');
  }

  function startAdd() {
    const first = entrySlotOptions(days)[0];
    setError(null);
    setDraft({ entry: null, slotKey: first ? entrySlotKey(first) : '', memberIds: initialEntryMembers(memberId) });
  }

  function startEdit(entry: ScheduleEntry) {
    setError(null);
    setDraft({ entry, slotKey: entrySlotKey(entry), memberIds: entry.members.map((m) => m.member_id) });
  }

  function refusal(err: unknown): string {
    const e = err as { message?: string; body?: { code?: string } };
    const key = entryErrorKey(e.body?.code);
    return key ? t(key) : (e.message || t('pt_entries_error'));
  }

  async function save() {
    if (!draft || saving) return;
    const options = entrySlotOptions(days, draft.entry);
    const slot = options.find((o) => entrySlotKey(o) === draft.slotKey);
    if (!slot) { setError(t('pt_entries_error_pick_slot')); return; }
    if (draft.memberIds.length === 0) { setError(t('pt_entries_error_pick_member')); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch<{ entries: ScheduleEntry[]; created: number }>(path, {
        method: draft.entry ? 'PUT' : 'POST',
        body: JSON.stringify(draft.entry
          ? updateEntryBody(draft.entry, slot, draft.memberIds)
          : createEntryBody(slot, draft.memberIds)),
      });
      setEntries(res.entries);
      setDraft(null);
      toast(t('pt_entries_saved', { created: res.created }), 'success');
      await onChanged();
    } catch (err) {
      setError(refusal(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(entry: ScheduleEntry) {
    if (saving) return;
    setSaving(true);
    try {
      const res = await apiFetch<{ entries: ScheduleEntry[] }>(path, {
        method: 'DELETE',
        body: JSON.stringify(deleteEntryBody(entry)),
      });
      setEntries(res.entries);
      toast(t('pt_entries_deleted'), 'success');
      await onChanged();
    } catch (err) {
      toast(refusal(err));
    } finally {
      setSaving(false);
      setDeleting(null);
    }
  }

  if (entries === null) return null;

  // An entry is one of the slots the grid offers; with none there is nothing to add.
  const canAdd = canAddScheduleEntry(days);

  const form = (current: ScheduleEntry | null) => draft && (
    <div style={formBox}>
      <label style={formFieldLabelStyle}>
        {t('pt_entries_slot')}
        <select
          style={formControlStyle}
          value={draft.slotKey}
          disabled={saving}
          onChange={(e) => setDraft({ ...draft, slotKey: e.target.value })}
        >
          {entrySlotOptions(days, current).map((o) => (
            <option key={entrySlotKey(o)} value={entrySlotKey(o)}>{label(o)}</option>
          ))}
        </select>
      </label>
      <fieldset style={fieldset}>
        <legend style={formFieldLabelStyle}>{t('pt_entries_members')}</legend>
        {people.map((m) => (
          <label key={m.member_id} style={memberRow}>
            <input
              type="checkbox"
              checked={draft.memberIds.includes(m.member_id)}
              disabled={saving}
              onChange={() => setDraft({ ...draft, memberIds: toggleEntryMember(draft.memberIds, m.member_id) })}
            />
            <span>{m.name}</span>
          </label>
        ))}
      </fieldset>
      <p style={dim}>{t('pt_entries_bookings_kept')}</p>
      {error && <p style={formErrorStyle}>{error}</p>}
      <div style={inlineActionsRowStyle}>
        <button type="button" style={primaryBtnSmall()} onClick={save} disabled={saving}>
          {saving ? t('pt_slots_booking') : t('pt_entries_save')}
        </button>
        <button type="button" style={secondaryBtnSmall} onClick={() => setDraft(null)} disabled={saving}>
          {t('pt_slots_cancel')}
        </button>
      </div>
    </div>
  );

  return (
    <div style={section}>
      <div style={cardSectionHeaderStyle}>
        <div style={{ ...cardSubLabelStyle, margin: 0 }}>{t('pt_entries_title')}</div>
        {headerAction}
      </div>
      {entries.length === 0 && !draft && <p style={dim}>{t('pt_entries_none')}</p>}
      {entries.map((entry) => {
        const key = entrySlotKey(entry);
        const isEditing = draft?.entry && entrySlotKey(draft.entry) === key;
        return (
          <div key={key} style={row}>
            {isEditing ? form(entry) : (
              <div style={rowLine}>
                <div>
                  <div style={rowTitle}>{label(entry)}</div>
                  <div style={dim}>{entry.members.map((m) => m.name).join(', ')}</div>
                </div>
                {editing && canWrite && (
                  <div style={rowActions}>
                    <button type="button" style={secondaryBtnSmall} disabled={saving || !!draft} onClick={() => startEdit(entry)}>
                      {t('pt_entries_edit')}
                    </button>
                    <button
                      type="button"
                      style={rowRemoveBtnStyle}
                      disabled={saving}
                      aria-label={t('pt_entries_delete_aria', { slot: label(entry) })}
                      onClick={() => setDeleting(entry)}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {draft && draft.entry === null && <div style={row}>{form(null)}</div>}
      {editing && canWrite && !draft && (
        <>
          <button type="button" style={dashedAddBtnStyle} onClick={startAdd} disabled={saving || !canAdd}>
            {t('pt_entries_add')}
          </button>
          {/* #3090 stage 6: say why nothing can be added rather than hide the action. */}
          {!canAdd && <p style={dim}>{t('pt_entries_no_slots')}</p>}
        </>
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={t('pt_entries_delete_title')}
        message={deleting ? label(deleting) : ''}
        question={t('pt_entries_delete_confirm')}
        confirmLabel={t('pt_entries_delete')}
        cancelLabel={t('pt_slots_cancel')}
        busy={saving}
        onConfirm={() => { if (deleting) void remove(deleting); }}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

const section: React.CSSProperties = { marginBottom: 12 };
const dim: React.CSSProperties = { ...cardMutedTextStyle, margin: '2px 0 0' };
const row: React.CSSProperties = { ...innerCardStyle, padding: '8px 10px', margin: '6px 0' };
const rowLine: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 };
const rowTitle: React.CSSProperties = { fontSize: 13, fontWeight: 600 };
const rowActions: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };
const formBox: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 };
const fieldset: React.CSSProperties = { border: 'none', padding: 0, margin: 0 };
const memberRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, padding: '2px 0' };
