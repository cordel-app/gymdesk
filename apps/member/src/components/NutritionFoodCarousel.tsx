'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { NutritionFoodCard } from './NutritionFoodCard';
import { BlockExerciseCarousel } from './BlockExerciseCarousel';
import { NutritionFoodItem } from '@/lib/nutritionFood';

/**
 * #722 / #1875 — the foods of one meal, as the same horizontal carousel My
 * Training uses for a block's exercises (`BlockExerciseCarousel`): overlaid
 * arrows and a "1 of 3" position line under the track. The slider mechanics
 * (scroll snapping, keyboard, scroll-derived position) live in that one
 * component; this wrapper only supplies the food cards and the resolved labels.
 */
export function NutritionFoodCarousel({ items, label }: {
  items: NutritionFoodItem[];
  label: string;
}) {
  const t = useTranslations();
  if (items.length === 0) return null;

  return (
    <BlockExerciseCarousel
      groupLabel={t('nutrition.carousel_label', { meal: label })}
      prevLabel={t('nutrition.previous_food')}
      nextLabel={t('nutrition.next_food')}
      positionLabel={(current, total) => t('nutrition.carousel_position', { current, total })}
      cards={items.map((item, index) => (
        <NutritionFoodCard key={item.id} item={item} eager={index === 0} />
      ))}
    />
  );
}
