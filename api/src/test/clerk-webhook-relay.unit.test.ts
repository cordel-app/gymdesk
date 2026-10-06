// #1085 — Clerk's webhook reaches the API through the admin app.
//
// Two halves, and neither can see the other: the relay is a Next route handler
// and a middleware exemption in `apps/admin`, and the route it relays to is an
// Express router in `api/src`. This file pins both, the admin half by scanning
// the files, because CI runs `npm test` in `api/` only (#1009's reason, the
// same one that put the mobile, Members App and payment-relay gates here).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..', '..');
const ADMIN = join(ROOT, 'apps', 'admin', 'src');
const MEMBER = join(ROOT, 'apps', 'member', 'src');

const RELAY_ROUTE_PATH = join(ADMIN, 'app', 'api', 'webhooks', 'clerk', 'route.ts');
const RELAY_MODULE_PATH = join(ADMIN, 'lib', 'clerkWebhookRelay.ts');

const ROUTE = readFileSync(RELAY_ROUTE_PATH, 'utf8');
const MODULE = readFileSync(RELAY_MODULE_PATH, 'utf8');
const MIDDLEWARE = readFileSync(join(ADMIN, 'middleware.ts'), 'utf8');
const API_APP = readFileSync(join(__dirname, '..', 'app.ts'), 'utf8');
const API_WEBHOOKS = readFileSync(join(__dirname, '..', 'api', 'webhooks.ts'), 'utf8');

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
const MIDDLEWARE_CODE = code(MIDDLEWARE);

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
  it('is a route handler at the path Clerk is pointed at', () => {
    // dev: https://admin.vdicube.com/api/webhooks/clerk
    // pro: https://admin.cordel.tech/api/webhooks/clerk
    expect(existsSync(RELAY_ROUTE_PATH)).toBe(true);
    expect(quoted(declaration(MODULE_CODE, 'CLERK_WEBHOOK_RELAY_PATH'))).toEqual([
      '/api/webhooks/clerk',
    ]);
  });

  it('is not duplicated on the members app', () => {
    // The two apps have identical middleware and `/api/proxy`, so there is no
    // technical difference between them — admin was chosen, and a second
    // endpoint would be a second thing to keep in step with the Clerk dashboard.
    expect(existsSync(join(MEMBER, 'app', 'api', 'webhooks', 'clerk', 'route.ts'))).toBe(false);
  });

  it('answers POST and nothing else', () => {
    // Unlike Monei, Clerk does not preflight a new endpoint with a GET, so
    // there is no non-POST method to give a 200 to.
    expect(ROUTE_CODE).toMatch(/export async function POST\b/);
    expect(ROUTE_CODE).not.toMatch(/export (async function|const) (GET|PUT|PATCH|DELETE)\b/);
  });

  it('is resolved per request rather than prerendered', () => {
    expect(ROUTE_CODE).toContain("export const dynamic = 'force-dynamic'");
  });
});

describe('the target is configuration, not a literal', () => {
  it('reads CORDEL_FITNESS_API_URL', () => {
    expect(ROUTE_CODE).toContain('process.env.CORDEL_FITNESS_API_URL');
  });

  it('names no API origin anywhere in either half', () => {
    // dev and pro differ and one image serves both.
    for (const source of [ROUTE_CODE, MODULE_CODE]) {
      expect(source).not.toContain('api.vdicube.com');
      expect(source).not.toContain('api.cordel.tech');
    }
  });

  it('appends the API path through the one declaration of it', () => {
    expect(quoted(declaration(MODULE_CODE, 'CLERK_WEBHOOK_API_PATH'))).toEqual(['/webhooks/clerk']);
    expect(ROUTE_CODE).toContain('clerkWebhookTarget(');
    expect(ROUTE_CODE).not.toContain("'/webhooks/clerk'");
  });
});

describe('what crosses the boundary', () => {
  it('forwards the three Svix headers and the content type, and nothing else', () => {
    // The signature covers `svix-id.svix-timestamp.<body>`, so all three are
    // part of its own input: drop one and the API can only answer 400.
    expect(quoted(declaration(MODULE_CODE, 'SVIX_SIGNATURE_HEADERS'))).toEqual([
      'svix-id',
      'svix-timestamp',
      'svix-signature',
    ]);
    const relayed = declaration(MODULE_CODE, 'RELAYED_REQUEST_HEADERS');
    expect(relayed).toContain('...SVIX_SIGNATURE_HEADERS');
    expect(quoted(relayed)).toEqual(['content-type']);
  });

  it('forwards none of /api/proxy’s headers', () => {
    // That route carries `authorization`, `x-gym-id`, `x-center-id`,
    // `x-impersonate-as` and `x-locale` — a caller's own credentials, handed to
    // a route that authenticates by signature alone.
    for (const header of ['authorization', 'cookie', 'x-gym-id', 'x-center-id', 'x-impersonate-as', 'x-locale']) {
      expect(quoted(declaration(MODULE_CODE, 'RELAYED_REQUEST_HEADERS'))).not.toContain(header);
      expect(quoted(declaration(MODULE_CODE, 'SVIX_SIGNATURE_HEADERS'))).not.toContain(header);
    }
  });

  it('builds the forwarded set in one place', () => {
    expect(ROUTE_CODE).toContain('relayedRequestHeaders(req.headers)');
    // Not a second filter in the route, and never the whole header bag.
    expect(ROUTE_CODE).not.toMatch(/headers:\s*req\.headers/);
  });

  it('relays the body as bytes, never as text', () => {
    // #830's rule, applied to a request: a UTF-8 round trip is not byte-exact,
    // and the API verifies the HMAC over the exact bytes Clerk signed.
    expect(ROUTE_CODE).toContain('await req.arrayBuffer()');
    expect(ROUTE_CODE).not.toContain('req.text()');
    expect(ROUTE_CODE).not.toContain('req.json()');
    expect(ROUTE_CODE).not.toContain('JSON.stringify');
  });
});

