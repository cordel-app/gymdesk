// Tests for themes.ts router (/platform/themes — superadmin base themes CRUD)
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  request,
} from './helpers';

let gymId: string;
let orgThemeId: string;
let baseThemeId: string;

const superadminUser = {
  publicMetadata: { platform_role: 'superadmin' },
  fullName: 'Test Admin',
  firstName: 'Test',
  lastName: 'Admin',
};

const regularUser = {
  publicMetadata: {},
  fullName: 'Test User',
  firstName: 'Test',
  lastName: 'User',
};

// The clerkClient instance is created once at module load in tenantContext.ts.
// We reach into the mocked factory's return value to swap getUser's behaviour.
function mockAsSuperadmin() {
  const client = vi.mocked(createClerkClient).mock.results[0]?.value;
  if (client) vi.mocked(client.users.getUser).mockResolvedValue(superadminUser as any);
}

function mockAsNonSuperadmin() {
  const client = vi.mocked(createClerkClient).mock.results[0]?.value;
  if (client) vi.mocked(client.users.getUser).mockResolvedValue(regularUser as any);
}

beforeAll(async () => {
  gymId = await createTestGym('ThemesTestGym');

  // Insert a custom org theme (gym_id = gymId) to test tenant isolation
  await db.query(
    `INSERT INTO themes (id, gym_id, is_system_default, name, status, tokens, created_at)
     VALUES (UUID(), ?, 0, 'Org Theme Test', 'active', '{}', UTC_TIMESTAMP())`,
    [gymId],
  );
  const { rows: orgThemeRows } = await db.query<{ id: string }>(
    "SELECT id FROM themes WHERE gym_id = ? AND name = 'Org Theme Test' LIMIT 1",
    [gymId],
  );
  orgThemeId = orgThemeRows[0].id;

  // Find an existing base theme (gym_id IS NULL) seeded by migrations
  const { rows: baseRows } = await db.query<{ id: string }>(
    'SELECT id FROM themes WHERE gym_id IS NULL AND deleted_at IS NULL LIMIT 1',
  );
  baseThemeId = baseRows[0]?.id;
});

afterAll(async () => {
  // Remove org themes before gym rows (FK order)
  await db.query(
    'DELETE FROM themes WHERE gym_id IN (SELECT id FROM gyms WHERE slug LIKE ?)',
    ['test-%'],
  );
  // Remove base themes created by these tests
  await db.query(
    "DELETE FROM themes WHERE gym_id IS NULL AND name LIKE 'Test Base Theme%'",
  );
  await cleanupTestGyms();
  await db.end();
});

// ─── Auth guard ───────────────────────────────────────────────────────────────

describe('Auth', () => {
  it('returns 401 without auth header', async () => {
    const res = await request.get('/platform/themes');
    expect(res.status).toBe(401);
  });

  it('returns 403 for authenticated non-superadmin user', async () => {
    mockAsNonSuperadmin();
    const res = await request
      .get('/platform/themes')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(403);
  });
});

// ─── GET /platform/themes ─────────────────────────────────────────────────────

describe('GET /platform/themes', () => {
  beforeAll(() => mockAsSuperadmin());

  it('returns 200 with an array of base themes', async () => {
    const res = await request
      .get('/platform/themes')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('never includes org-owned themes (gym_id != null)', async () => {
    const res = await request
      .get('/platform/themes')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    const ids = res.body.map((t: any) => t.id);
    expect(ids).not.toContain(orgThemeId);
  });

  it('all returned themes have type === "system"', async () => {
    const res = await request
      .get('/platform/themes')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    for (const theme of res.body) {
      expect(theme.type).toBe('system');
    }
  });
});

// ─── GET /platform/themes/:id ─────────────────────────────────────────────────

describe('GET /platform/themes/:id', () => {
  beforeAll(() => mockAsSuperadmin());

  it('returns 200 for a valid base theme', async () => {
    if (!baseThemeId) return;
    const res = await request
      .get(`/platform/themes/${baseThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(baseThemeId);
    expect(res.body.type).toBe('system');
  });

  it('returns 404 for an org-owned theme id', async () => {
    const res = await request
      .get(`/platform/themes/${orgThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-existent id', async () => {
    const res = await request
      .get('/platform/themes/00000000-0000-0000-0000-000000000000')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(404);
  });
});

// ─── POST /platform/themes ────────────────────────────────────────────────────

describe('POST /platform/themes', () => {
  beforeAll(() => mockAsSuperadmin());

  it('creates a base theme (gym_id IS NULL, is_system_default = false)', async () => {
    const res = await request
      .post('/platform/themes')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: 'Test Base Theme Alpha', description: 'Created by test' });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('system');
    expect(res.body.is_system_default).toBe(false);
    expect(res.body.name).toBe('Test Base Theme Alpha');
  });

  it('returns 400 when name is missing', async () => {
    const res = await request
      .post('/platform/themes')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ description: 'No name' });
    expect(res.status).toBe(400);
  });

  it('returns 409 on duplicate name', async () => {
    await request
      .post('/platform/themes')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: 'Test Base Theme Duplicate' });
    const res = await request
      .post('/platform/themes')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: 'Test Base Theme Duplicate' });
    expect(res.status).toBe(409);
  });

  it('returns 400 for invalid token hex color', async () => {
    const res = await request
      .post('/platform/themes')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({
        name: 'Test Base Theme Bad Tokens',
        tokens: { colors: { appBackground: 'not-a-hex' } },
      });
    expect(res.status).toBe(400);
  });
});

// ─── PUT /platform/themes/:id/set-system-default ─────────────────────────────

describe('PUT /platform/themes/:id/set-system-default', () => {
  beforeAll(() => mockAsSuperadmin());

  it('sets exactly one base theme as system default', async () => {
    if (!baseThemeId) return;
    const res = await request
      .put(`/platform/themes/${baseThemeId}/set-system-default`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const { rows } = await db.query<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM themes WHERE gym_id IS NULL AND is_system_default = 1',
    );
    expect(Number(rows[0].cnt)).toBe(1);

    const { rows: flagged } = await db.query<{ id: string }>(
      'SELECT id FROM themes WHERE gym_id IS NULL AND is_system_default = 1',
    );
    expect(flagged[0].id).toBe(baseThemeId);
  });

  it('returns 404 when targeting an org-owned theme', async () => {
    const res = await request
      .put(`/platform/themes/${orgThemeId}/set-system-default`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-existent id', async () => {
    const res = await request
      .put('/platform/themes/00000000-0000-0000-0000-000000000000/set-system-default')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(404);
  });
});

// ─── DELETE /platform/themes/:id ─────────────────────────────────────────────

describe('DELETE /platform/themes/:id', () => {
  let deletableThemeId: string;

  beforeAll(async () => {
    mockAsSuperadmin();
    const res = await request
      .post('/platform/themes')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: 'Test Base Theme Deletable' });
    deletableThemeId = res.body.id;
  });

  it('soft-deletes a base theme (204)', async () => {
    const res = await request
      .delete(`/platform/themes/${deletableThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(204);
  });

  it('deleted theme no longer appears in list', async () => {
    const res = await request
      .get('/platform/themes')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    const ids = res.body.map((t: any) => t.id);
    expect(ids).not.toContain(deletableThemeId);
  });

  it('returns 404 for an org-owned theme', async () => {
    const res = await request
      .delete(`/platform/themes/${orgThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(404);
  });
});
