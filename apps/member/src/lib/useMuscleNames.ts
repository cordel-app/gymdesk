'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { muscleName } from '@/lib/memberProgress';

/**
 * #2333 stage 4: the muscle names of `GET /me/muscles`, read once per language
 * and shared by every component that labels a muscle. A failed read is not
 * cached (the next mount retries) and leaves the humanised slug on screen.
 */
const cache = new Map<string, Promise<Record<string, string>>>();

export function useMuscleName(): (slug: string) => string {
  const locale = useLocale();
  const { apiFetch } = useApiClient();
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    let pending = cache.get(locale);
    if (!pending) {
      pending = apiFetch<{ key: string; display_name: string }[]>('/me/muscles')
        .then((rows) => Object.fromEntries(rows.map((r) => [r.key, r.display_name])));
      cache.set(locale, pending);
      pending.catch(() => cache.delete(locale));
    }
    pending.then((map) => { if (!cancelled) setNames(map); }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  return useCallback((slug: string) => muscleName(slug, names), [names]);
}
