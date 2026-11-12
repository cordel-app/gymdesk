'use client';

// #2674 — the caller's Family (`GET /me/family-members`), read once per mount
// for the participant selection. `null` until read or when the read fails; the
// list is the caller first, then the others alphabetically.
import { useEffect, useState } from 'react';
import { useApiClient } from '@/lib/apiClient';
import type { FamilyMember } from '@/lib/familyParticipants';

export interface FamilyMembersRead { member_id: number; members: FamilyMember[] }

export function useFamilyMembers(enabled = true): FamilyMembersRead | null {
  const { apiFetch } = useApiClient();
  const [read, setRead] = useState<FamilyMembersRead | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    apiFetch<FamilyMembersRead>('/me/family-members')
      .then((r) => { if (!cancelled) setRead(r); })
      .catch(() => { if (!cancelled) setRead(null); });
    return () => { cancelled = true; };
  }, [enabled]);
  return read;
}
