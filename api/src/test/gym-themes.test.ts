// Tests for gym-themes.ts router (/system/themes — gym-admin customer theme CRUD)
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { defaultTokens as defaultTokensFixture } from '../domain/themeTokens';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

let gymId: string;
let otherGymId: string;
let customThemeId: string;

beforeAll(async () => {
  gymId = await createTestGym('GymThemesTestGym');
  await createTestMembership(gymId, 'admin');

  otherGymId = await createTestGym('GymThemesOtherGym');
  await createTestMembership(otherGymId, 'admin');

  await db.query(
    `INSERT INTO themes (id, gym_id, name, status, tokens, created_at)
     VALUES (UUID(), ?, 'Custom Theme Test', 'active', '{}', UTC_TIMESTAMP())`,
    [gymId],
  );
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM themes WHERE gym_id = ? AND name = 'Custom Theme Test' LIMIT 1",
    [gymId],
  );
  customThemeId = rows[0].id;
});

afterAll(async () => {
  await db.query('DELETE FROM themes WHERE gym_id IN (SELECT id FROM gyms WHERE slug LIKE ?)', ['test-%']);
  await cleanupTestGyms();
  await db.end();
});

// ─── PUT /system/themes/:id ────────────────────────────────────────────────────

describe('PUT /system/themes/:id', () => {
  it('returns 401 without auth', async () => {
    const res = await request
      .put(`/system/themes/${customThemeId}`)
      .set('x-gym-id', gymId)
      .send({ name: 'Renamed' });
    expect(res.status).toBe(401);
  });

  it('returns 404 for a theme owned by another gym (tenant isolation)', async () => {
    const res = await request
      .put(`/system/themes/${customThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId)
      .send({ name: 'Hijacked' });
    expect(res.status).toBe(404);
  });

  it('persists logo_contains_gym_name and returns it in the response', async () => {
    const res = await request
      .put(`/system/themes/${customThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ logo_contains_gym_name: true });
    expect(res.status).toBe(200);
    expect(res.body.logo_contains_gym_name).toBe(true);

    const { rows } = await db.query<{ logo_contains_gym_name: number }>(
      'SELECT logo_contains_gym_name FROM themes WHERE id = ?',
      [customThemeId],
    );
    expect(!!rows[0].logo_contains_gym_name).toBe(true);
  });

  it('leaves logo_contains_gym_name unchanged when omitted from the update', async () => {
    const res = await request
      .put(`/system/themes/${customThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ description: 'Updated description' });
    expect(res.status).toBe(200);
    expect(res.body.logo_contains_gym_name).toBe(true);
  });

  it('returns 400 when logo_contains_gym_name is not a boolean', async () => {
    const res = await request
      .put(`/system/themes/${customThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ logo_contains_gym_name: 'true' });
    expect(res.status).toBe(400);
  });
});

// ─── Semantic color tokens (#489 stage 5) ────────────────────────────────────

