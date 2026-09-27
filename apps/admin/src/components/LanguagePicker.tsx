'use client';

import { useLocale } from 'next-intl';
import { useRouter, usePathname } from 'next/navigation';
import { headerOptionStyle } from './headerChrome';

const languages = [
  { code: 'es', label: 'Español' },
  { code: 'ca', label: 'Català' },
  { code: 'en', label: 'English' },
];

export function LanguagePicker() {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const newLocale = e.target.value;
    const pathWithoutLocale = pathname.replace(/^\/(en|es|ca)/, '') || '/';
    router.push(`/${newLocale}${pathWithoutLocale}`);
  }

  return (
    <select
      value={locale}
      onChange={handleChange}
      style={{
        background: 'rgba(255,255,255,0.15)',
        color: 'inherit',
        border: '1px solid rgba(255,255,255,0.3)',
        borderRadius: 6,
        padding: '6px 12px',
        fontSize: 14,
        cursor: 'pointer',
      }}
    >
      {languages.map(({ code, label }) => (
        // #808: the dropdown the browser opens is painted outside the header,
        // from the UA's defaults — white text (inherited from the header) on a
        // white popup. Each option carries the header's own pair instead, so
        // the list reads as a continuation of the band it drops out of.
        <option key={code} value={code} style={headerOptionStyle}>
          {label}
        </option>
      ))}
    </select>
  );
}
