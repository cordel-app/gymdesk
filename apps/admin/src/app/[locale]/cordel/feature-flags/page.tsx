'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useGym } from '@/context/GymContext';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';

interface FeatureFlag {
  feature_key: string;
  enabled: boolean;
  updated_at: string | null;
  updated_by_name: string | null;
}

// Build a tree from flat dot-separated keys
interface FlagNode {
  key: string;
  children: FlagNode[];
  flag?: FeatureFlag;
}

function buildTree(flags: FeatureFlag[]): FlagNode[] {
  const map = new Map<string, FlagNode>();
  const roots: FlagNode[] = [];

  const sorted = [...flags].sort((a, b) => a.feature_key.localeCompare(b.feature_key));

  for (const flag of sorted) {
    const parts = flag.feature_key.split('.');
    let parentKey = '';
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(0, i + 1).join('.');
      if (!map.has(key)) {
        const node: FlagNode = { key, children: [] };
        map.set(key, node);
        if (i === 0) {
          roots.push(node);
        } else {
          map.get(parentKey)!.children.push(node);
        }
      }
      parentKey = key;
    }
    map.get(flag.feature_key)!.flag = flag;
  }

  return roots;
}

function shortKey(key: string): string {
  const parts = key.split('.');
  return parts[parts.length - 1];
}

export default function FeatureFlagsPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { isSuperadmin, loading: gymLoading } = useGym();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    if (!gymLoading && !isSuperadmin) router.replace(`/${locale}`);
  }, [gymLoading, isSuperadmin]);

  useEffect(() => {
    if (!gymLoading && isSuperadmin) load();
  }, [gymLoading, isSuperadmin]);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch('/platform/feature-flags') as FeatureFlag[];
      setFlags(data);
    } catch {
      toast(t('feature_flags.load_error'), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function toggle(key: string, enabled: boolean) {
    setToggling(key);
    try {
      await apiFetch(`/platform/feature-flags/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      setFlags(prev => prev.map(f => f.feature_key === key ? { ...f, enabled } : f));
      toast(
        enabled ? t('feature_flags.enabled_ok', { key }) : t('feature_flags.disabled_ok', { key }),
        'success',
      );
    } catch {
      toast(t('feature_flags.toggle_error'), 'error');
    } finally {
      setToggling(null);
    }
  }

  if (gymLoading || !isSuperadmin) return null;

  const tree = buildTree(flags);

  function renderNode(node: FlagNode, depth = 0) {
    const flag = node.flag;
    const isToggling = toggling === node.key;
    const label = shortKey(node.key);

    return (
      <div key={node.key}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          padding: '10px 16px',
          paddingLeft: 16 + depth * 24,
          borderBottom: '1px solid var(--gd-border, #e5e7eb)',
          gap: 12,
        }}>
          <div style={{ flex: 1 }}>
            <span style={{
              fontWeight: depth === 0 ? 600 : 400,
              fontSize: depth === 0 ? 15 : 14,
              color: 'var(--gd-text, #111827)',
            }}>
              {label}
            </span>
            <span style={{
              marginLeft: 8,
              fontSize: 12,
              color: 'var(--gd-text-muted, #6b7280)',
              fontFamily: 'monospace',
            }}>
              {node.key}
            </span>
          </div>
          {flag && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {flag.updated_by_name && (
                <span style={{ fontSize: 12, color: 'var(--gd-text-muted, #6b7280)' }}>
                  {flag.updated_by_name}
                </span>
              )}
              <button
                disabled={isToggling}
                onClick={() => toggle(node.key, !flag.enabled)}
                style={{
                  position: 'relative',
                  width: 44,
                  height: 24,
                  borderRadius: 12,
                  border: 'none',
                  cursor: isToggling ? 'not-allowed' : 'pointer',
                  background: flag.enabled ? 'var(--brand, #6c63ff)' : 'var(--gd-border, #d1d5db)',
                  transition: 'background 0.2s',
                  opacity: isToggling ? 0.6 : 1,
                }}
                aria-label={flag.enabled ? t('feature_flags.disable') : t('feature_flags.enable')}
              >
                <span style={{
                  position: 'absolute',
                  top: 3,
                  left: flag.enabled ? 23 : 3,
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  background: '#fff',
                  transition: 'left 0.2s',
                }} />
              </button>
              <span style={{
                fontSize: 13,
                fontWeight: 500,
                color: flag.enabled ? 'var(--gd-success, #16a34a)' : 'var(--gd-text-muted, #6b7280)',
                minWidth: 52,
              }}>
                {flag.enabled ? t('feature_flags.on') : t('feature_flags.off')}
              </span>
            </div>
          )}
        </div>
        {node.children.map(child => renderNode(child, depth + 1))}
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 860 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4, color: 'var(--gd-text, #111827)' }}>
        {t('feature_flags.title')}
      </h1>
      <p style={{ fontSize: 14, color: 'var(--gd-text-muted, #6b7280)', marginBottom: 24 }}>
        {t('feature_flags.description')}
      </p>

      <div style={{
        border: '1px solid var(--gd-border, #e5e7eb)',
        borderRadius: 8,
        overflow: 'hidden',
        background: 'var(--gd-card-bg, #fff)',
      }}>
        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--gd-text-muted, #6b7280)' }}>
            {t('common.loading')}
          </div>
        ) : tree.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--gd-text-muted, #6b7280)' }}>
            {t('feature_flags.empty')}
          </div>
        ) : (
          tree.map(node => renderNode(node))
        )}
      </div>
    </div>
  );
}
