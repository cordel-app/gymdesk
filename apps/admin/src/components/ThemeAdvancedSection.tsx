'use client';

import { useTranslations } from 'next-intl';
import { ADVANCED_ATTRIBUTES, DEFAULT_ADVANCED } from '@/lib/themeTokens';

interface Props {
  advanced: Record<string, string | number | boolean | null>;
  onChange: (next: Record<string, string | number | boolean | null>) => void;
  namespace: string; // 'gym_themes' or 'themes'
  group: string; // one of COLOR_GROUPS' groupKey values — renders only this group's attributes
  // #678 — a theme that cannot be edited on this screen (a Base Theme seen from
  // a gym) still lists its attributes; the controls are disabled and the
  // restore-to-inherited action is not offered.
  readOnly?: boolean;
}

const SOURCE_BADGE: React.CSSProperties = {
  fontSize: 11, padding: '2px 8px', borderRadius: 12, fontWeight: 600,
};

// Renders the fine-grained attributes for one theme editor section (e.g. Header, Buttons),
// inline below that section's color pickers — see #489 stage 2, which retired the standalone
// "Advanced" section in favor of grouping every attribute with its component.
export function ThemeAdvancedSection({ advanced, onChange, namespace, group, readOnly }: Props) {
  const t = useTranslations(namespace as any);

  function getValue(key: string): string | number | boolean {
    const v = advanced[key];
    return v !== null && v !== undefined ? v : DEFAULT_ADVANCED[key];
  }

  function isCustom(key: string): boolean {
    return advanced[key] !== null && advanced[key] !== undefined;
  }

  function set(key: string, value: string | number | boolean) {
    onChange({ ...advanced, [key]: value });
  }

  function restore(key: string) {
    const next = { ...advanced };
    delete next[key];
    onChange(next);
  }

  const attrs = ADVANCED_ATTRIBUTES.filter((a) => a.group === group);
  if (attrs.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {attrs.map((attr) => {
        const custom = isCustom(attr.key);
        const value = getValue(attr.key);
        const inherited = DEFAULT_ADVANCED[attr.key];
        return (
          <div key={attr.key} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>{t(attr.labelKey as any)}</div>
              {!custom && attr.type !== 'color' && (
                <div style={{ fontSize: 11, color: '#aaa' }}>{String(inherited)}</div>
              )}
            </div>

            <span style={{ ...SOURCE_BADGE, background: custom ? '#e8f0fe' : '#f0f0f0', color: custom ? '#1a56db' : '#666' }}>
              {custom ? t('adv_badge_custom' as any) : t('adv_badge_inherited' as any)}
            </span>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {attr.type === 'boolean' ? (
                <input
                  type="checkbox"
                  checked={Boolean(value)}
                  disabled={readOnly}
                  onChange={(e) => set(attr.key, e.target.checked)}
                  style={{ width: 16, height: 16, cursor: readOnly ? 'default' : 'pointer' }}
                />
              ) : attr.type === 'select' ? (
                <select
                  value={String(value)}
                  disabled={readOnly}
                  onChange={(e) => set(attr.key, e.target.value)}
                  style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #ddd', fontSize: 13, background: '#fff' }}
                >
                  {attr.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : attr.type === 'color' ? (
                <input
                  type="color"
                  value={String(value)}
                  disabled={readOnly}
                  onChange={(e) => set(attr.key, e.target.value)}
                  style={{ width: 40, height: 30, border: '1px solid #ddd', borderRadius: 4, cursor: readOnly ? 'default' : 'pointer', padding: 2 }}
                />
              ) : (
                <input
                  type="text"
                  value={String(value)}
                  disabled={readOnly}
                  onChange={(e) => set(attr.key, e.target.value)}
                  style={{ width: 110, padding: '4px 8px', borderRadius: 4, border: '1px solid #ddd', fontSize: 13 }}
                />
              )}
              {custom && !readOnly && (
                <button
                  type="button"
                  onClick={() => restore(attr.key)}
                  title={t('adv_restore_inherited' as any)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#888', fontSize: 12, padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap' }}
                >
                  ↺
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
