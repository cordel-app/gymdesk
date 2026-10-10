'use client';

// #1246 stage 5 — the gym's Time & Localization settings for a Members App
// screen. `DEFAULT_GYM_FORMAT` until the read answers, and it stays on it when
// the read fails, so a screen never renders blank because of a settings failure.
import { useEffect, useState } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { useApp } from '@/context/AppContext';
import { DEFAULT_GYM_FORMAT, type GymFormatSettings } from '@/lib/gymFormat';

// One read per gym per page load: each hook instance would otherwise ask again.
const inflight = new Map<string, Promise<GymFormatSettings | null>>();

export function useGymFormatSettings(): GymFormatSettings {
  const { apiFetch } = useApiClient();
  const { gymId } = useApp();
  const [settings, setSettings] = useState<GymFormatSettings>(DEFAULT_GYM_FORMAT);

  useEffect(() => {
    if (!gymId) return;
    let cancelled = false;
    (async () => {
      try {
        let pending = inflight.get(gymId);
        if (!pending) {
          pending = (apiFetch('/me/localization') as Promise<GymFormatSettings | null>).catch((e) => {
            inflight.delete(gymId);
            throw e;
          });
          inflight.set(gymId, pending);
        }
        const s = await pending;
        if (!cancelled && s) setSettings({ ...DEFAULT_GYM_FORMAT, ...s });
      } catch {
        if (!cancelled) setSettings(DEFAULT_GYM_FORMAT);
      }
    })();
    return () => { cancelled = true; };
  }, [apiFetch, gymId]);

  return settings;
}
