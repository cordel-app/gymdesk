import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { resolveRequestActor } from '../domain/auditActor';
import { SlotIdentity, slotIdentityKey } from '../domain/personalTrainingSlots';
import {
  ScheduleEntryRow,
  belowFamilyMinimum,
  groupScheduleEntries,
  parseEntryMemberIds,
  parseOneSlot,
} from '../domain/scheduleEntries';
import { ownerFamilyMemberIds } from './owner-family';
import {
  bookSelectedSlots,
  describeSlotRun,
  loadProjection,
  loadSelections,
  replaceSelections,
} from './member-personal-training-slots';

/**
 * #3090 stage 5 — create, read, update and delete Professional Services
 * Schedule entries.
 *
 *   GET    /members/:memberId/personal-training-slots/entries   the family's entries
 *   POST   …/entries   { slot, member_ids? }                   add the slot to each member's pattern and book it
 *   PUT    …/entries   { previous_slot, slot, member_ids? }    move an entry to another slot and/or other members
 *   DELETE …/entries   { slot }                                remove the slot from every family member holding it
 *
 * An entry is a slot identity plus the family members whose
 * `member_recurring_slots` hold it (`domain/scheduleEntries.ts`). Nothing new is
 * stored or decided: the pattern is written through `replaceSelections()`, every
 * date is booked through `bookSelectedSlots()` → `bookMemberOnSession()`, and
 * the nightly rolling window (`POST /recurring-bookings/run`) keeps booking from
 * the same rows. Editing or deleting an entry changes future generation only:
 * bookings already made are kept, as unticking a slot in the grid always did
 * (#647 §5), and are cancelled through the normal booking actions.
 *
 * Every write is validated for every member before anything is written (family
 * membership, the `family_only` minimum, the slot being offered to that member),
 * so a refused request changes nothing.
 */
export const memberScheduleEntriesRouter = Router({ mergeParams: true });

function parseMemberId(req: { params: unknown }): number | null {
  const memberId = parseInt((req.params as { memberId: string }).memberId, 10);
  return Number.isInteger(memberId) && memberId > 0 ? memberId : null;
}

async function findMember(gymId: string, memberId: number): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [memberId, gymId],
  );
  return rows.length > 0;
}

/** The family's stored weekly slots, with the names the list shows. */
async function loadEntries(gymId: string, familyIds: number[]) {
  const marks = familyIds.map(() => '?').join(',');
  const { rows } = await db.query<ScheduleEntryRow & { start_time: string; end_time: string }>(
    `SELECT mrs.id AS selection_id, mrs.member_id, m.name AS member_name,
            mrs.iso_weekday AS weekday, mrs.start_time, mrs.end_time,
            mrs.activity_type_id, at.name AS activity_type_name,
            mrs.professional_service_id, ps.name AS professional_service_name,
            mrs.center_id, c.name AS center_name
       FROM member_recurring_slots mrs
       JOIN members m ON m.id = mrs.member_id AND m.deleted_at IS NULL
       JOIN activity_types at ON at.id = mrs.activity_type_id
       JOIN professional_services ps ON ps.id = mrs.professional_service_id
       LEFT JOIN centers c ON c.id = mrs.center_id
      WHERE mrs.gym_id = ? AND mrs.member_id IN (${marks})`,
    [gymId, ...familyIds],
  );
  return groupScheduleEntries(rows.map((r) => ({
    ...r,
    selection_id: Number(r.selection_id),
    member_id: Number(r.member_id),
    weekday: Number(r.weekday),
    start_time: String(r.start_time).slice(0, 5),
    end_time: String(r.end_time).slice(0, 5),
    activity_type_id: Number(r.activity_type_id),
    professional_service_id: Number(r.professional_service_id),
    center_id: r.center_id == null ? null : Number(r.center_id),
  })));
}

type Refusal = { status: number; body: Record<string, unknown> };

/**
 * Judges the members of an entry for `slot`: all of the card member's family,
 * enough for a `family_only` service, and the slot offered to each of them.
 */
