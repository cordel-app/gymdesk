const createNextIntlPlugin = require('next-intl/plugin');

const withNextIntl = createNextIntlPlugin('./src/i18n.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // #1037 stage 4 — `@gymdesk/charts` ships TypeScript source (an internal
  // workspace package), so Next compiles it with the app rather than consuming a
  // build step the repository does not have.
  transpilePackages: ['@gymdesk/charts'],
  env: {
    TENANT: process.env.TENANT ?? '',
  },
  experimental: {
    outputFileTracingIncludes: {
      '/**': ['./locales/**'],
    },
  },
};

module.exports = withNextIntl(nextConfig);
