'use client';

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';

interface LibraryItem { id: number; name: string; category: string }

const CATEGORIES = ['main_dish', 'side', 'sauce', 'drink', 'dessert', 'other'] as const;

export default function NutritionLibraryPage() {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<LibraryItem[]>('/nutrition-library')
      .then(setItems)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p>{t('nutrition_library.loading')}</p>;

  return (
    <div>
      <h1 style={{ marginBottom: 32 }}>{t('nutrition_library.title')}</h1>
      {CATEGORIES.map((cat) => {
        const catItems = items.filter((i) => i.category === cat);
        return (
          <div key={cat} style={{ marginBottom: 36 }}>
            <h2 style={{ fontSize: 18, marginBottom: 12, color: '#374151' }}>
              {t(`nutrition_library.category_${cat}`)}
            </h2>
            {catItems.length === 0 ? (
              <p style={{ color: '#9ca3af', fontSize: 14 }}>{t('nutrition_library.empty_section')}</p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {catItems.map((item) => (
                  <span key={item.id} style={itemBadgeStyle}>{item.name}</span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const itemBadgeStyle: React.CSSProperties = {
  background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 20,
  padding: '5px 14px', fontSize: 14, fontWeight: 500, color: '#374151',
};
