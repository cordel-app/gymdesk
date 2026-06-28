const createNextIntlPlugin = require('next-intl/plugin');
const { setupDevPlatform } = process.env.NODE_ENV === 'development'
  ? require('@cloudflare/next-on-pages/next-dev')
  : { setupDevPlatform: () => {} };

const withNextIntl = createNextIntlPlugin('./src/i18n.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    TENANT: process.env.TENANT ?? '',
  },
};

if (process.env.NODE_ENV === 'development') setupDevPlatform();

module.exports = withNextIntl(nextConfig);
