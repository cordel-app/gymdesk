'use client';

import { useEffect } from 'react';
import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';

/**
 * #112: The dedicated training-plan editor page was replaced by inline
 * expandable editing on the Training Plans list. Any bookmarked or linked
 * /training-plans/:id URLs redirect to the list.
 */
export default function TrainingPlanRedirectPage() {
  const locale = useLocale();
  const router = useRouter();
  useEffect(() => { router.replace(`/${locale}/training-plans`); }, []);
  return null;
}
