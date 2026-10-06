// #1175 — the decision half of the website-registration relay.
import { describe, expect, it } from 'vitest';
import {
  PUBLIC_REGISTRATION_RELAY_TIMEOUT_MS,
  RELAY_NOT_ALLOWED_STATUS,
  RELAY_TIMEOUT_STATUS,
  RELAY_UNCONFIGURED_STATUS,
  RELAY_UNREACHABLE_STATUS,
  isPublicRegistrationRelayPath,
  publicRegistrationApiPath,
  publicRegistrationTarget,
  relayedRequestHeaders,
} from '../lib/publicRegistrationRelay';

const REF = '48ded4d3-31a9-4334-86d1-c48bd6b48513-fit%20box';

describe('publicRegistrationApiPath', () => {
  it('maps the one route shape onto the API path, the reference forwarded as received', () => {
    expect(publicRegistrationApiPath(`/api/public/gyms/${REF}/registrations`)).toBe(
      `/public/gyms/${REF}/registrations`,
    );
    // A pre-#645 bare slug still resolves on the API side, so it is relayed too.
    expect(publicRegistrationApiPath('/api/public/gyms/my-gym/registrations')).toBe(
      '/public/gyms/my-gym/registrations',
    );
  });

  it('refuses every other path under the prefix', () => {
    for (const path of [
      '/api/public/gyms/my-gym',
      '/api/public/gyms/my-gym/classes',
      '/api/public/gyms//registrations',
      '/api/public/gyms/a/b/registrations',
      '/api/public/gyms/my-gym/registrations/',
      '/api/public/gyms/my-gym/registrations/extra',
      '/api/public/gyms/my-gym/Registrations',
      '/api/public/x/gyms/my-gym/registrations',
      '/api/proxy/public/gyms/my-gym/registrations',
    ]) {
      expect(publicRegistrationApiPath(path), path).toBeNull();
    }
  });

  it('refuses a traversal or an encoded separator in the reference', () => {
    for (const ref of ['.', '..', 'a%2Fb', 'a%2fb', 'a%5Cb', '..%2F..%2Fbilling']) {
      expect(publicRegistrationApiPath(`/api/public/gyms/${ref}/registrations`), ref).toBeNull();
    }
  });
});

describe('isPublicRegistrationRelayPath', () => {
  it('is the exact shape, never a prefix', () => {
    expect(isPublicRegistrationRelayPath(`/api/public/gyms/${REF}/registrations`)).toBe(true);
    expect(isPublicRegistrationRelayPath('/api/public/gyms/my-gym')).toBe(false);
    expect(isPublicRegistrationRelayPath('/api/public/gyms/my-gym/registrations/x')).toBe(false);
    expect(isPublicRegistrationRelayPath('/en/api/public/gyms/my-gym/registrations')).toBe(false);
  });
});

describe('relayedRequestHeaders', () => {
  it('forwards the key, the content type and the client chain, and nothing else', () => {
    const headers = relayedRequestHeaders([
      ['X-Api-Key', 'gdk_live_abc'],
      ['Content-Type', 'application/json'],
      ['X-Forwarded-For', '198.51.100.7'],
      ['authorization', 'Bearer sk_live_leaked'],
      ['cookie', '__session=abc'],
      ['x-gym-id', '7'],
      ['host', 'admin.vdicube.com'],
    ]);
    expect(headers).toEqual({
      'x-api-key': 'gdk_live_abc',
      'content-type': 'application/json',
      'x-forwarded-for': '198.51.100.7',
    });
  });

  it('invents no key the caller did not send', () => {
    expect(relayedRequestHeaders([['content-type', 'application/json']])).toEqual({
      'content-type': 'application/json',
    });
  });
});

describe('publicRegistrationTarget', () => {
  it('appends the API path to the base, tolerating trailing slashes', () => {
    expect(publicRegistrationTarget(' http://api:3000// ', '/public/gyms/x/registrations')).toBe(
      'http://api:3000/public/gyms/x/registrations',
    );
  });

  it('answers null for an unset or blank base', () => {
    expect(publicRegistrationTarget(undefined, '/p')).toBeNull();
    expect(publicRegistrationTarget('  ', '/p')).toBeNull();
  });
});

describe('the relay’s own answers', () => {
  it('is a 404 off the route, and never a 2xx when it cannot ask the API', () => {
    expect(RELAY_NOT_ALLOWED_STATUS).toBe(404);
    expect([RELAY_UNCONFIGURED_STATUS, RELAY_UNREACHABLE_STATUS, RELAY_TIMEOUT_STATUS]).toEqual([500, 502, 504]);
  });

  it('waits a bounded, positive time', () => {
    expect(PUBLIC_REGISTRATION_RELAY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PUBLIC_REGISTRATION_RELAY_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});
