// #3485: Cancel discards every change of a Workout Template's edit session.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let gymBId: string;
let exerciseId: number;

const as = (gym: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym });
const api = {
  post: (path: string, gym = gymId) => request.post(path).set(as(gym)),
  put: (path: string, gym = gymId) => request.put(path).set(as(gym)),
  del: (path: string, gym = gymId) => request.delete(path).set(as(gym)),
  get: (path: string, gym = gymId) => request.get(path).set(as(gym)),
};

async function createTemplate(name: string): Promise<number> {
  const res = await api.post('/workout-templates').send({ name });
  expect(res.status).toBe(201);
  return res.body.id;
}

/** Every block and exercise row of the template, as stored. */
async function rows(tplId: number) {
  const { rows: blocks } = await db.query(
    'SELECT * FROM workout_template_blocks WHERE workout_template_id = ? ORDER BY id', [tplId],
  );
  const { rows: exercises } = await db.query(
    `SELECT wte.* FROM workout_template_exercises wte
       JOIN workout_template_blocks b ON b.id = wte.workout_template_block_id
      WHERE b.workout_template_id = ? ORDER BY wte.id`,
    [tplId],
  );
  return { blocks, exercises };
}

beforeAll(async () => {
  gymId = await createTestGym('WT Edit Session Gym');
  gymBId = await createTestGym('WT Edit Session Gym B');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(gymBId, 'admin');
  const { insertId } = await db.query(
    "INSERT INTO exercises (gym_id, name, slug, status) VALUES (?, 'Edit Session Squat', 'edit-session-squat', 'active')",
    [gymId],
  );
  exerciseId = Number(insertId);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('edit session', () => {
  it('Cancel restores the blocks and exercises exactly as they were when Edit mode was entered', async () => {
    const tplId = await createTemplate('Edit Session Cancel');
    const b1 = await api.post(`/workout-templates/${tplId}/blocks`).send({ type: 'Standard', name: 'Warm-up' });
    const b2 = await api.post(`/workout-templates/${tplId}/blocks`).send({ type: 'Circuit', name: 'Finisher', rounds: 3 });
    const ex = await api.post(`/workout-templates/${tplId}/blocks/${b1.body.id}/exercises`)
      .send({ exercise_id: exerciseId, sets: 3, min_reps: 8, max_reps: 12 });
    expect(ex.status).toBe(201);
    const before = await rows(tplId);

    expect((await api.post(`/workout-templates/${tplId}/edit-session`)).status).toBe(204);

    // Every kind of change the tree persists at once: edit, add, delete, reorder.
    await api.put(`/workout-templates/${tplId}/blocks/${b1.body.id}/exercises/${ex.body.id}`)
      .send({ exercise_id: exerciseId, sets: 5, min_reps: 1, max_reps: 2 });
    await api.put(`/workout-templates/${tplId}/blocks/${b2.body.id}`).send({ type: 'AMRAP', name: 'Changed' });
    await api.post(`/workout-templates/${tplId}/blocks`).send({ type: 'Standard', name: 'Added' });
    await api.put(`/workout-templates/${tplId}/blocks/reorder`).send({ order: [b2.body.id, b1.body.id] });
    await api.del(`/workout-templates/${tplId}/blocks/${b1.body.id}`);
    expect(await rows(tplId)).not.toEqual(before);

    expect((await api.post(`/workout-templates/${tplId}/edit-session/cancel`)).status).toBe(204);
    expect(await rows(tplId)).toEqual(before);

    const { rows: cps } = await db.query('SELECT 1 FROM workout_template_edit_checkpoints WHERE workout_template_id = ?', [tplId]);
    expect(cps).toHaveLength(0);
    const { rows: audit } = await db.query(
      "SELECT 1 FROM audit_logs WHERE entity_type = 'workout_template' AND entity_id = ? AND action = 'discard_edits'",
      [String(tplId)],
    );
    expect(audit.length).toBeGreaterThan(0);
  });

  it('Save keeps the changes and drops the checkpoint', async () => {
    const tplId = await createTemplate('Edit Session Save');
    expect((await api.post(`/workout-templates/${tplId}/edit-session`)).status).toBe(204);
    await api.post(`/workout-templates/${tplId}/blocks`).send({ type: 'Standard', name: 'Kept' });
    expect((await api.del(`/workout-templates/${tplId}/edit-session`)).status).toBe(204);

    const after = await rows(tplId);
    expect(after.blocks.map((b: any) => b.name)).toEqual(['Kept']);
    expect((await api.post(`/workout-templates/${tplId}/edit-session/cancel`)).status).toBe(409);
  });

  it('re-entering Edit mode replaces the checkpoint with the content as it stands', async () => {
    const tplId = await createTemplate('Edit Session Reentry');
    await api.post(`/workout-templates/${tplId}/edit-session`);
    await api.post(`/workout-templates/${tplId}/blocks`).send({ type: 'Standard', name: 'First session' });
    await api.post(`/workout-templates/${tplId}/edit-session`);
    await api.post(`/workout-templates/${tplId}/blocks`).send({ type: 'Standard', name: 'Second session' });
    await api.post(`/workout-templates/${tplId}/edit-session/cancel`);
    expect((await rows(tplId)).blocks.map((b: any) => b.name)).toEqual(['First session']);
  });

  it('refuses a cross-template block move while either template is in Edit mode', async () => {
    const src = await createTemplate('Edit Session Move Source');
    const tgt = await createTemplate('Edit Session Move Target');
    const block = await api.post(`/workout-templates/${src}/blocks`).send({ type: 'Standard' });
    await api.post(`/workout-templates/${src}/edit-session`);
    const res = await api.put(`/workout-templates/${src}/blocks/${block.body.id}/move`).send({ target_workout_template_id: tgt });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('edit_session_open');
    await api.del(`/workout-templates/${src}/edit-session`);
    const ok = await api.put(`/workout-templates/${src}/blocks/${block.body.id}/move`).send({ target_workout_template_id: tgt });
    expect(ok.status).toBe(200);
  });

  it('is tenant-scoped: another gym cannot open, cancel or close the session', async () => {
    const tplId = await createTemplate('Edit Session Tenant');
    expect((await api.post(`/workout-templates/${tplId}/edit-session`, gymBId)).status).toBe(404);
    await api.post(`/workout-templates/${tplId}/edit-session`);
    expect((await api.post(`/workout-templates/${tplId}/edit-session/cancel`, gymBId)).status).toBe(404);
    expect((await api.del(`/workout-templates/${tplId}/edit-session`, gymBId)).status).toBe(404);
  });

  it('requires authentication', async () => {
    const tplId = await createTemplate('Edit Session Auth');
    const res = await request.post(`/workout-templates/${tplId}/edit-session`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });
});
