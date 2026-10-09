'use client';

// #1246 stage 2 — the active gym's Time & Localization settings for a screen
// that formats dates (the Calendar). The value is `DEFAULT_GYM_FORMAT` until the
// read answers, and stays on it when the caller may not read the settings, so a
// screen never renders blank because of a settings failure.
import { useEffect, useState } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { DEFAULT_GYM_FORMAT, type GymFormatSettings } from '@/lib/gymFormat';

// One read per gym per page load: every screen that formats a date asks for the
// settings, so each hook instance would otherwise issue its own request.
const inflight = new Map<string, Promise<GymFormatSettings | null>>();

export function useGymFormatSettings(): GymFormatSettings {
  const { apiFetch } = useApiClient();
  const { activeGymId } = useGym();
  const [settings, setSettings] = useState<GymFormatSettings>(DEFAULT_GYM_FORMAT);

  useEffect(() => {
    if (!activeGymId) return;
    let cancelled = false;
    (async () => {
      try {
        let pending = inflight.get(activeGymId);
        if (!pending) {
          pending = (apiFetch('/system/localization') as Promise<GymFormatSettings | null>).catch((e) => {
            inflight.delete(activeGymId);
            throw e;
          });
          inflight.set(activeGymId, pending);
        }
        const s = await pending;
        if (!cancelled && s) setSettings({ ...DEFAULT_GYM_FORMAT, ...s });
      } catch {
        if (!cancelled) setSettings(DEFAULT_GYM_FORMAT);
      }
    })();
    return () => { cancelled = true; };
  }, [apiFetch, activeGymId]);

  return settings;
}
