import { redirect } from 'next/navigation';

export default function PaymentProvidersRedirect({ params }: { params: { locale: string } }) {
  redirect(`/${params.locale}/financials/payment-providers`);
}
