// #1085 — the decision half of the Clerk webhook relay.
//
// Pure, so every rule is assertable here with no server, no Clerk account and
// no signed payload. The properties CI must enforce (the route forwards bytes,
// relays the API's status, and the middleware exempts the path) are pinned in
// `api/src/test/clerk-webhook-relay.unit.test.ts`, because CI runs `npm test`
// in `api/` only.
import { describe, expect, it } from 'vitest';
import {
  CLERK_WEBHOOK_API_PATH,
  CLERK_WEBHOOK_RELAY_PATH,
  RELAYED_REQUEST_HEADERS,
  RELAY_UNCONFIGURED_STATUS,
  RELAY_UNREACHABLE_STATUS,
  SVIX_SIGNATURE_HEADERS,
  clerkWebhookTarget,
  relayedRequestHeaders,
} from '../lib/clerkWebhookRelay';

describe('what the relay forwards', () => {
  it('is the three Svix headers plus the content type, and nothing else', () => {
    expect([...SVIX_SIGNATURE_HEADERS]).toEqual(['svix-id', 'svix-timestamp', 'svix-signature']);
    expect([...RELAYED_REQUEST_HEADERS]).toEqual([
      'svix-id',
      'svix-timestamp',
      'svix-signature',
      'content-type',
    ]);
  });

  it('forwards all three signature headers byte for byte', () => {
    const headers = relayedRequestHeaders([
      ['svix-id', 'msg_2abc'],
      ['svix-timestamp', '1760000000'],
      ['svix-signature', 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='],
      ['content-type', 'application/json'],
    ]);
    expect(headers).toEqual({
      'svix-id': 'msg_2abc',
      'svix-timestamp': '1760000000',
      'svix-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
      'content-type': 'application/json',
    });
  });

  it('is case-insensitive about the header names it is given', () => {
    // A `Headers` object lower-cases, but an iterable of pairs need not.
    expect(relayedRequestHeaders([['Svix-Id', 'msg_1'], ['SVIX-SIGNATURE', 'v1,x']])).toEqual({
      'svix-id': 'msg_1',
      'svix-signature': 'v1,x',
    });
  });

  it('drops the caller’s own credentials and routing headers', () => {
    // Not `/api/proxy`'s set: this route authenticates by signature alone, so
    // handing it an Authorization header or a gym id is at best meaningless.
    const headers = relayedRequestHeaders([
      ['authorization', 'Bearer sk_live_leaked'],
      ['cookie', '__session=abc'],
      ['host', 'admin.vdicube.com'],
      ['x-gym-id', '7'],
      ['x-center-id', '3'],
      ['x-impersonate-as', 'user_2abc'],
      ['x-locale', 'es'],
      ['x-forwarded-for', '203.0.113.9'],
      ['svix-id', 'msg_2abc'],
    ]);
    expect(Object.keys(headers)).toEqual(['svix-id']);
  });

  it('invents nothing for a header the request does not carry', () => {
    // A webhook arriving with no signature must be refused by the API as
    // unsigned, which only works if nothing here supplies a placeholder.
    expect(relayedRequestHeaders([['content-type', 'application/json']])).toEqual({
      'content-type': 'application/json',
    });
  });
});

describe('where the relay forwards it', () => {
  it('appends the API path to the configured base', () => {
    expect(clerkWebhookTarget('http://localhost:3000')).toBe('http://localhost:3000/webhooks/clerk');
    expect(CLERK_WEBHOOK_API_PATH).toBe('/webhooks/clerk');
  });

  it('tolerates a trailing slash on the base', () => {
    expect(clerkWebhookTarget('http://api:3000/')).toBe('http://api:3000/webhooks/clerk');
    expect(clerkWebhookTarget('http://api:3000///')).toBe('http://api:3000/webhooks/clerk');
  });

  it('answers null for an unset or blank base, never a relative URL', () => {
    expect(clerkWebhookTarget(undefined)).toBeNull();
    expect(clerkWebhookTarget(null)).toBeNull();
    expect(clerkWebhookTarget('')).toBeNull();
    expect(clerkWebhookTarget('   ')).toBeNull();
  });
});

describe('what the relay answers when it cannot deliver', () => {
  it('fails rather than swallowing the event', () => {
    // Clerk retries exactly what we report as failed, so neither case may be a
    // 200: a swallowed `user.deleted` leaves an orphaned Clerk account linked
    // to rows that should have been cleaned up (#709).
    expect(RELAY_UNREACHABLE_STATUS).toBe(502);
    expect(RELAY_UNCONFIGURED_STATUS).toBe(500);
    expect(RELAY_UNREACHABLE_STATUS).not.toBe(200);
    expect(RELAY_UNCONFIGURED_STATUS).not.toBe(200);
  });
});

describe('the path Clerk is pointed at', () => {
  it('is the admin app route, declared once', () => {
    expect(CLERK_WEBHOOK_RELAY_PATH).toBe('/api/webhooks/clerk');
  });

  it('is not the generic proxy', () => {
    // `/api/proxy` forwards a different header set and none of the Svix ones.
    expect(CLERK_WEBHOOK_RELAY_PATH.startsWith('/api/proxy')).toBe(false);
  });
});
