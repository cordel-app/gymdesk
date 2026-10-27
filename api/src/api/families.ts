import { Router, Request, Response, NextFunction } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { resolveRequestActor } from '../domain/auditActor';

/**
 * #2123 stage 1: Family, a first-class entity independent of Product Sets. Mounted at
 * /members/:memberId/family (mergeParams) — `:memberId` is any member of the family, or
 * the member a family is being created for. A member belongs to at most one family; a
 * family has exactly one owner (UNIQUE `owner_key` + the transactional checks here).
 * Nothing in stage 1 changes who pays: the owner is reported as the future payer only.
 */
export const familiesRouter = Router({ mergeParams: true });

class FamilyError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

type Q = Pick<Tx, 'query'> | typeof db;

async function loadMember(q: Q, gymId: string, memberId: unknown) {
  const id = Number(memberId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { rows } = await q.query<{ id: number; name: string; email: string }>(
    'SELECT id, name, email FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL', [id, gymId]);
  return rows[0] ?? null;
}

async function familyOf(q: Q, gymId: string, memberId: number, lock = false) {
  const { rows } = await q.query<{ family_id: number }>(
    'SELECT family_id FROM family_members WHERE member_id = ? AND gym_id = ?', [memberId, gymId]);
  if (rows.length === 0) return null;
  const familyId = rows[0].family_id;
  const { rows: fam } = await q.query<{ id: number; name: string }>(
    `SELECT id, name FROM families WHERE id = ? AND gym_id = ?${lock ? ' FOR UPDATE' : ''}`, [familyId, gymId]);
  return fam[0] ?? null;
}

async function shape(q: Q, gymId: string, family: { id: number; name: string }) {
  const { rows: members } = await q.query<{ member_id: number; name: string; email: string; is_owner: number }>(
    `SELECT fm.member_id, m.name, m.email, fm.is_owner
       FROM family_members fm JOIN members m ON m.id = fm.member_id
      WHERE fm.family_id = ? AND fm.gym_id = ?
      ORDER BY fm.is_owner DESC, m.name ASC`, [family.id, gymId]);
  const owner = members.find((m) => m.is_owner === 1) ?? null;
  return {
    id: family.id,
    name: family.name,
    owner_member_id: owner?.member_id ?? null,
    // The owner is the payer of family purchases once payer resolution lands (stage 2).
    payer_member_id: owner?.member_id ?? null,
    members: members.map((m) => ({ member_id: m.member_id, name: m.name, email: m.email, is_owner: m.is_owner === 1 })),
  };
}

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try { await fn(req, res); } catch (err) {
      if (err instanceof FamilyError) return res.status(err.status).json({ error: err.message, code: err.code });
      next(err);
    }
  };
}

familiesRouter.get('/', handle(async (req, res) => {
  const { gymId } = getTenantContext(req);
  const member = await loadMember(db, gymId, (req.params as any).memberId);
  if (!member) throw new FamilyError(404, 'member_not_found', 'Member not found');
  const family = await familyOf(db, gymId, member.id);
  res.json({ family: family ? await shape(db, gymId, family) : null });
}));

familiesRouter.post('/', requireModuleWrite('MEMBERS'), handle(async (req, res) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const rawName = (req.body as any)?.name;
  if (rawName != null && (typeof rawName !== 'string' || rawName.length > 255)) {
    throw new FamilyError(400, 'invalid_name', 'name must be a string of at most 255 characters');
  }
  const out = await db.transaction(async (tx) => {
    const member = await loadMember(tx, gymId, (req.params as any).memberId);
    if (!member) throw new FamilyError(404, 'member_not_found', 'Member not found');
    if (await familyOf(tx, gymId, member.id)) {
      throw new FamilyError(409, 'already_in_family', 'The member already belongs to a family');
    }
    const name = (typeof rawName === 'string' && rawName.trim()) || member.name;
    const fam = await tx.query('INSERT INTO families (gym_id, name, created_by) VALUES (?, ?, ?)', [gymId, name, actor]);
    await tx.query(
      'INSERT INTO family_members (gym_id, family_id, member_id, is_owner, created_by) VALUES (?, ?, ?, 1, ?)',
      [gymId, fam.insertId, member.id, actor]);
    return shape(tx, gymId, { id: fam.insertId, name });
  });
  recordAudit(req, { action: 'create', entityType: 'family', entityId: out.id, next: out });
  res.status(201).json({ family: out });
}));

familiesRouter.put('/', requireModuleWrite('MEMBERS'), handle(async (req, res) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const name = (req.body as any)?.name;
  if (typeof name !== 'string' || !name.trim() || name.length > 255) {
    throw new FamilyError(400, 'invalid_name', 'name is required (at most 255 characters)');
  }
  const { previous, next } = await db.transaction(async (tx) => {
    const family = await familyOf(tx, gymId, Number((req.params as any).memberId), true);
    if (!family) throw new FamilyError(404, 'family_not_found', 'The member does not belong to a family');
    const prev = await shape(tx, gymId, family);
    await tx.query('UPDATE families SET name = ?, modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ? AND gym_id = ?',
      [name.trim(), actor, family.id, gymId]);
    return { previous: prev, next: await shape(tx, gymId, { id: family.id, name: name.trim() }) };
  });
  recordAudit(req, { action: 'update', entityType: 'family', entityId: next.id, previous, next });
  res.json({ family: next });
}));

