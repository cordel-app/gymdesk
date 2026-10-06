// #1175 — gym websites' sign-ups reach the API through the admin app.
//
// The relay is a Next route handler plus a middleware exemption in
// `apps/admin`; the route it relays to, its per-IP limiter and the screen that
// tells a gym where to post are here. This file pins the admin half by scanning
// its files, because CI runs `npm test` in `api/` only (#1009's reason).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  PUBLIC_REGISTRATION_RELAY_HOPS_DEFAULT,
  publicRegistrationClientKey,
  publicRegistrationRelayHops,
} from '../domain/forwardedClient';

const ROOT = join(__dirname, '..', '..', '..');
const ADMIN = join(ROOT, 'apps', 'admin', 'src');
const MEMBER = join(ROOT, 'apps', 'member', 'src');

const ROUTE_PATH = join(ADMIN, 'app', 'api', 'public', 'gyms', '[gymRef]', 'registrations', 'route.ts');
const MODULE_PATH = join(ADMIN, 'lib', 'publicRegistrationRelay.ts');

const ROUTE = readFileSync(ROUTE_PATH, 'utf8');
const MODULE = readFileSync(MODULE_PATH, 'utf8');
const MIDDLEWARE = readFileSync(join(ADMIN, 'middleware.ts'), 'utf8');
const API_ROUTE = readFileSync(join(__dirname, '..', 'api', 'public-registrations.ts'), 'utf8');
const INTEGRATION = readFileSync(join(__dirname, '..', 'api', 'website-integration.ts'), 'utf8');
const DEPLOY = readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');

/** A source file with its comment lines dropped: a rule about what the code
 *  does must not be satisfied or broken by prose about it. */
