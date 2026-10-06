// #1166 — Grafana's run-freshness alerts read `/health/runs` through the admin app.
//
// The relay is a Next route handler plus a middleware exemption in `apps/admin`,
// and the route it relays to is an Express router here. This file pins the
// admin half by scanning its files, because CI runs `npm test` in `api/` only
// (#1009's reason, the same one that put the Clerk and internal-run relay
// gates here).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..', '..');
const ADMIN = join(ROOT, 'apps', 'admin', 'src');
const MEMBER = join(ROOT, 'apps', 'member', 'src');

const ROUTE_PATH = join(ADMIN, 'app', 'api', 'health', 'runs', 'route.ts');
const MODULE_PATH = join(ADMIN, 'lib', 'healthRunsRelay.ts');

const ROUTE = readFileSync(ROUTE_PATH, 'utf8');
const MODULE = readFileSync(MODULE_PATH, 'utf8');
const MIDDLEWARE = readFileSync(join(ADMIN, 'middleware.ts'), 'utf8');
const API_APP = readFileSync(join(__dirname, '..', 'app.ts'), 'utf8');

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

describe('the relay exists on the admin app, and only there', () => {
  it('is a route handler at the path Grafana is pointed at', () => {
    expect(existsSync(ROUTE_PATH)).toBe(true);
    expect(MODULE_CODE).toContain("export const HEALTH_RUNS_RELAY_PATH = '/api/health/runs'");
  });

  it('is not duplicated on the members app', () => {
    expect(existsSync(join(MEMBER, 'app', 'api', 'health'))).toBe(false);
  });

  it('answers GET and nothing else', () => {
    expect(ROUTE_CODE).toMatch(/export async function GET\b/);
    expect(ROUTE_CODE).not.toMatch(/export (async function|const) (POST|PUT|PATCH|DELETE)\b/);
  });

  it('is resolved per request and runs on Node', () => {
    expect(ROUTE_CODE).toContain("export const dynamic = 'force-dynamic'");
    expect(ROUTE_CODE).toContain("export const runtime = 'nodejs'");
  });
});

describe('it relays one path and nothing else', () => {
  it('names the API route it relays to, which the API still serves', () => {
    expect(MODULE_CODE).toContain("export const HEALTH_RUNS_API_PATH = '/health/runs'");
    expect(API_APP).toMatch(/app\.use\('\/health', healthRouter\)/);
  });

  it('takes no path from the request', () => {
    // A catch-all segment would make this public URL a way into every
    // unauthenticated API route.
    expect(ROUTE_PATH).not.toContain('[');
    expect(ROUTE_CODE).not.toMatch(/params|nextUrl|req\.url/);
  });

  it('forwards no request header', () => {
    expect(ROUTE_CODE).not.toMatch(/headers:\s*(req|relayed)/);
    expect(ROUTE_CODE).not.toMatch(/\breq\b/);
  });

  it('spells no origin of its own', () => {
    expect(ROUTE_CODE).toContain('process.env.CORDEL_FITNESS_API_URL');
    expect(`${ROUTE_CODE}\n${MODULE_CODE}`).not.toMatch(/https?:\/\//);
  });

  it('keeps the decision half pure', () => {
    expect(MODULE_CODE).not.toMatch(/\bfetch\(|next\/server|process\.env/);
  });
});

describe('what it answers', () => {
  it('relays the API’s own status and bytes, never a 200 of its own', () => {
    expect(ROUTE_CODE).toContain('status: res.status');
    expect(ROUTE_CODE).toContain('res.arrayBuffer()');
    expect(ROUTE_CODE).not.toMatch(/res\.text\(\)|res\.json\(\)/);
    expect(ROUTE_CODE).not.toMatch(/status:\s*200/);
  });

  it('answers its own failures with 500, 502 and 504', () => {
    expect(MODULE_CODE).toMatch(/RELAY_UNCONFIGURED_STATUS = 500/);
    expect(MODULE_CODE).toMatch(/RELAY_UNREACHABLE_STATUS = 502/);
    expect(MODULE_CODE).toMatch(/RELAY_TIMEOUT_STATUS = 504/);
    for (const name of ['RELAY_UNCONFIGURED_STATUS', 'RELAY_UNREACHABLE_STATUS', 'RELAY_TIMEOUT_STATUS']) {
      expect(ROUTE_CODE).toContain(`status: ${name}`);
    }
  });

  it('bounds its wait on the API', () => {
    expect(ROUTE_CODE).toContain('AbortSignal.timeout(HEALTH_RUNS_RELAY_TIMEOUT_MS)');
  });
});

describe('the middleware lets Grafana through', () => {
  it('exempts the exact path from auth and from the locale routing', () => {
    expect(MIDDLEWARE_CODE).toContain("import { HEALTH_RUNS_RELAY_PATH } from '@/lib/healthRunsRelay'");
    // In the public-route list, so `auth.protect()` never answers Grafana 401.
    const start = MIDDLEWARE_CODE.indexOf('createRouteMatcher([');
    const publicList = MIDDLEWARE_CODE.slice(start, MIDDLEWARE_CODE.indexOf(']);', start));
    expect(publicList).toContain('HEALTH_RUNS_RELAY_PATH');
    // In the early return, ahead of the i18n call, as an exact match — a
    // prefix match would exempt anything under `/api/health/runs…` too.
    const early = MIDDLEWARE_CODE.indexOf('req.nextUrl.pathname === HEALTH_RUNS_RELAY_PATH');
    expect(early).toBeGreaterThan(-1);
    expect(early).toBeLessThan(MIDDLEWARE_CODE.indexOf('handleI18nRouting(req)'));
    expect(MIDDLEWARE_CODE).not.toContain('startsWith(HEALTH_RUNS_RELAY_PATH)');
  });
});
