import { getRequestConfig } from 'next-intl/server';
import { readFileSync } from 'fs';
import { join } from 'path';

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overrideVal = override[key];
    if (typeof baseVal === 'object' && baseVal !== null && typeof overrideVal === 'object' && overrideVal !== null) {
      result[key] = deepMerge(baseVal as Record<string, unknown>, overrideVal as Record<string, unknown>);
    } else {
      result[key] = overrideVal;
    }
  }
  return result;
}

export default getRequestConfig(async ({ requestLocale }) => {
  const locale = (await requestLocale) ?? 'en';

  const basePath = join(process.cwd(), 'locales', 'base', `${locale}.json`);
  const base = JSON.parse(readFileSync(basePath, 'utf-8'));

  let messages = base;
  if (process.env.TENANT) {
    try {
      const tenantPath = join(process.cwd(), 'locales', 'tenants', process.env.TENANT, `${locale}.json`);
      const tenant = JSON.parse(readFileSync(tenantPath, 'utf-8'));
      messages = deepMerge(base, tenant);
    } catch {
      // no tenant override for this locale — use base only
    }
  }

  return { locale, messages };
});
