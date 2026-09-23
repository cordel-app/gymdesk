// #709 part 2: the Clerk `user.deleted` webhook removes every Gymdesk link to
// the deleted account. Signature verification is mocked; the rest is real.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

vi.mock('@clerk/backend/webhooks', () => ({
  verifyWebhook: vi.fn(async (req: Request) => JSON.parse(await req.text())),
}));

const RUN = `whdel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const uid = (tag: string) => `${RUN}-${tag}`;
const saved = process.env.CLERK_WEBHOOK_SIGNING_SECRET;

let gymA: string;
let gymB: string;

beforeAll(async () => {
  process.env.CLERK_WEBHOOK_SIGNING_SECRET = 'whsec_test';
  gymA = await createTestGym('Webhook Delete Gym A');
  gymB = await createTestGym('Webhook Delete Gym B');
});

afterAll(async () => {
  if (saved === undefined) delete process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  else process.env.CLERK_WEBHOOK_SIGNING_SECRET = saved;
  await db.query("DELETE FROM audit_logs WHERE entity_type = 'clerk_account' AND entity_id LIKE ?", [`${RUN}%`]);
  await cleanupTestGyms();
  await db.end();
});

const deliver = (type: string, id: string) =>
  request.post('/webhooks/clerk')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ type, data: { id, object: 'user', deleted: true } }));

describe('POST /webhooks/clerk — user.deleted (#709)', () => {
  it('removes the account\'s gym_memberships in every gym and unlinks its member rows', async () => {
    const id = uid('multi');
    await createTestMembership(gymA, 'member', id);
    await createTestMembership(gymB, 'front_desk', id);
    const { insertId } = await db.query(
      'INSERT INTO members (name, email, gym_id, clerk_user_id) VALUES (?, ?, ?, ?)',
      ['Web Deleted', `${id}@whdel.test`, gymA, id],
    );

    const res = await deliver('user.deleted', id);

    expect(res.status).toBe(200);
    const { rows: gm } = await db.query('SELECT id FROM gym_memberships WHERE user_id = ?', [id]);
    expect(gm).toHaveLength(0);
    const { rows: m } = await db.query<any>('SELECT clerk_user_id, deleted_at FROM members WHERE id = ?', [insertId]);
    expect(m[0]).toEqual({ clerk_user_id: null, deleted_at: null }); // kept, just unlinked
    await new Promise((r) => setTimeout(r, 50));
    const { rows: audit } = await db.query<any>(
      "SELECT gym_id, source, actor_name FROM audit_logs WHERE entity_type = 'clerk_account' AND entity_id = ?", [id],
    );
    expect(audit).toEqual([{ gym_id: null, source: 'system', actor_name: 'Clerk (user.deleted)' }]);
  });

  it('a second delivery of the same event is a 200 no-op (no extra audit row)', async () => {
    const id = uid('twice');
    await createTestMembership(gymA, 'member', id);

    expect((await deliver('user.deleted', id)).status).toBe(200);
    expect((await deliver('user.deleted', id)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const { rows: audit } = await db.query("SELECT id FROM audit_logs WHERE entity_type = 'clerk_account' AND entity_id = ?", [id]);
    expect(audit).toHaveLength(1);
  });

  it('an account Gymdesk never knew → 200, nothing written', async () => {
    const id = uid('unknown');
    expect((await deliver('user.deleted', id)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const { rows: audit } = await db.query("SELECT id FROM audit_logs WHERE entity_type = 'clerk_account' AND entity_id = ?", [id]);
    expect(audit).toHaveLength(0);
  });

  it('other event types leave the account\'s rows alone', async () => {
    const id = uid('updated');
    await createTestMembership(gymA, 'member', id);

    expect((await deliver('user.updated', id)).status).toBe(200);
    const { rows: gm } = await db.query('SELECT id FROM gym_memberships WHERE user_id = ?', [id]);
    expect(gm).toHaveLength(1);
  });
});
