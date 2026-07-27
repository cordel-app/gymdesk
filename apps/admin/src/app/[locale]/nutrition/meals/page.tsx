import { redirect } from 'next/navigation';

export default function MealsPage({ params }: { params: { locale: string } }) {
  redirect(`/${params.locale}/nutrition/nutrition-library`);
}
