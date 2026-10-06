const createNextIntlPlugin = require('next-intl/plugin');

const withNextIntl = createNextIntlPlugin('./src/i18n.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // #1037 stage 4 — `@gymdesk/charts` ships TypeScript source (an internal
  // workspace package), so Next compiles it with the app rather than consuming a
  // build step the repository does not have.
  transpilePackages: ['@gymdesk/charts'],
  experimental: {
    outputFileTracingIncludes: {
      '/**': ['./locales/**'],
    },
  },
  // #1076 (mobile app WP4) — the two site-association files iOS and Android
  // fetch to decide whether this domain may open the app. They are **rewrites**
  // and not redirects: Apple refuses an association file reached through one,
  // and a rewrite is internal, so the `200` stays on the canonical path. The
  // route handlers serving them live under `app/api/well-known/` because a
  // directory beginning with a dot is not a path the app router is guaranteed
  // to publish, and `assetlinks.json`'s extension belongs to the URL rather
  // than to a route-handler folder name.
  //
  // `src/middleware.ts` never runs on either path — its matcher excludes
  // anything containing a dot, which both `.well-known` paths do
  // (`api/src/test/mobile-app-links.unit.test.ts` asserts that, since the
  // exclusion is what keeps Clerk and the locale redirect off a file Apple
  // fetches with no session and no language).
  async rewrites() {
    return [
      {
        source: '/.well-known/apple-app-site-association',
        destination: '/api/well-known/apple-app-site-association',
      },
      { source: '/.well-known/assetlinks.json', destination: '/api/well-known/assetlinks' },
    ];
  },
};

module.exports = withNextIntl(nextConfig);
