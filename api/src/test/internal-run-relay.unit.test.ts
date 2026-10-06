// #1086 — the GitHub Actions nightly runs reach the API through the admin app.
//
// Two halves, and neither can see the other: the relay is a Next route handler,
// a transport module and a middleware exemption in `apps/admin`, and the routes
// it relays to are Express routers in `api/src`. This file pins both, the admin
// half by scanning the files, because CI runs `npm test` in `api/` only
// (#1009's reason, the same one that put the mobile, Members App, payment-relay
// and Clerk-relay gates here).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  INTERNAL_RUN_RELAY_HOPS_DEFAULT,
  TRUST_PROXY_HOPS_DEFAULT,
  internalRunClientKey,
  internalRunRelayHops,
} from '../domain/forwardedClient';

const ROOT = join(__dirname, '..', '..', '..');
const ADMIN = join(ROOT, 'apps', 'admin', 'src');
const MEMBER = join(ROOT, 'apps', 'member', 'src');
const WORKFLOWS = join(ROOT, '.github', 'workflows');

const RELAY_ROUTE_PATH = join(ADMIN, 'app', 'api', 'internal', '[...path]', 'route.ts');
const RELAY_MODULE_PATH = join(ADMIN, 'lib', 'internalRunRelay.ts');
const UPSTREAM_MODULE_PATH = join(ADMIN, 'lib', 'internalRunUpstream.ts');

const ROUTE = readFileSync(RELAY_ROUTE_PATH, 'utf8');
const MODULE = readFileSync(RELAY_MODULE_PATH, 'utf8');
const UPSTREAM = readFileSync(UPSTREAM_MODULE_PATH, 'utf8');
const MIDDLEWARE = readFileSync(join(ADMIN, 'middleware.ts'), 'utf8');
const API_APP = readFileSync(join(__dirname, '..', 'app.ts'), 'utf8');
const BILLING_WORKFLOW = readFileSync(join(WORKFLOWS, 'billing-run.yml'), 'utf8');
const BOOKING_WORKFLOW = readFileSync(join(WORKFLOWS, 'recurring-booking-run.yml'), 'utf8');

/** A source file's lines with its (long) comments dropped: a rule about what
 *  the code does must not be satisfied or broken by prose about it. */
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
const UPSTREAM_CODE = code(UPSTREAM);
const MIDDLEWARE_CODE = code(MIDDLEWARE);
const API_APP_CODE = code(API_APP);

