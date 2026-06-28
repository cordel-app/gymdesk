const createNextIntlPlugin = require('next-intl/plugin');

const withNextIntl = createNextIntlPlugin('./src/i18n.ts');

if (!process.env.BACKEND_URL) {
  throw new Error('BACKEND_URL environment variable is required');
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    BACKEND_URL: process.env.BACKEND_URL,
    TENANT: process.env.TENANT ?? '',
  },
};

module.exports = withNextIntl(nextConfig);
