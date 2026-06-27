/** @type {import('next').NextConfig} */

if (!process.env.BACKEND_URL) {
  throw new Error('BACKEND_URL environment variable is required');
}

const nextConfig = {
  env: {
    BACKEND_URL: process.env.BACKEND_URL,
  },
};

module.exports = nextConfig;
