// #3372: Cordel → Payment Methods searches by name and description (in any
// product language), as well as by the stable code.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, request } from './helpers';

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: vi.fn().mockResolvedValue({
          publicMetadata: { platform_role: 'superadmin' },
          fullName: 'Super Admin', firstName: 'Super', lastName: 'Admin',
          emailAddresses: [], primaryEmailAddressId: null,
        }),
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
    })),
  };
});

const RUN = Math.random().toString(36).slice(2, 8);
const methodIds: number[] = [];

afterAll(async () => {
  await cleanupTestGyms();
  if (methodIds.length) {
    await db.query(`DELETE FROM base_payment_methods WHERE id IN (${methodIds.map(() => '?').join(',')})`, methodIds);
  }
  await db.end();
});

const search = (q: string) =>
  request.get(`/platform/base-payment-methods?q=${encodeURIComponent(q)}`).set('Authorization', TEST_AUTH_HEADER);

describe('GET /platform/base-payment-methods?q=', () => {
  it('matches the name, the description in any language and the code', async () => {
    const created = await request.post('/platform/base-payment-methods').set('Authorization', TEST_AUTH_HEADER).send({
      code: `srch_${RUN}`,
      translations: {
        en: { name: `Voucher ${RUN}`, description: `Paid with a prepaid bundle ${RUN}x` },
        es: { name: `Bono ${RUN}`, description: `Pagado con un paquete ${RUN}y` },
      },
    });
    expect(created.status).toBe(201);
    methodIds.push(Number(created.body.id));
    const id = created.body.id;

    for (const q of [`Voucher ${RUN}`, `bundle ${RUN}x`, `paquete ${RUN}y`, `srch_${RUN}`]) {
      const res = await search(q);
      expect(res.status).toBe(200);
      expect(res.body.map((r: { id: number }) => r.id)).toContain(id);
    }

    const miss = await search(`nothing-${RUN}`);
    expect(miss.status).toBe(200);
    expect(miss.body.map((r: { id: number }) => r.id)).not.toContain(id);
  });
});
