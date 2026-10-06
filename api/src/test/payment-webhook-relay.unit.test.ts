// #1083 — Monei's webhook reaches the API through the isolated payment app.
//
// Two halves, and neither can see the other: the relay is an nginx config in
// `apps/payment` and the client-address rule is a module in `api/src`. This
// file pins both, the config half by scanning the file, because CI runs
// `npm test` in `api/` only (#1009's reason, the same one that put the mobile
// and Members App gates in this suite).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  PAYMENT_WEBHOOK_RELAY_HOPS_DEFAULT,
  TRUST_PROXY_HOPS_DEFAULT,
  forwardedClientAddress,
  paymentWebhookClientKey,
  paymentWebhookRelayHops,
  trustProxyHops,
} from '../domain/forwardedClient';

const ROOT = join(__dirname, '..', '..', '..');
const PAYMENT = join(ROOT, 'apps', 'payment');

const TEMPLATE = readFileSync(join(PAYMENT, 'templates', 'default.conf.template'), 'utf8');
const DOCKERFILE = readFileSync(join(PAYMENT, 'Dockerfile'), 'utf8');
const QUADLET = readFileSync(join(ROOT, 'infra', 'payment-app', 'fitness-pay.container'), 'utf8');

/** The template's directives, with its (long) comments dropped: a rule about
 *  what nginx does must not be satisfied or broken by prose about it. */
