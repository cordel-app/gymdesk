import { redirect } from 'next/navigation';

/** #437: standalone Schedule page removed — sessions are managed from Calendar. */
export default function ScheduleRedirect({ params }: { params: { locale: string } }) {
  redirect(`/${params.locale}/calendar`);
}
