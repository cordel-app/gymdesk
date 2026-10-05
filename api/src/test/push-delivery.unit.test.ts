// #1072 (mobile app WP1) — the pure half of push delivery: which credentials
// this deployment holds, what one FCM message looks like, and when a failed
// send means the token is dead.
//
// No network: `domain/pushDelivery.ts` exists precisely so these three
// decisions are assertable without one.

import { describe, expect, it } from 'vitest';
import {
  buildPushMessage,
  fcmErrorCode,
  fcmSendUrl,
  normalizePrivateKey,
  parseServiceAccounts,
  pushFailureAction,
} from '../domain/pushDelivery';

const ACCOUNT = {
  project_id: 'cordel-fitness-dev',
  client_email: 'push@cordel-fitness-dev.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
};

describe('parseServiceAccounts', () => {
  it('reads one app', () => {
    const { accounts, errors } = parseServiceAccounts(JSON.stringify({ 'com.cordel.fitness': ACCOUNT }));
    expect(errors).toEqual([]);
    const account = accounts.get('com.cordel.fitness');
    expect(account).toMatchObject({
      appId: 'com.cordel.fitness',
      projectId: 'cordel-fitness-dev',
      clientEmail: 'push@cordel-fitness-dev.iam.gserviceaccount.com',
    });
    // The escaped newlines of a PEM pasted into an env var are repaired, or
    // `crypto.createSign` rejects the key with an opaque OpenSSL error.
    expect(account!.privateKey).toContain('\n');
    expect(account!.privateKey).not.toContain('\\n');
  });

  it('reads several apps, which is what stage 2 adds', () => {
    const { accounts, errors } = parseServiceAccounts(JSON.stringify({
      'com.cordel.fitness': ACCOUNT,
      'com.gym.alpha': { ...ACCOUNT, project_id: 'gym-alpha' },
    }));
    expect(errors).toEqual([]);
    expect([...accounts.keys()]).toEqual(['com.cordel.fitness', 'com.gym.alpha']);
    expect(accounts.get('com.gym.alpha')!.projectId).toBe('gym-alpha');
  });

  it('is empty, and silent, with no configuration at all', () => {
    for (const raw of [undefined, null, '', '   ']) {
      const { accounts, errors } = parseServiceAccounts(raw);
      expect(accounts.size).toBe(0);
      expect(errors).toEqual([]);
    }
  });

  it('reports rather than throws on malformed JSON', () => {
    const { accounts, errors } = parseServiceAccounts('{not json');
    expect(accounts.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('not valid JSON');
  });

  it('refuses a non-object and an array', () => {
    for (const raw of ['"x"', '5', '[]', 'null']) {
      const { accounts, errors } = parseServiceAccounts(raw);
      expect(accounts.size).toBe(0);
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('drops an incomplete entry and keeps the others', () => {
    const { accounts, errors } = parseServiceAccounts(JSON.stringify({
      'com.cordel.fitness': ACCOUNT,
      'com.gym.broken': { project_id: 'only-this' },
      'com.gym.wrong-shape': 'nope',
      '': ACCOUNT,
    }));
    expect([...accounts.keys()]).toEqual(['com.cordel.fitness']);
    expect(errors.join(' ')).toContain('client_email');
    expect(errors.join(' ')).toContain('private_key');
    expect(errors.join(' ')).toContain('service-account object');
    expect(errors.join(' ')).toContain('empty app id');
  });
});

describe('normalizePrivateKey', () => {
  it('leaves a real multi-line key alone', () => {
    const real = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';
    expect(normalizePrivateKey(real)).toBe(real);
  });
});

describe('fcmSendUrl', () => {
  it('is the HTTP v1 endpoint for that project', () => {
    expect(fcmSendUrl('cordel-fitness-dev'))
      .toBe('https://fcm.googleapis.com/v1/projects/cordel-fitness-dev/messages:send');
  });
});

describe('buildPushMessage', () => {
  const content = {
    type: 'booking_confirmed',
    entityType: 'session' as const,
    entityId: 42,
    payload: { title: 'Yoga', starts_at: '2026-10-05T10:00:00.000Z' },
  };

  it('carries the type and entity as strings, for routing', () => {
    const message = buildPushMessage('tok-1', content) as any;
    expect(message.message.token).toBe('tok-1');
    expect(message.message.data).toEqual({
      type: 'booking_confirmed',
      entity_type: 'session',
      entity_id: '42',
      payload: JSON.stringify(content.payload),
    });
    // Every FCM data value must be a string.
    for (const value of Object.values(message.message.data)) expect(typeof value).toBe('string');
  });

  it('uses the payload\'s own title and composes no body', () => {
    const message = buildPushMessage('tok-1', content) as any;
    expect(message.message.notification).toEqual({ title: 'Yoga' });
    expect(message.message.notification.body).toBeUndefined();
  });

  it('omits the notification block entirely when there is no title', () => {
    for (const payload of [{}, { title: '' }, { title: '   ' }, { title: 7 }]) {
      const message = buildPushMessage('tok-1', { ...content, payload }) as any;
      expect(message.message.notification).toBeUndefined();
      expect(message.message.data.type).toBe('booking_confirmed');
    }
  });

  it('reports a null entity as an empty string rather than "null"', () => {
    const message = buildPushMessage('tok-1', {
      type: 'recurring_booking_skipped', entityType: null, entityId: null, payload: {},
    }) as any;
    expect(message.message.data.entity_type).toBe('');
    expect(message.message.data.entity_id).toBe('');
  });
});

describe('pushFailureAction', () => {
  it('deletes a token FCM says is gone', () => {
    expect(pushFailureAction(404, 'UNREGISTERED')).toBe('delete');
    expect(pushFailureAction(404, null)).toBe('delete');
    expect(pushFailureAction(403, 'SENDER_ID_MISMATCH')).toBe('delete');
  });

  it('keeps a token on INVALID_ARGUMENT', () => {
    // FCM answers it for a malformed *message* too, so deleting here would
    // empty the table on the first bug in buildPushMessage().
    expect(pushFailureAction(400, 'INVALID_ARGUMENT')).toBe('keep');
  });

  it('keeps a token on an unknown outcome', () => {
    expect(pushFailureAction(429, 'QUOTA_EXCEEDED')).toBe('keep');
    expect(pushFailureAction(500, 'INTERNAL')).toBe('keep');
    expect(pushFailureAction(503, 'UNAVAILABLE')).toBe('keep');
    expect(pushFailureAction(401, 'UNAUTHENTICATED')).toBe('keep');
    expect(pushFailureAction(400, null)).toBe('keep');
  });
});

describe('fcmErrorCode', () => {
  it('reads the code out of error.details', () => {
    expect(fcmErrorCode({
      error: {
        code: 404,
        status: 'NOT_FOUND',
        details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }],
      },
    })).toBe('UNREGISTERED');
  });

  it('falls back to error.status when no detail names one', () => {
    expect(fcmErrorCode({ error: { status: 'INVALID_ARGUMENT' } })).toBe('INVALID_ARGUMENT');
  });

  it('is null for a body that carries no error at all', () => {
    for (const body of [null, undefined, {}, { error: 'text' }, { error: { details: [] } }]) {
      expect(fcmErrorCode(body)).toBeNull();
    }
  });
});