async function judgeMembers(
  gymId: string, familyIds: number[], memberIds: number[], slot: SlotIdentity,
): Promise<Refusal | null> {
  const family = new Set(familyIds);
  const outsider = memberIds.find((id) => !family.has(id));
  if (outsider !== undefined) {
    return { status: 400, body: { error: 'Member is not part of this family', code: 'member_not_in_family', member_id: outsider } };
  }

  const { rows } = await db.query<{ booking_type: string | null; min_participants: number | null }>(
    `SELECT ps.booking_type, ps.min_participants FROM professional_services ps
      WHERE ps.id = ? AND (ps.gym_id IS NULL OR ps.gym_id = ?)`,
    [slot.professional_service_id, gymId],
  );
  const min = belowFamilyMinimum(rows[0] ?? null, memberIds.length);
  if (min !== null) {
    return {
      status: 400,
      body: { error: 'This service needs more participants from the family', code: 'participants_below_minimum', min_participants: min },
    };
  }

  const key = slotIdentityKey(slot);
  for (const id of memberIds) {
    const { days } = await loadProjection(gymId, id, await loadSelections(gymId, id));
    const offered = days.some((d) => d.slots.some((s) => slotIdentityKey(s) === key));
    if (!offered) {
      return {
        status: 400,
        body: { error: 'This slot is not available for the member in the current window', code: 'slot_not_available', member_id: id, slot },
      };
    }
  }
  return null;
}

/** Removes `slot` from each member's stored pattern; bookings are not touched. */
async function removeSlot(gymId: string, memberIds: number[], slot: SlotIdentity, actor: string | null) {
  const key = slotIdentityKey(slot);
  for (const id of memberIds) {
    const current = await loadSelections(gymId, id);
    const wanted = current.filter((s) => slotIdentityKey(s) !== key);
    if (wanted.length !== current.length) await replaceSelections(gymId, id, wanted, current, actor);
  }
}

/** Adds `slot` to each member's stored pattern and books the window for it. */
async function addAndBook(gymId: string, memberIds: number[], slot: SlotIdentity, actor: string | null) {
  const key = slotIdentityKey(slot);
  const members: Array<Record<string, unknown>> = [];
  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const id of memberIds) {
    const current = await loadSelections(gymId, id);
    if (!current.some((s) => slotIdentityKey(s) === key)) {
      await replaceSelections(gymId, id, [...current, slot], current, actor);
    }
    const projection = await loadProjection(gymId, id, await loadSelections(gymId, id));
    const run = await bookSelectedSlots(gymId, id, [slot], projection.days, actor);
    created += run.created;
    skipped += run.skipped;
    failed += run.failed;
    members.push({ member_id: id, created: run.created, skipped: run.skipped, failed: run.failed, slots: describeSlotRun(run.slots) });
  }
  return { created, skipped, failed, members };
}

memberScheduleEntriesRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const memberId = parseMemberId(req);
  if (memberId === null) return res.status(400).json({ error: 'memberId must be a positive integer' });
  try {
    if (!(await findMember(gymId, memberId))) return res.status(404).json({ error: 'Member not found' });
    const familyIds = await ownerFamilyMemberIds(db, gymId, memberId);
    res.json({ entries: await loadEntries(gymId, familyIds) });
  } catch (err) { next(err); }
});

memberScheduleEntriesRouter.post('/', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const memberId = parseMemberId(req);
  if (memberId === null) return res.status(400).json({ error: 'memberId must be a positive integer' });
  const body = (req.body ?? {}) as { slot?: unknown; member_ids?: unknown };
  const slot = parseOneSlot(body.slot, 'slot');
  if ('error' in slot) return res.status(400).json({ error: slot.error });
  const ids = parseEntryMemberIds(body.member_ids, memberId);
  if ('error' in ids) return res.status(400).json({ error: ids.error });

  try {
    if (!(await findMember(gymId, memberId))) return res.status(404).json({ error: 'Member not found' });
    const familyIds = await ownerFamilyMemberIds(db, gymId, memberId);
    const refusal = await judgeMembers(gymId, familyIds, ids.ids, slot.slot);
    if (refusal) return res.status(refusal.status).json(refusal.body);

    const run = await addAndBook(gymId, ids.ids, slot.slot, resolveRequestActor(getTenantContext(req)));
    recordAudit(req, {
      action: 'create_schedule_entry',
      entityType: 'member',
      entityId: String(memberId),
      next: { slot: slotIdentityKey(slot.slot), member_ids: ids.ids, created: run.created },
    });
    res.status(201).json({ ...run, entries: await loadEntries(gymId, familyIds) });
  } catch (err) { next(err); }
});

