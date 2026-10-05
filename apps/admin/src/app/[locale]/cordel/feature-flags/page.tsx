'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useGym } from '@/context/GymContext';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { Tabs, type TabDescriptor } from '@/components/Tabs';
import { featureFlagLabelKey, featureKeyShortName } from '@/lib/featureFlagLabels';
// #1070 §3: the app's one red, so an overridden permission is marked in the
// colour a destructive menu item and a failed save already use rather than a
// hue this page invents.
import { alertTextColor } from '@/components/formChrome';

interface FeatureFlag {
  feature_key: string;
  enabled: boolean;
  updated_at: string | null;
  updated_by_name: string | null;
}

type RoleAccessLevel = '-' | 'R' | 'RW';

interface RoleAccessData {
  roles: { role: string; label: string }[];
  /** The module matrix a feature **inherits**, keyed by the key's first segment. */
  access: Record<string, Record<string, RoleAccessLevel>>;
  /**
   * #1070: the feature-level overrides, keyed by the **full** feature key — only
   * the keys that declare one. An override is the explicit decision that a role
   * has this level on this feature whatever its module gives it, so it is
   * reported apart from `access` and rendered apart from it.
   */
  overrides?: Record<string, Record<string, RoleAccessLevel>>;
}

const ROLE_COL_WIDTH = 64;
const MODIFIED_BY_COL_WIDTH = 160;

// #1068: the Members App's flags live under the `member_web` root; every other
// root belongs to the admin app. The split is derived from the key so a new
// member_web.* flag lands in its tab without a list to maintain.
const MEMBER_WEB_ROOT = 'member_web';
type FlagTab = 'admin' | 'member_web';
const FLAG_TABS: readonly TabDescriptor<FlagTab>[] = [
  { id: 'admin', labelKey: 'tab_admin' },
  { id: 'member_web', labelKey: 'tab_member_web' },
];

function isMemberWebFlag(key: string): boolean {
  return key === MEMBER_WEB_ROOT || key.startsWith(`${MEMBER_WEB_ROOT}.`);
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
  const [roleAccess, setRoleAccess] = useState<RoleAccessData | null>(null);
  const [tab, setTab] = useState<FlagTab>('admin');

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
      setRoleAccess(await apiFetch('/platform/feature-flags/role-access') as RoleAccessData);
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
      // Re-read so Modified by shows the name the server recorded.
      setFlags(await apiFetch('/platform/feature-flags') as FeatureFlag[]);
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

  const tree = buildTree(flags.filter(f => isMemberWebFlag(f.feature_key) === (tab === 'member_web')));
  const hasOverrides = Object.keys(roleAccess?.overrides ?? {}).length > 0;

  function renderNode(node: FlagNode, depth = 0) {
    const flag = node.flag;
    const isToggling = toggling === node.key;
    // #1070 §1: the name the application itself shows for this section, from the
    // navigation's own declaration. Resolved **before** `t()` is called, because
    // next-intl has no `defaultValue` and prints a missing key verbatim — a key
    // the navigation does not gate keeps the short key this page always showed.
    const labelKey = featureFlagLabelKey(node.key);
    const label = labelKey ? t(labelKey) : featureKeyShortName(node.key);

    return (
      <div key={node.key}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          padding: '10px 16px',
          paddingLeft: 16 + depth * 24,
          borderBottom: '1px solid var(--gd-border, #e5e7eb)',
          gap: 12,
          minWidth: 'max-content',
        }}>
          <div style={{ flex: 1, minWidth: 200 }}>
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
          {roleAccess?.roles.map(r => {
            // #1070 §3: this feature's own override wins over the module level it
            // would otherwise inherit, and is the only value drawn in red — the
            // row keeps its own colours, and an inherited value keeps the
            // styling it had.
            const override = roleAccess.overrides?.[node.key]?.[r.role];
            const level = override ?? roleAccess.access[node.key.split('.')[0]]?.[r.role];
            return (
              <span
                key={r.role}
                title={override ? t('feature_flags.override_hint', { role: r.label, level: override }) : undefined}
                style={{
                  width: ROLE_COL_WIDTH, flexShrink: 0, textAlign: 'center', fontSize: 12,
                  fontFamily: 'monospace',
                  fontWeight: override ? 600 : level === 'RW' ? 600 : 400,
                  color: override
                    ? alertTextColor
                    : level === 'RW' ? 'var(--gd-text, #111827)' : 'var(--gd-text-muted, #6b7280)',
                }}
              >
                {level ?? ''}
              </span>
            );
          })}
          {flag && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: 130, flexShrink: 0 }}>
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
          <span style={{
            width: MODIFIED_BY_COL_WIDTH, flexShrink: 0, fontSize: 12,
            color: 'var(--gd-text-muted, #6b7280)',
          }}>
            {flag?.updated_by_name || '—'}
          </span>
        </div>
        {node.children.map(child => renderNode(child, depth + 1))}
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1400 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4, color: 'var(--gd-text, #111827)' }}>
        {t('feature_flags.title')}
      </h1>
      <p style={{ fontSize: 14, color: 'var(--gd-text-muted, #6b7280)', marginBottom: 8 }}>
        {t('feature_flags.description')}
      </p>
      <p style={{ fontSize: 13, color: 'var(--gd-text-muted, #6b7280)', marginBottom: 24 }}>
        {roleAccess && t('feature_flags.role_access_hint')}
        {hasOverrides && (
          // #1070 §3: says in words what the red says in colour, so the
          // distinction between an inherited permission and an explicit override
          // does not rest on colour alone.
          <>
            {' '}
            <span style={{ color: alertTextColor, fontWeight: 600 }}>
              {t('feature_flags.override_legend')}
            </span>
          </>
        )}
      </p>

      <Tabs
        tabs={FLAG_TABS}
        active={tab}
        onChange={setTab}
        label={key => t(`feature_flags.${key}`)}
      />

      <div style={{
        border: '1px solid var(--gd-border, #e5e7eb)',
        borderRadius: 8,
        overflow: 'hidden',
        background: 'var(--gd-card-bg, #fff)',
        overflowX: 'auto',
      }}>
        {!loading && roleAccess && (
          <div style={{
            display: 'flex', alignItems: 'center', padding: '8px 16px', gap: 12, minWidth: 'max-content',
            borderBottom: '1px solid var(--gd-border, #e5e7eb)', fontSize: 12, fontWeight: 600,
            color: 'var(--gd-text-muted, #6b7280)',
          }}>
            <div style={{ flex: 1, minWidth: 200 }}>{t('feature_flags.col_feature')}</div>
            {roleAccess.roles.map(r => (
              <span key={r.role} title={r.role} style={{ width: ROLE_COL_WIDTH, flexShrink: 0, textAlign: 'center' }}>
                {r.label}
              </span>
            ))}
            <div style={{ width: 130, flexShrink: 0 }}>{t('feature_flags.col_enabled')}</div>
            <div style={{ width: MODIFIED_BY_COL_WIDTH, flexShrink: 0 }}>{t('feature_flags.col_modified_by')}</div>
          </div>
        )}
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