familiesRouter.post('/members', requireModuleWrite('MEMBERS'), handle(async (req, res) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { previous, next } = await db.transaction(async (tx) => {
    const family = await familyOf(tx, gymId, Number((req.params as any).memberId), true);
    if (!family) throw new FamilyError(404, 'family_not_found', 'The member does not belong to a family');
    const added = await loadMember(tx, gymId, (req.body as any)?.member_id);
    if (!added) throw new FamilyError(404, 'member_not_found', 'Member not found');
    if (await familyOf(tx, gymId, added.id)) {
      throw new FamilyError(409, 'already_in_family', 'The member already belongs to a family');
    }
    const prev = await shape(tx, gymId, family);
    await tx.query(
      'INSERT INTO family_members (gym_id, family_id, member_id, is_owner, created_by) VALUES (?, ?, ?, 0, ?)',
      [gymId, family.id, added.id, actor]);
    await tx.query('UPDATE families SET modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ? AND gym_id = ?',
      [actor, family.id, gymId]);
    return { previous: prev, next: await shape(tx, gymId, family) };
  });
  recordAudit(req, { action: 'add_member', entityType: 'family', entityId: next.id, previous, next });
  res.status(201).json({ family: next });
}));

familiesRouter.put('/owner', requireModuleWrite('MEMBERS'), handle(async (req, res) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { previous, next } = await db.transaction(async (tx) => {
    const family = await familyOf(tx, gymId, Number((req.params as any).memberId), true);
    if (!family) throw new FamilyError(404, 'family_not_found', 'The member does not belong to a family');
    const prev = await shape(tx, gymId, family);
    const newOwnerId = Number((req.body as any)?.member_id);
    if (!prev.members.some((m) => m.member_id === newOwnerId)) {
      throw new FamilyError(400, 'not_a_family_member', 'The new owner must be a member of the family');
    }
    if (prev.owner_member_id !== newOwnerId) {
      // Two statements inside the transaction: clear first so the one-owner key never collides.
      // No stored card, billing event or payment record moves with the ownership.
      await tx.query('UPDATE family_members SET is_owner = 0 WHERE family_id = ? AND gym_id = ?', [family.id, gymId]);
      await tx.query('UPDATE family_members SET is_owner = 1 WHERE family_id = ? AND gym_id = ? AND member_id = ?',
        [family.id, gymId, newOwnerId]);
      await tx.query('UPDATE families SET modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ? AND gym_id = ?',
        [actor, family.id, gymId]);
    }
    return { previous: prev, next: await shape(tx, gymId, family) };
  });
  recordAudit(req, { action: 'change_owner', entityType: 'family', entityId: next.id, previous, next });
  res.json({ family: next });
}));

familiesRouter.delete('/members/:otherId', requireModuleWrite('MEMBERS'), handle(async (req, res) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const out = await db.transaction(async (tx) => {
    const family = await familyOf(tx, gymId, Number((req.params as any).memberId), true);
    if (!family) throw new FamilyError(404, 'family_not_found', 'The member does not belong to a family');
    const prev = await shape(tx, gymId, family);
    const otherId = Number((req.params as any).otherId);
    const target = prev.members.find((m) => m.member_id === otherId);
    if (!target) throw new FamilyError(404, 'not_a_family_member', 'The member does not belong to this family');
    if (target.is_owner && prev.members.length > 1) {
      throw new FamilyError(409, 'owner_cannot_be_removed',
        'Change the family owner before removing the current owner, or dissolve the family');
    }
    if (prev.members.length === 1) {
      await tx.query('DELETE FROM families WHERE id = ? AND gym_id = ?', [family.id, gymId]);
      return { previous: prev, next: null, dissolved: true, id: family.id };
    }
    await tx.query('DELETE FROM family_members WHERE family_id = ? AND gym_id = ? AND member_id = ?', [family.id, gymId, otherId]);
    await tx.query('UPDATE families SET modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ? AND gym_id = ?',
      [actor, family.id, gymId]);
    return { previous: prev, next: await shape(tx, gymId, family), dissolved: false, id: family.id };
  });
  recordAudit(req, { action: out.dissolved ? 'dissolve' : 'remove_member', entityType: 'family', entityId: out.id, previous: out.previous, next: out.next });
  res.json({ family: out.next });
}));

familiesRouter.delete('/', requireModuleWrite('MEMBERS'), handle(async (req, res) => {
  const { gymId } = getTenantContext(req);
  const out = await db.transaction(async (tx) => {
    const family = await familyOf(tx, gymId, Number((req.params as any).memberId), true);
    if (!family) throw new FamilyError(404, 'family_not_found', 'The member does not belong to a family');
    const prev = await shape(tx, gymId, family);
    // Stage 1 has no financial link to a family; stage 4 refuses this while obligations exist.
    await tx.query('DELETE FROM families WHERE id = ? AND gym_id = ?', [family.id, gymId]);
    return prev;
  });
  recordAudit(req, { action: 'dissolve', entityType: 'family', entityId: out.id, previous: out });
  res.status(204).end();
}));