describe('Semantic color tokens (#489)', () => {
  it('persists and returns the stage-2 semantic color fields for a customer theme', async () => {
    const res = await request
      .put(`/system/themes/${customThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        tokens: {
          ...defaultTokensFixture(),
          colors: {
            ...defaultTokensFixture().colors,
            secondaryTextColor: '#123456',
            mutedTextColor: '#654321',
            separatorColor: '#abcdef',
            inputBorderColor: '#111111',
            inputBackgroundColor: '#222222',
            sectionHeadingTextColor: '#333333',
          },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.tokens.colors).toMatchObject({
      secondaryTextColor: '#123456',
      mutedTextColor: '#654321',
      separatorColor: '#abcdef',
      inputBorderColor: '#111111',
      inputBackgroundColor: '#222222',
      sectionHeadingTextColor: '#333333',
    });

    const { rows } = await db.query<{ tokens: string }>('SELECT tokens FROM themes WHERE id = ?', [customThemeId]);
    const persisted = typeof rows[0].tokens === 'string' ? JSON.parse(rows[0].tokens) : rows[0].tokens;
    expect(persisted.colors.separatorColor).toBe('#abcdef');
    expect(persisted.colors.sectionHeadingTextColor).toBe('#333333');
  });

  it('round-trips an `advanced` map unchanged on update (no duplication/loss of existing values)', async () => {
    const advanced = { uiDensity: 'compact', inputFocusBorderColor: '#6c63ff', customLegacyKey: 'kept-as-is' };
    const res = await request
      .put(`/system/themes/${customThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ tokens: { ...defaultTokensFixture(), advanced } });
    expect(res.status).toBe(200);
    expect(res.body.tokens.advanced).toEqual(advanced);
  });

  it('rejects an invalid hex color on a customer theme (tenant-owned validation still applies)', async () => {
    const res = await request
      .put(`/system/themes/${customThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ tokens: { colors: { separatorColor: 'not-a-hex' } } });
    expect(res.status).toBe(400);
  });
});

// ─── Calendar color tokens (#559 stages 1 & 3) ───────────────────────────────

describe('Calendar color tokens (#559)', () => {
  const calendarColors = {
    calendarBackground: '#0a0a0a',
    calendarSurfaceBackground: '#0b0b0b',
    calendarHeaderBackground: '#0c0c0c',
    calendarHeaderText: '#0d0d0d',
    calendarDayText: '#0e0e0e',
    calendarMutedDayText: '#0f0f0f',
    calendarTodayBackground: '#101010',
    calendarSelectionBackground: '#111111',
    calendarGridBorder: '#121212',
    calendarTimeAxisBackground: '#131313',
    calendarTimeAxisText: '#141414',
    calendarWeekendBackground: '#151515',
    calendarDisabledSlotBackground: '#161616',
    calendarEventBackground: '#1a1a1a',
    calendarEventBorder: '#1b1b1b',
    calendarEventText: '#171717',
    calendarNavButtonBackground: '#181818',
    calendarNavButtonText: '#191919',
  };

  it('persists and returns every calendar color token for a customer theme', async () => {
    const res = await request
      .put(`/system/themes/${customThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        tokens: {
          ...defaultTokensFixture(),
          colors: { ...defaultTokensFixture().colors, ...calendarColors },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.tokens.colors).toMatchObject(calendarColors);

    const { rows } = await db.query<{ tokens: string }>('SELECT tokens FROM themes WHERE id = ?', [customThemeId]);
    const persisted = typeof rows[0].tokens === 'string' ? JSON.parse(rows[0].tokens) : rows[0].tokens;
    expect(persisted.colors).toMatchObject(calendarColors);
  });

  it('round-trips the calendar attributes in the `advanced` map', async () => {
    const advanced = { calendarEventBorderRadius: '10px', calendarEventHoverBackground: '#bcdbcd', calendarSlotHeight: '3em', calendarNavButtonHoverBackground: '#abcabc' };
    const res = await request
      .put(`/system/themes/${customThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ tokens: { ...defaultTokensFixture(), colors: { ...defaultTokensFixture().colors, ...calendarColors }, advanced } });
    expect(res.status).toBe(200);
    expect(res.body.tokens.advanced).toEqual(advanced);
  });

  it('rejects an invalid hex on a calendar token (400)', async () => {
    const res = await request
      .put(`/system/themes/${customThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ tokens: { colors: { calendarTodayBackground: 'not-a-hex' } } });
    expect(res.status).toBe(400);
    expect(res.body.error ?? res.body.message).toMatch(/calendarTodayBackground/);
  });

  it("returns 404 when writing calendar tokens to another gym's theme (tenant isolation)", async () => {
    const res = await request
      .put(`/system/themes/${customThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId)
      .send({ tokens: { colors: { calendarBackground: '#abcdef' } } });
    expect(res.status).toBe(404);
  });

  it('accepts an update to a legacy theme whose persisted tokens have no calendar keys', async () => {
    // Backward compatibility: themes saved before #559 carry no `calendar*`
    // keys. Saving such a theme must keep working and must not invent values.
    await db.query('UPDATE themes SET tokens = ? WHERE id = ?', [
      JSON.stringify({ v: 2, colors: { pageBackground: '#f5f5f5', textColor: '#111827' } }),
      customThemeId,
    ]);
    const res = await request
      .put(`/system/themes/${customThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ tokens: { colors: { pageBackground: '#eeeeee', textColor: '#111827' } } });
    expect(res.status).toBe(200);
    expect(res.body.tokens.colors.pageBackground).toBe('#eeeeee');
    expect(res.body.tokens.colors.calendarBackground).toBeUndefined();
  });

  it('copies calendar tokens when cloning a theme (clone-on-create, unchanged Base/Custom relationship)', async () => {
    await request
      .put(`/system/themes/${customThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ tokens: { ...defaultTokensFixture(), colors: { ...defaultTokensFixture().colors, ...calendarColors } } });

    const res = await request
      .post(`/system/themes/clone/${customThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Calendar Clone Test' });
    expect(res.status).toBe(201);
    expect(res.body.tokens.colors).toMatchObject(calendarColors);
  });
});

// ─── GET /system/themes ────────────────────────────────────────────────────────

describe('GET /system/themes', () => {
  it('includes logo_contains_gym_name on each theme', async () => {
    const res = await request
      .get('/system/themes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    for (const theme of res.body) {
      expect(typeof theme.logo_contains_gym_name).toBe('boolean');
    }
  });
});

// ─── POST /system/themes/clone/:sourceId ──────────────────────────────────────

describe('POST /system/themes/clone/:sourceId', () => {
  it('inherits logo_contains_gym_name from the source theme', async () => {
    const res = await request
      .post(`/system/themes/clone/${customThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Custom Theme Clone' });
    expect(res.status).toBe(201);
    expect(res.body.logo_contains_gym_name).toBe(true);
  });
});

// ─── Header metadata: creator, creation date, gym theme (#712) ────────────────

describe('Theme header metadata (#712)', () => {
  afterEach(async () => {
    // gyms.theme_id is what is_gym_theme is derived from — leave it as found so
    // the other blocks (and cleanup) aren't affected by what a case assigned.
    await db.query('UPDATE gyms SET theme_id = NULL WHERE id IN (?, ?)', [gymId, otherGymId]);
  });

  it('snapshots the creating actor on clone and returns it on the theme', async () => {
    const res = await request
      .post(`/system/themes/clone/${customThemeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Creator Snapshot Clone' });
    expect(res.status).toBe(201);
    expect(res.body.created_by_name).toBe('Test User');
    expect(res.body.created_by_type).toBe('staff');
    expect(typeof res.body.created_at).toBe('string');

    const { rows } = await db.query<{ created_by_name: string | null; created_by_type: string | null }>(
      'SELECT created_by_name, created_by_type FROM themes WHERE id = ?',
      [res.body.id],
    );
    expect(rows[0].created_by_name).toBe('Test User');
    expect(rows[0].created_by_type).toBe('staff');
  });

  it('exposes created_by_name and created_at on every theme in the list', async () => {
    const res = await request
      .get('/system/themes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const theme of res.body) {
      expect(theme).toHaveProperty('created_by_name');
      expect(theme.created_at).toBeTruthy();
    }
    // Seeded directly in beforeAll, i.e. by no one — an unattributed theme
    // reports a null creator rather than being dropped from the list.
    const seeded = res.body.find((th: any) => th.id === customThemeId);
    expect(seeded.created_by_name).toBeNull();
  });

  it('flags exactly the theme gyms.theme_id points at as is_gym_theme', async () => {
    await db.query('UPDATE gyms SET theme_id = ? WHERE id = ?', [customThemeId, gymId]);
    const res = await request
      .get('/system/themes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const flagged = res.body.filter((th: any) => th.is_gym_theme);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].id).toBe(customThemeId);
  });

  it('reports is_gym_theme false for every theme when the gym has no theme assigned', async () => {
    await db.query('UPDATE gyms SET theme_id = NULL WHERE id = ?', [gymId]);
    const res = await request
      .get('/system/themes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.every((th: any) => th.is_gym_theme === false)).toBe(true);
  });

  it("derives is_gym_theme from the caller's gym, not another gym's selection (tenant isolation)", async () => {
    // A Base Theme is visible to both gyms; gym A selects it, gym B did not.
    const { rows: baseRows } = await db.query<{ id: string }>(
      'SELECT id FROM themes WHERE gym_id IS NULL AND deleted_at IS NULL LIMIT 1',
    );
    const baseThemeId = baseRows[0].id;
    await db.query('UPDATE gyms SET theme_id = ? WHERE id = ?', [baseThemeId, gymId]);

    const asOtherGym = await request
      .get('/system/themes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    expect(asOtherGym.status).toBe(200);
    expect(asOtherGym.body.find((th: any) => th.id === baseThemeId).is_gym_theme).toBe(false);
    // ...and gym A's custom theme (with its creator metadata) is not listed at all.
    expect(asOtherGym.body.some((th: any) => th.id === customThemeId)).toBe(false);

    const asOwnGym = await request
      .get('/system/themes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(asOwnGym.body.find((th: any) => th.id === baseThemeId).is_gym_theme).toBe(true);
  });
});
