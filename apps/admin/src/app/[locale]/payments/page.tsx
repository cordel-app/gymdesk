import { redirect } from 'next/navigation';

export default function PaymentsIndex({ params }: { params: { locale: string } }) {
  redirect(`/${params.locale}/payments/transactions`);
}