/** The `export const <name> = …;` statement, comments dropped. */
function declaration(source: string, name: string): string {
  const start = source.indexOf(`export const ${name}`);
  expect(start, `${name} is declared`).toBeGreaterThan(-1);
  const end = source.indexOf(';', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The single-quoted strings a statement spells for itself. */
function quoted(statement: string): string[] {
  return [...statement.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe('the relay exists on the admin app, and only there', () => {
  it('is a route handler under the prefix the workflows call', () => {
    // dev: https://admin.vdicube.com/api/internal
    // pro: https://admin.cordel.tech/api/internal
    expect(existsSync(RELAY_ROUTE_PATH)).toBe(true);
    expect(quoted(declaration(MODULE_CODE, 'INTERNAL_RUN_RELAY_PATH'))).toEqual(['/api/internal']);
  });

  it('is not duplicated on the members app', () => {
    // One endpoint to keep in step with the GitHub environments' API_BASE_URL,
    // for #1085's reason.
    expect(existsSync(join(MEMBER, 'app', 'api', 'internal'))).toBe(false);
  });

  it('answers POST and nothing else', () => {
    // All four internal runs are POSTs; a GET under this prefix has nothing to
    // relay and gets Next's own 405.
    expect(ROUTE_CODE).toMatch(/export async function POST\b/);
    expect(ROUTE_CODE).not.toMatch(/export (async function|const) (GET|PUT|PATCH|DELETE)\b/);
  });

  it('is resolved per request rather than prerendered, on the Node runtime', () => {
    expect(ROUTE_CODE).toContain("export const dynamic = 'force-dynamic'");
    // Edge fetch only allows ports 80/443 and the API runs on 3000.
    expect(ROUTE_CODE).toContain("export const runtime = 'nodejs'");
  });
});

describe('only the four internal runs may be relayed', () => {
  it('names exactly the paths the workflows POST to', () => {
    expect(quoted(declaration(MODULE_CODE, 'INTERNAL_RUN_API_PATHS'))).toEqual([
      '/billing/run',
      '/billing/cleanup',
      '/promotion-lifecycle/run',
      '/recurring-bookings/run',
    ]);
  });

  it('is the set the two workflows actually call', () => {
    const called = [...`${BILLING_WORKFLOW}${BOOKING_WORKFLOW}`.matchAll(
      /\$API_BASE_URL(\/[a-z-]+\/[a-z-]+)"/g,
    )].map((m) => m[1]);
    expect(new Set(called)).toEqual(
      new Set(quoted(declaration(MODULE_CODE, 'INTERNAL_RUN_API_PATHS'))),
    );
  });

  it('decides the allowlist in the module, never in the route', () => {
    expect(ROUTE_CODE).toContain('internalRunApiPath(path)');
    for (const path of ['/billing/run', '/billing/cleanup', '/recurring-bookings/run']) {
      expect(ROUTE_CODE).not.toContain(`'${path}'`);
    }
  });

  it('answers a path outside it with a 404 of its own', () => {
    expect(declaration(MODULE_CODE, 'RELAY_NOT_ALLOWED_STATUS')).toContain('404');
    expect(ROUTE_CODE).toContain('RELAY_NOT_ALLOWED_STATUS');
  });
});

describe('the target is configuration, not a literal', () => {
  it('reads CORDEL_FITNESS_API_URL', () => {
    expect(ROUTE_CODE).toContain('process.env.CORDEL_FITNESS_API_URL');
  });

  it('names no API or admin origin anywhere in either half', () => {
    // dev and pro differ and one image serves both.
    for (const source of [ROUTE_CODE, MODULE_CODE, UPSTREAM_CODE]) {
      for (const host of ['api.vdicube.com', 'api.cordel.tech', 'admin.vdicube.com', 'admin.cordel.tech']) {
        expect(source).not.toContain(host);
      }
    }
  });

  it('builds the URL through the one declaration of it', () => {
    expect(ROUTE_CODE).toContain('internalRunTarget(');
  });
});

describe('what crosses the boundary', () => {
  it('forwards the secret, the content type and the client address, and nothing else', () => {
    expect(quoted(declaration(MODULE_CODE, 'RELAYED_REQUEST_HEADERS'))).toEqual([
      'x-internal-secret',
      'content-type',
      'x-forwarded-for',
    ]);
  });

  it('forwards none of /api/proxy’s headers', () => {
    // That route carries `authorization`, `x-gym-id`, `x-center-id`,
    // `x-impersonate-as` and `x-locale` — a caller's own credentials, which
    // these routes neither read nor should ever be handed. Widening its set
    // instead would have put the runners behind a route the browser also uses.
    const relayed = quoted(declaration(MODULE_CODE, 'RELAYED_REQUEST_HEADERS'));
    for (const header of ['authorization', 'cookie', 'host', 'x-gym-id', 'x-center-id', 'x-impersonate-as', 'x-locale']) {
      expect(relayed).not.toContain(header);
    }
  });

  it('builds the forwarded set in one place', () => {
    expect(ROUTE_CODE).toContain('relayedRequestHeaders(req.headers)');
    expect(ROUTE_CODE).not.toMatch(/headers:\s*req\.headers/);
  });

  it('relays the body as bytes, never as text', () => {
    // #830's rule, applied to a request: the relay has no business
    // re-serializing a payload it does not read.
    expect(ROUTE_CODE).toContain('await req.arrayBuffer()');
    expect(ROUTE_CODE).not.toContain('req.text()');
    expect(ROUTE_CODE).not.toContain('req.json()');
    expect(ROUTE_CODE).not.toContain('JSON.stringify');
  });
});

describe('what the workflow is answered', () => {
  it('relays the API’s own status code and body', () => {
    expect(ROUTE_CODE).toContain('status: res.status');
    expect(ROUTE_CODE).toContain('res.body');
  });

  it('never answers a blanket 200', () => {
    // The workflows fail the job on a non-2xx and read the body (#778); a 200
    // carrying no counters would be reported as an unreadable body rather than
    // as the API being out of reach.
    expect(ROUTE_CODE).not.toMatch(/status:\s*200/);
  });

  it('reports 502 unreachable, 504 timed out, 500 unconfigured', () => {
    expect(declaration(MODULE_CODE, 'RELAY_UNREACHABLE_STATUS')).toContain('502');
    expect(declaration(MODULE_CODE, 'RELAY_TIMEOUT_STATUS')).toContain('504');
    expect(declaration(MODULE_CODE, 'RELAY_UNCONFIGURED_STATUS')).toContain('500');
    for (const name of ['RELAY_UNREACHABLE_STATUS', 'RELAY_TIMEOUT_STATUS', 'RELAY_UNCONFIGURED_STATUS']) {
      expect(ROUTE_CODE).toContain(name);
    }
  });
});

describe('the relay authenticates nothing', () => {
  it('never names either internal secret', () => {
    // They stay in the API, which is the whole point of relaying rather than
    // re-implementing: the relay is a transport, not a second trust boundary.
    for (const source of [ROUTE_CODE, MODULE_CODE, UPSTREAM_CODE]) {
      expect(source).not.toContain('BILLING_INTERNAL_SECRET');
      expect(source).not.toContain('RECURRING_BOOKINGS_INTERNAL_SECRET');
    }
  });

  it('keeps the decision half pure', () => {
    // No I/O, so what may be relayed and where is assertable with no server,
    // no secret and no scheduled run.
    expect(MODULE_CODE).not.toContain('fetch(');
    expect(MODULE_CODE).not.toContain('process.env');
    expect(MODULE_CODE).not.toContain('next/server');
    expect(MODULE_CODE).not.toContain('node:http');
  });
});

describe('a 600-second run is not cut off by the relay', () => {
  it('does not use fetch, whose agent abandons a response after 300 s', () => {
    // `POST /recurring-bookings/run` is allowed 600 s by its workflow, and a
    // run the API completed but the workflow saw as failed is the worst
    // outcome here: the guard then refuses the retry as
    // `already_completed_today` (#780).
    expect(UPSTREAM_CODE).toContain("from 'node:http'");
    expect(UPSTREAM_CODE).toContain("from 'node:https'");
    for (const source of [ROUTE_CODE, UPSTREAM_CODE]) {
      expect(source).not.toMatch(/\bawait fetch\(/);
    }
  });

  it('waits longer than the longest --max-time in the workflows', () => {
    const budgets = [...`${BILLING_WORKFLOW}${BOOKING_WORKFLOW}`.matchAll(/--max-time (\d+)/g)].map(
      (m) => Number(m[1]),
    );
    expect(budgets.length).toBeGreaterThan(0);
    const longestMs = Math.max(...budgets) * 1000;
    const declared = Number(
      declaration(MODULE_CODE, 'INTERNAL_RUN_RELAY_TIMEOUT_MS_DEFAULT').replace(/\D/g, ''),
    );
    expect(declared).toBeGreaterThan(longestMs);
  });

  it('bounds the wait rather than hanging for ever', () => {
    expect(UPSTREAM_CODE).toContain('setTimeout(timeoutMs');
    expect(ROUTE_CODE).toContain('internalRunRelayTimeoutMs(process.env)');
  });
});

describe('the middleware lets it through', () => {
  it('declares the prefix public', () => {
    // `auth.protect()` would otherwise answer the workflow with a 401, and a
    // missed billing night is a day nobody is charged on.
    expect(MIDDLEWARE_CODE).toContain('INTERNAL_RUN_RELAY_PATH');
    const matcherStart = MIDDLEWARE_CODE.indexOf('createRouteMatcher([');
    expect(matcherStart).toBeGreaterThan(-1);
    const publicRoutes = MIDDLEWARE_CODE.slice(
      matcherStart,
      MIDDLEWARE_CODE.indexOf(']);', matcherStart),
    );
    expect(publicRoutes).toContain('${INTERNAL_RUN_RELAY_PATH}');
  });

  it('returns before the i18n routing, as /api/proxy does', () => {
    // The locale middleware would answer the workflow with a redirect to `/en/…`.
    const body = MIDDLEWARE_CODE.slice(MIDDLEWARE_CODE.indexOf('clerkMiddleware(async'));
    const earlyReturn = body.indexOf('return NextResponse.next();');
    const i18n = body.indexOf('handleI18nRouting(req)');
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(i18n).toBeGreaterThan(earlyReturn);
    expect(body.slice(0, earlyReturn)).toContain('INTERNAL_RUN_RELAY_PATH');
  });
});

describe('the API end of the relay', () => {
  it('still compares the secret itself, behind the same limiter', () => {
    for (const mount of [
      "app.use('/billing', internalRunLimiter as any, billingRouter)",
      "app.use('/recurring-bookings', internalRunLimiter as any, recurringBookingsRouter)",
      "app.use('/promotion-lifecycle', internalRunLimiter as any, promotionLifecycleRouter)",
    ]) {
      expect(API_APP_CODE).toContain(mount);
    }
  });

  it('keys that limiter on the client rather than on the relay', () => {
    expect(API_APP_CODE).toContain('internalRunClientKey(');
    expect(API_APP_CODE).toContain("req.headers['x-forwarded-for']");
  });

  it('declares the extra hop per route, defaulting to none', () => {
    // Not a higher global TRUST_PROXY_HOPS: that would make Express trust one
    // more caller-supplied X-Forwarded-For entry on every route that is still
    // publicly reachable.
    expect(INTERNAL_RUN_RELAY_HOPS_DEFAULT).toBe(0);
    expect(TRUST_PROXY_HOPS_DEFAULT).toBe(1);
    expect(internalRunRelayHops({} as NodeJS.ProcessEnv)).toBe(0);
    expect(internalRunRelayHops({ INTERNAL_RUN_RELAY_HOPS: '1' } as NodeJS.ProcessEnv)).toBe(1);
    // Nonsense falls back rather than being honoured.
    for (const raw of ['', 'two', '-1', '1.5']) {
      expect(internalRunRelayHops({ INTERNAL_RUN_RELAY_HOPS: raw } as NodeJS.ProcessEnv)).toBe(0);
    }
  });
});

describe('internalRunClientKey', () => {
  const req = {
    ip: '198.51.100.4',
    socketAddress: '10.0.0.1',
    forwardedFor: '203.0.113.7, 198.51.100.4',
  };

  it('is req.ip verbatim with no relay configured', () => {
    expect(internalRunClientKey(req, {} as NodeJS.ProcessEnv)).toBe('198.51.100.4');
  });

  it('answers the client rather than the relay once the relay is declared', () => {
    // Ten wrong guesses keyed on the relay would answer the nightly billing run
    // 429 for the rest of the window (#783: only a 401 spends the budget).
    expect(
      internalRunClientKey(req, {
        INTERNAL_RUN_RELAY_HOPS: '1',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe('203.0.113.7');
  });

  it('adds the relay to the trusted count rather than replacing it', () => {
    expect(
      internalRunClientKey(
        {
          ip: '198.51.100.4',
          socketAddress: '10.0.0.1',
          forwardedFor: '203.0.113.7, 198.51.100.4',
        },
        { TRUST_PROXY_HOPS: '0', INTERNAL_RUN_RELAY_HOPS: '1' } as unknown as NodeJS.ProcessEnv,
      ),
    ).toBe('198.51.100.4');
  });

  it('never answers undefined, so the limiter always has a key', () => {
    expect(
      internalRunClientKey({ ip: undefined, socketAddress: undefined, forwardedFor: undefined }, {
        INTERNAL_RUN_RELAY_HOPS: '1',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe('');
  });
});
