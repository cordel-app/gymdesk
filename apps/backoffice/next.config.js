const createNextIntlPlugin = require('next-intl/plugin');

const withNextIntl = createNextIntlPlugin('./src/i18n.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
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
