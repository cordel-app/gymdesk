import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import createIntlMiddleware from 'next-intl/middleware';
import { NextResponse } from 'next/server';
// #1039: the app's languages are declared once (`lib/memberLocale.ts`) — this
// middleware, the My Profile selector and the stored-preference redirect all
// read that one list, so there is no second language system (§2).
import { DEFAULT_MEMBER_LOCALE, MEMBER_LOCALES } from '@/lib/memberLocale';

const handleI18nRouting = createIntlMiddleware({
  locales: [...MEMBER_LOCALES],
  defaultLocale: DEFAULT_MEMBER_LOCALE,
});

const isPublicRoute = createRouteMatcher([
  '/:locale/sign-in(.*)',
  '/:locale/classes(.*)',
  // /link redeems a Clerk invitation ticket to establish the session in the
  // first place — the visitor is by definition unauthenticated until it runs.
  '/:locale/link(.*)',
  '/:locale',
  '/',
  '/api/proxy(.*)',
]);

export default clerkMiddleware(async (auth, req) => {
  if (req.nextUrl.pathname.startsWith('/api/proxy')) {
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
