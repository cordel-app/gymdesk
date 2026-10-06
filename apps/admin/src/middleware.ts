import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import createIntlMiddleware from 'next-intl/middleware';
import { NextResponse } from 'next/server';
// #1085: the one path Clerk posts its webhook to, declared beside what the
// relay forwards so the route and the rule that exempts it cannot drift.
import { CLERK_WEBHOOK_RELAY_PATH } from '@/lib/clerkWebhookRelay';
// #1086: the one prefix the GitHub Actions nightly runs call, declared beside
// what that relay forwards for the same reason.
import { INTERNAL_RUN_RELAY_PATH } from '@/lib/internalRunRelay';
// #1166: the one path Grafana's run-freshness alerts read, declared beside the
// relay for the same reason.
import { HEALTH_RUNS_RELAY_PATH } from '@/lib/healthRunsRelay';
// #1175: the one route shape gym websites post sign-ups to, declared beside
// the relay for the same reason.
import { isPublicRegistrationRelayPath } from '@/lib/publicRegistrationRelay';

const handleI18nRouting = createIntlMiddleware({
  locales: ['en', 'es', 'ca'],
  defaultLocale: 'en',
});

const isPublicRoute = createRouteMatcher([
  '/:locale/sign-in(.*)',
  '/:locale/sign-up(.*)',
  '/:locale/no-gym(.*)',
  '/:locale/privacy',
  '/privacy',
  '/:locale',
  '/',
  '/api/proxy(.*)',
  // #1085: Clerk authenticates by Svix signature, which the API verifies —
  // `auth.protect()` would answer it with a 401 before it ever got there.
  `${CLERK_WEBHOOK_RELAY_PATH}(.*)`,
  // #1086: the nightly runs authenticate with `X-Internal-Secret`, which the
  // API compares — `auth.protect()` would answer the workflow with a 401
  // (or a redirect) before it ever got there, and a missed billing night is a
  // day nobody is charged on.
  `${INTERNAL_RUN_RELAY_PATH}(.*)`,
  // #1166: `/health/runs` is unauthenticated by design (#782) and Grafana
  // carries no Clerk session — a 401 here would fire both freshness alerts.
  HEALTH_RUNS_RELAY_PATH,
]);

export default clerkMiddleware(async (auth, req) => {
  // All of these must also skip the i18n routing below, which would answer
  // Clerk, GitHub's runners, Grafana, gym websites (and the browser's proxy calls) with a redirect to
  // a locale prefix.
  if (
    req.nextUrl.pathname.startsWith('/api/proxy') ||
    req.nextUrl.pathname.startsWith(CLERK_WEBHOOK_RELAY_PATH) ||
    req.nextUrl.pathname.startsWith(INTERNAL_RUN_RELAY_PATH) ||
    req.nextUrl.pathname === HEALTH_RUNS_RELAY_PATH ||
    // #1175: a gym's website authenticates with its own `x-api-key`, which the
    // API compares, and carries no Clerk session. An exact shape rather than a
    // prefix, so nothing else under `/api/public` is exempt.
    isPublicRegistrationRelayPath(req.nextUrl.pathname)
  ) {
    return NextResponse.next();
  }
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
  return handleI18nRouting(req) ?? NextResponse.next();
});

export const config = {
  matcher: [
    '/((?!_next|.*\\..*).*)',
    '/(api|trpc)(.*)',
    '/__clerk/:path*',
  ],
};
