'use client';

import { useEffect } from 'react';
import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';

/**
 * #55: the flat Workout catalog (single workout_id per plan) was superseded
 * by WorkoutTemplate (workout-templates page) — its backend router was
 * removed in the same migration that dropped the old `workouts` table shape.
 * Kept as a redirect rather than deleted outright.
 */
export default function WorkoutsRedirectPage() {
  const locale = useLocale();
  const router = useRouter();
  useEffect(() => { router.replace(`/${locale}/workout-templates`); }, [locale]);
  return null;
}
