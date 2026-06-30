import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import createIntlMiddleware from 'next-intl/middleware';
import { NextRequest, NextResponse } from 'next/server';

const handleI18nRouting = createIntlMiddleware({
  locales: ['en', 'es', 'ca'],
  defaultLocale: 'en',
});

const isPublicRoute = createRouteMatcher([
  '/:locale/sign-in(.*)',
  '/:locale/classes(.*)',
  '/:locale',
  '/api/proxy(.*)',
]);

const clerkHandler = clerkMiddleware(async (auth, req) => {
  if (req.nextUrl.pathname.startsWith('/api/proxy')) {
    return NextResponse.next();
  }
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
  return handleI18nRouting(req) ?? NextResponse.next();
});

export default async function middleware(req: NextRequest) {
  try {
    return await clerkHandler(req, {} as never);
  } catch (e: unknown) {
    if (e instanceof Response) throw e;
    console.error('[middleware] crash:', e);
    const msg = e instanceof Error ? e.message + '\n' + e.stack : String(e);
    return new NextResponse('CLERK_ERROR: ' + msg, { status: 200 });
  }
}

export const config = {
  matcher: [
    '/((?!_next|.*\\..*).*)',
    '/(api|trpc)(.*)',
    '/__clerk/:path*',
  ],
};