function code(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const ROUTE_CODE = code(ROUTE);
const MODULE_CODE = code(MODULE);
const MIDDLEWARE_CODE = code(MIDDLEWARE);
const API_ROUTE_CODE = code(API_ROUTE);
const INTEGRATION_CODE = code(INTEGRATION);

describe('the relay exists on the admin app, and only there', () => {
  it('is a route handler at the path websites are told to post to', () => {
    expect(existsSync(ROUTE_PATH)).toBe(true);
    expect(MODULE_CODE).toContain("export const PUBLIC_REGISTRATION_RELAY_PREFIX = '/api/public/gyms/'");
  });

  it('is not duplicated on the members app', () => {
    expect(existsSync(join(MEMBER, 'app', 'api', 'public'))).toBe(false);
  });

  it('answers POST and nothing else', () => {
    expect(ROUTE_CODE).toMatch(/export async function POST\b/);
    expect(ROUTE_CODE).not.toMatch(/export (async function|const) (GET|PUT|PATCH|DELETE)\b/);
  });

  it('is resolved per request and runs on Node', () => {
    expect(ROUTE_CODE).toContain("export const dynamic = 'force-dynamic'");
    expect(ROUTE_CODE).toContain("export const runtime = 'nodejs'");
  });
});

describe('it relays one route shape and nothing else', () => {
  it('relays to the route the API serves', () => {
    expect(MODULE_CODE).toContain('return `/public/gyms/${gymRef}/registrations`');
    expect(API_ROUTE).toContain('Mounted at /public/gyms/:gymRef/registrations');
  });

  it('decides the path in the module, from the raw pathname, never from decoded params', () => {
    expect(ROUTE_CODE).toContain('publicRegistrationApiPath(req.nextUrl.pathname)');
    expect(ROUTE_CODE).not.toMatch(/\bparams\b/);
    expect(ROUTE_CODE).toContain('status: RELAY_NOT_ALLOWED_STATUS');
  });

  it('matches a single segment, refusing traversals and encoded separators', () => {
    expect(MODULE_CODE).toContain('/^\\/api\\/public\\/gyms\\/([^/]+)\\/registrations$/');
    expect(MODULE_CODE).toContain("gymRef === '.' || gymRef === '..'");
    expect(MODULE_CODE).toMatch(/%2f\|%5c\/i/);
  });

  it('forwards the key, the content type and the client chain, and nothing else', () => {
    const start = MODULE_CODE.indexOf('export const RELAYED_REQUEST_HEADERS');
    const decl = MODULE_CODE.slice(start, MODULE_CODE.indexOf(';', start));
    expect([...decl.matchAll(/'([^']*)'/g)].map((m) => m[1])).toEqual([
      'x-api-key',
      'content-type',
      'x-forwarded-for',
    ]);
    expect(ROUTE_CODE).toContain('headers: relayedRequestHeaders(req.headers)');
  });

  it('passes the body as bytes', () => {
    expect(ROUTE_CODE).toContain('req.arrayBuffer()');
    expect(ROUTE_CODE).not.toMatch(/req\.(text|json)\(\)/);
  });

  it('authenticates nothing and spells no origin of its own', () => {
    expect(`${ROUTE_CODE}\n${MODULE_CODE}`).not.toMatch(/verifyWebsiteApiKey|website_api_key/);
    expect(ROUTE_CODE).toContain('process.env.CORDEL_FITNESS_API_URL');
    expect(`${ROUTE_CODE}\n${MODULE_CODE}`).not.toMatch(/https?:\/\//);
  });

  it('keeps the decision half pure', () => {
    expect(MODULE_CODE).not.toMatch(/\bfetch\(|next\/server|process\.env/);
  });
});

describe('what it answers', () => {
  it('relays the API’s own status and bytes, never a 2xx of its own', () => {
    expect(ROUTE_CODE).toContain('status: res.status');
    expect(ROUTE_CODE).toContain('res.arrayBuffer()');
    expect(ROUTE_CODE).not.toMatch(/res\.(text|json)\(\)/);
    expect(ROUTE_CODE).not.toMatch(/status:\s*2\d\d/);
  });

  it('answers its own failures with 404, 500, 502 and 504', () => {
    expect(MODULE_CODE).toMatch(/RELAY_NOT_ALLOWED_STATUS = 404/);
    expect(MODULE_CODE).toMatch(/RELAY_UNCONFIGURED_STATUS = 500/);
    expect(MODULE_CODE).toMatch(/RELAY_UNREACHABLE_STATUS = 502/);
    expect(MODULE_CODE).toMatch(/RELAY_TIMEOUT_STATUS = 504/);
    expect(ROUTE_CODE).toContain('AbortSignal.timeout(PUBLIC_REGISTRATION_RELAY_TIMEOUT_MS)');
  });
});

describe('the middleware lets websites through', () => {
  it('exempts the exact shape ahead of auth and the locale routing', () => {
    expect(MIDDLEWARE_CODE).toContain("import { isPublicRegistrationRelayPath } from '@/lib/publicRegistrationRelay'");
    const exempt = MIDDLEWARE_CODE.indexOf('isPublicRegistrationRelayPath(req.nextUrl.pathname)');
    expect(exempt).toBeGreaterThan(-1);
    expect(exempt).toBeLessThan(MIDDLEWARE_CODE.indexOf('auth.protect()'));
    expect(exempt).toBeLessThan(MIDDLEWARE_CODE.indexOf('handleI18nRouting(req)'));
    // Never a prefix exemption of `/api/public`.
    expect(MIDDLEWARE_CODE).not.toMatch(/startsWith\(['"`]\/api\/public/);
  });
});

describe('the per-IP limit keys on the website, not the relay', () => {
  it('the route’s ipLimiter uses publicRegistrationClientKey', () => {
    expect(API_ROUTE_CODE).toContain('publicRegistrationClientKey({');
    expect(API_ROUTE_CODE).toContain("forwardedFor: req.headers['x-forwarded-for']");
  });

  it('declares no relay by default, where the key is req.ip exactly as before', () => {
    expect(PUBLIC_REGISTRATION_RELAY_HOPS_DEFAULT).toBe(0);
    expect(publicRegistrationRelayHops({} as NodeJS.ProcessEnv)).toBe(0);
    expect(
      publicRegistrationClientKey(
        { ip: '10.0.0.5', socketAddress: '10.0.0.9', forwardedFor: '198.51.100.7, 10.0.0.5' },
        {} as NodeJS.ProcessEnv,
      ),
    ).toBe('10.0.0.5');
  });

  it('with the relay declared, answers the website’s own address', () => {
    // website → Traefik (appends the website) → admin relay (appends Traefik) → API.
    const req = { ip: '10.0.0.5', socketAddress: '10.0.0.9', forwardedFor: '198.51.100.7, 10.0.0.5' };
    const env = { TRUST_PROXY_HOPS: '1', PUBLIC_REGISTRATION_RELAY_HOPS: '1' } as unknown as NodeJS.ProcessEnv;
    expect(publicRegistrationClientKey(req, env)).toBe('198.51.100.7');
  });

  it('ignores an address a caller prepended for itself', () => {
    const req = {
      ip: '10.0.0.5',
      socketAddress: '10.0.0.9',
      forwardedFor: '203.0.113.66, 198.51.100.7, 10.0.0.5',
    };
    const env = { TRUST_PROXY_HOPS: '1', PUBLIC_REGISTRATION_RELAY_HOPS: '1' } as unknown as NodeJS.ProcessEnv;
    expect(publicRegistrationClientKey(req, env)).toBe('198.51.100.7');
  });

  it('falls back on a malformed hop count', () => {
    for (const raw of ['-1', '1.5', 'one', ' ']) {
      expect(publicRegistrationRelayHops({ PUBLIC_REGISTRATION_RELAY_HOPS: raw } as NodeJS.ProcessEnv)).toBe(0);
    }
  });
});

describe('the screen shows the relay, from one setting with no fallback', () => {
  it('builds the endpoint from PUBLIC_REGISTRATION_BASE_URL alone', () => {
    expect(INTEGRATION_CODE).toContain('process.env.PUBLIC_REGISTRATION_BASE_URL');
    // The fallback that showed every gym the payment host after #1083.
    expect(INTEGRATION_CODE).not.toContain('PAYMENT_NOTIFICATION_URL');
    expect(INTEGRATION_CODE).not.toContain('API_PUBLIC_URL');
  });

  it('deploy.yml forwards both settings to the API', () => {
    for (const name of ['PUBLIC_REGISTRATION_BASE_URL', 'PUBLIC_REGISTRATION_RELAY_HOPS']) {
      expect(DEPLOY).toContain(`${name}: \${{ vars.${name} }}`);
      expect(DEPLOY).toContain(`Environment=${name}=\${${name}:-}`);
      expect(DEPLOY).toMatch(new RegExp(`envs: [^\\n]*\\b${name}\\b`));
    }
  });
});