describe('what Clerk is answered', () => {
  it('relays the API’s own status code', () => {
    expect(ROUTE_CODE).toContain('status: res.status');
  });

  it('never answers a blanket 200', () => {
    // Clerk retries exactly what we report as failed, and a missed
    // `user.deleted` leaves an orphaned Clerk account (#709).
    expect(ROUTE_CODE).not.toMatch(/status:\s*200/);
    expect(ROUTE_CODE).not.toMatch(/new NextResponse\(null\)/);
  });

  it('reports 502 when the API is unreachable and 500 when it is unconfigured', () => {
    expect(declaration(MODULE_CODE, 'RELAY_UNREACHABLE_STATUS')).toContain('502');
    expect(declaration(MODULE_CODE, 'RELAY_UNCONFIGURED_STATUS')).toContain('500');
    expect(ROUTE_CODE).toContain('RELAY_UNREACHABLE_STATUS');
    expect(ROUTE_CODE).toContain('RELAY_UNCONFIGURED_STATUS');
  });

  it('reads the response as bytes too', () => {
    expect(ROUTE_CODE).toContain('await res.arrayBuffer()');
    expect(ROUTE_CODE).not.toContain('res.text()');
  });
});

describe('the relay verifies nothing', () => {
  it('never names the signing secret', () => {
    // It stays in the API, which is the whole point of relaying rather than
    // re-implementing: the relay is a transport, not a second trust boundary.
    // The comments may say so; the code may not name it.
    for (const source of [ROUTE_CODE, MODULE_CODE]) {
      expect(source).not.toContain('CLERK_WEBHOOK_SIGNING_SECRET');
    }
  });

  it('never imports a webhook verifier', () => {
    for (const source of [ROUTE_CODE, MODULE_CODE]) {
      expect(source).not.toContain('verifyWebhook');
      expect(source).not.toContain('@clerk/backend/webhooks');
      // The header names are spelled here; the library is not imported.
      expect(source).not.toMatch(/from 'svix'|require\('svix'\)/);
    }
  });

  it('keeps the decision half pure', () => {
    // No I/O, so what the relay forwards and where is assertable with no
    // server, no Clerk account and no signed payload.
    expect(MODULE_CODE).not.toContain('fetch(');
    expect(MODULE_CODE).not.toContain('process.env');
    expect(MODULE_CODE).not.toContain('next/server');
  });
});

describe('the middleware lets it through', () => {
  it('declares the path public', () => {
    // `auth.protect()` would otherwise answer Clerk with a 401.
    expect(MIDDLEWARE_CODE).toContain('CLERK_WEBHOOK_RELAY_PATH');
    const matcherStart = MIDDLEWARE_CODE.indexOf('createRouteMatcher([');
    expect(matcherStart).toBeGreaterThan(-1);
    const publicRoutes = MIDDLEWARE_CODE.slice(
      matcherStart,
      MIDDLEWARE_CODE.indexOf(']);', matcherStart),
    );
    expect(publicRoutes).toContain('${CLERK_WEBHOOK_RELAY_PATH}');
  });

  it('returns before the i18n routing, as /api/proxy does', () => {
    // The locale middleware would answer Clerk with a redirect to `/en/…`.
    const body = MIDDLEWARE_CODE.slice(MIDDLEWARE_CODE.indexOf('clerkMiddleware(async'));
    const earlyReturn = body.indexOf('return NextResponse.next();');
    const i18n = body.indexOf('handleI18nRouting(req)');
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(i18n).toBeGreaterThan(earlyReturn);
    expect(body.slice(0, earlyReturn)).toContain('CLERK_WEBHOOK_RELAY_PATH');
  });

  it('still matches API paths at all', () => {
    // A matcher that stopped covering `/api/…` would make the exemption moot
    // and the route unreachable through the middleware's own logic.
    expect(MIDDLEWARE_CODE).toContain("'/(api|trpc)(.*)'");
  });
});

describe('the API end of the relay is unchanged', () => {
  it('still parses its own raw body before express.json()', () => {
    const rawMount = API_APP.indexOf("app.use('/webhooks/clerk', express.raw(");
    const jsonMount = API_APP.indexOf('app.use(express.json())');
    expect(rawMount).toBeGreaterThan(-1);
    expect(jsonMount).toBeGreaterThan(rawMount);
  });

  it('still verifies the signature itself', () => {
    expect(API_WEBHOOKS).toContain('verifyWebhook');
    expect(API_WEBHOOKS).toContain('CLERK_WEBHOOK_SIGNING_SECRET');
  });
});