function directives(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

const CONFIG = directives(TEMPLATE);

/** The `location = /webhooks/payment { … }` block of the template, alone. */
const RELAY_BLOCK = (() => {
  const start = CONFIG.indexOf('location = /webhooks/payment');
  expect(start).toBeGreaterThan(-1);
  const end = CONFIG.indexOf('\n    }', start);
  expect(end).toBeGreaterThan(start);
  return CONFIG.slice(start, end);
})();

describe('the relay is nginx, configured rather than hardcoded', () => {
  it('serves the config from a template the image substitutes at start', () => {
    // The static nginx.conf is gone: a file in conf.d is never substituted, so
    // leaving one behind would quietly keep the old hardcoded origins.
    expect(existsSync(join(PAYMENT, 'nginx.conf'))).toBe(false);
    expect(DOCKERFILE).toContain('/etc/nginx/templates/default.conf.template');
    expect(DOCKERFILE).not.toContain('/etc/nginx/conf.d/default.conf');
  });

  it('names no API origin in the template', () => {
    // dev and pro differ and the image is one tag for both.
    expect(CONFIG).not.toContain('api.vdicube.com');
    expect(CONFIG).not.toContain('api.cordel.tech');
    expect(CONFIG).toContain('${CORDEL_FITNESS_API_PUBLIC_URL}');
    expect(CONFIG).toContain('${CORDEL_FITNESS_API_INTERNAL_URL}');
  });

  it('gives both origins an image default, so a bare container still starts', () => {
    // envsubst leaves an undefined ${VAR} in place, which nginx refuses as a
    // proxy_pass — the container would crash-loop instead of serving.
    for (const name of ['CORDEL_FITNESS_API_PUBLIC_URL', 'CORDEL_FITNESS_API_INTERNAL_URL']) {
      expect(DOCKERFILE).toMatch(new RegExp(`${name}=\\S+`));
      expect(QUADLET).toContain(`Environment=${name}=`);
    }
  });

  it('relays the webhook to the API by its internal address', () => {
    expect(RELAY_BLOCK).toContain('proxy_pass ${CORDEL_FITNESS_API_INTERNAL_URL}/webhooks/payment;');
    // The browser-facing proxies keep the public one: they are reached by the
    // member's own browser, not from inside the container.
    expect(CONFIG).toContain('proxy_pass ${CORDEL_FITNESS_API_PUBLIC_URL};');
  });

  it('is an exact-match location, so nothing else on the host answers it', () => {
    expect(CONFIG).toContain('location = /webhooks/payment');
  });
});

describe('what the relay does with the request and the answer', () => {
  it('answers Monei with the API’s own status code', () => {
    // proxy_intercept_errors is off by default; turning it on would replace the
    // API's 400 or 500 with an error page of ours, so Monei would stop retrying
    // a failure — or retry a success. A `return` in this block is the same bug.
    expect(CONFIG).not.toContain('proxy_intercept_errors');
    expect(RELAY_BLOCK).not.toMatch(/\breturn\s+\d/);
    expect(RELAY_BLOCK).not.toContain('error_page');
  });

  it('keeps the body and the signature header byte for byte', () => {
    // Nothing may rewrite the entity the HMAC was computed over, and the
    // signature header must arrive as sent: the relay sets no header beyond the
    // forwarding ones, and never disables request buffering into a re-framing.
    expect(RELAY_BLOCK).not.toMatch(/proxy_set_header\s+Content-/i);
    expect(RELAY_BLOCK).not.toMatch(/proxy_set_body|proxy_method|sub_filter/);
    expect(RELAY_BLOCK).toContain('proxy_http_version 1.1;');
  });

  it('bounds the wait, so an unreachable API is a 5xx rather than a hang', () => {
    expect(RELAY_BLOCK).toMatch(/proxy_connect_timeout\s+\d+s;/);
    expect(RELAY_BLOCK).toMatch(/proxy_read_timeout\s+\d+s;/);
  });

  it('preserves the client address', () => {
    expect(RELAY_BLOCK).toContain('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
  });

  it('logs no query string on this host', () => {
    // PCI (docs/architecture.md): the checkout link carries ?token=<page_token>.
    expect(CONFIG).toContain('log_format pay_no_query');
    expect(CONFIG).toContain('access_log /var/log/nginx/access.log pay_no_query;');
    expect(CONFIG).not.toMatch(/log_format[^;]*\$request\b/);
    expect(CONFIG).not.toMatch(/log_format[^;]*\$query_string/);
    expect(CONFIG).not.toMatch(/log_format[^;]*\$request_uri/);
  });
});

describe('hop counts read from the environment', () => {
  it('defaults to one proxy in front of every route and no relay', () => {
    expect(trustProxyHops({})).toBe(TRUST_PROXY_HOPS_DEFAULT);
    expect(TRUST_PROXY_HOPS_DEFAULT).toBe(1);
    expect(paymentWebhookRelayHops({})).toBe(PAYMENT_WEBHOOK_RELAY_HOPS_DEFAULT);
    expect(PAYMENT_WEBHOOK_RELAY_HOPS_DEFAULT).toBe(0);
  });

  it('honours 0, which is a real answer for both', () => {
    expect(trustProxyHops({ TRUST_PROXY_HOPS: '0' })).toBe(0);
    expect(paymentWebhookRelayHops({ PAYMENT_WEBHOOK_RELAY_HOPS: '0' })).toBe(0);
  });

  it('falls back rather than honouring nonsense', () => {
    for (const raw of ['', '   ', '-1', '1.5', 'two', 'NaN']) {
      expect(trustProxyHops({ TRUST_PROXY_HOPS: raw })).toBe(TRUST_PROXY_HOPS_DEFAULT);
      expect(paymentWebhookRelayHops({ PAYMENT_WEBHOOK_RELAY_HOPS: raw })).toBe(
        PAYMENT_WEBHOOK_RELAY_HOPS_DEFAULT,
      );
    }
  });
});

describe('forwardedClientAddress', () => {
  const chain = { socketAddress: '10.0.0.9', forwardedFor: '198.51.100.7, 203.0.113.1' };

  it('counts hops outwards from the socket, as Express does', () => {
    expect(forwardedClientAddress(chain, 0)).toBe('10.0.0.9');
    expect(forwardedClientAddress(chain, 1)).toBe('203.0.113.1');
    expect(forwardedClientAddress(chain, 2)).toBe('198.51.100.7');
  });

  it('answers the outermost address when the chain is shorter than the hop count', () => {
    // A request that arrived through fewer proxies than configured still needs a
    // key, and the socket address is the one entry no caller can forge.
    expect(forwardedClientAddress(chain, 9)).toBe('198.51.100.7');
    expect(forwardedClientAddress({ socketAddress: '10.0.0.9' }, 2)).toBe('10.0.0.9');
  });

  it('reads a repeated header and tolerates blanks', () => {
    expect(
      forwardedClientAddress(
        { socketAddress: '10.0.0.9', forwardedFor: ['198.51.100.7', ' , 203.0.113.1 '] },
        2,
      ),
    ).toBe('198.51.100.7');
  });

  it('answers undefined only when there is nothing at all', () => {
    expect(forwardedClientAddress({}, 1)).toBeUndefined();
    expect(forwardedClientAddress({ forwardedFor: '' }, 1)).toBeUndefined();
  });
});

describe('paymentWebhookClientKey', () => {
  const relayed = {
    // What the API sees when Monei → Traefik → the payment app → the API:
    // Express resolved req.ip one hop in, which is the relay itself.
    ip: '203.0.113.1',
    socketAddress: '10.0.0.9',
    forwardedFor: '198.51.100.7, 203.0.113.1',
  };

  it('is req.ip verbatim with no relay configured', () => {
    expect(paymentWebhookClientKey(relayed, {})).toBe('203.0.113.1');
  });

  it('answers the client rather than the relay once the relay is declared', () => {
    expect(paymentWebhookClientKey(relayed, { PAYMENT_WEBHOOK_RELAY_HOPS: '1' })).toBe(
      '198.51.100.7',
    );
  });

  it('adds the relay to the trusted count rather than replacing it', () => {
    // Two relays in front of a single-proxy deployment: 1 + 2 hops out.
    expect(
      paymentWebhookClientKey(
        {
          ip: '203.0.113.1',
          socketAddress: '10.0.0.9',
          forwardedFor: '198.51.100.7, 192.0.2.5, 203.0.113.1',
        },
        { PAYMENT_WEBHOOK_RELAY_HOPS: '2' },
      ),
    ).toBe('198.51.100.7');
  });

  it('never answers undefined, so the limiter always has a key', () => {
    expect(paymentWebhookClientKey({}, {})).toBe('');
    expect(paymentWebhookClientKey({ ip: '203.0.113.1' }, { PAYMENT_WEBHOOK_RELAY_HOPS: '1' })).toBe(
      '203.0.113.1',
    );
  });
});