memberScheduleEntriesRouter.put('/', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const memberId = parseMemberId(req);
  if (memberId === null) return res.status(400).json({ error: 'memberId must be a positive integer' });
  const body = (req.body ?? {}) as { previous_slot?: unknown; slot?: unknown; member_ids?: unknown };
  const previous = parseOneSlot(body.previous_slot, 'previous_slot');
  if ('error' in previous) return res.status(400).json({ error: previous.error });
  const slot = parseOneSlot(body.slot, 'slot');
  if ('error' in slot) return res.status(400).json({ error: slot.error });
  const ids = parseEntryMemberIds(body.member_ids, memberId);
  if ('error' in ids) return res.status(400).json({ error: ids.error });

  try {
    if (!(await findMember(gymId, memberId))) return res.status(404).json({ error: 'Member not found' });
    const familyIds = await ownerFamilyMemberIds(db, gymId, memberId);
    const before = await loadEntries(gymId, familyIds);
    const prevKey = slotIdentityKey(previous.slot);
    const entry = before.find((e) => slotIdentityKey(e) === prevKey);
    if (!entry) return res.status(404).json({ error: 'Schedule entry not found', code: 'entry_not_found' });

    const refusal = await judgeMembers(gymId, familyIds, ids.ids, slot.slot);
    if (refusal) return res.status(refusal.status).json(refusal.body);

    const actor = resolveRequestActor(getTenantContext(req));
    const sameSlot = prevKey === slotIdentityKey(slot.slot);
    // The previous slot leaves every member who held it, except — when the slot
    // is unchanged — those who stay on the entry (their row and created_at are kept).
    const leaving = entry.members
      .map((m) => m.member_id)
      .filter((id) => !(sameSlot && ids.ids.includes(id)));
    await removeSlot(gymId, leaving, previous.slot, actor);
    const run = await addAndBook(gymId, ids.ids, slot.slot, actor);

    recordAudit(req, {
      action: 'update_schedule_entry',
      entityType: 'member',
      entityId: String(memberId),
      previous: { slot: prevKey, member_ids: entry.members.map((m) => m.member_id) },
      next: { slot: slotIdentityKey(slot.slot), member_ids: ids.ids, created: run.created },
    });
    res.json({ ...run, entries: await loadEntries(gymId, familyIds) });
  } catch (err) { next(err); }
});

memberScheduleEntriesRouter.delete('/', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const memberId = parseMemberId(req);
  if (memberId === null) return res.status(400).json({ error: 'memberId must be a positive integer' });
  const slot = parseOneSlot(((req.body ?? {}) as { slot?: unknown }).slot, 'slot');
  if ('error' in slot) return res.status(400).json({ error: slot.error });

  try {
    if (!(await findMember(gymId, memberId))) return res.status(404).json({ error: 'Member not found' });
    const familyIds = await ownerFamilyMemberIds(db, gymId, memberId);
    const key = slotIdentityKey(slot.slot);
    const entry = (await loadEntries(gymId, familyIds)).find((e) => slotIdentityKey(e) === key);
    if (!entry) return res.status(404).json({ error: 'Schedule entry not found', code: 'entry_not_found' });

    const memberIds = entry.members.map((m) => m.member_id);
    await removeSlot(gymId, memberIds, slot.slot, resolveRequestActor(getTenantContext(req)));
    recordAudit(req, {
      action: 'delete_schedule_entry',
      entityType: 'member',
      entityId: String(memberId),
      previous: { slot: key, member_ids: memberIds },
    });
    res.json({ entries: await loadEntries(gymId, familyIds) });
  } catch (err) { next(err); }
});
