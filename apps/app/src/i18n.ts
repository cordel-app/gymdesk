import { getRequestConfig } from 'next-intl/server';
import { readFileSync } from 'fs';
import { join } from 'path';

export default getRequestConfig(async ({ requestLocale }) => {
  const locale = (await requestLocale) ?? 'en';
  const basePath = join(process.cwd(), 'locales', 'base', `${locale}.json`);
  const messages = JSON.parse(readFileSync(basePath, 'utf-8'));
  return { locale, messages };
});
