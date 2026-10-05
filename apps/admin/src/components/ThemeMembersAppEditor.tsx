'use client';

import { useState } from 'react';
import { FONT_STACKS, type ThemeTokens } from '@/lib/themeTokens';
import {
  MEMBERS_APP_SECTIONS,
  effectiveMembersAppValue,
  isMembersAppOverridden,
  membersAppSettingsFor,
  withMembersAppInherited,
  withMembersAppOverride,
  type MembersAppSetting,
} from '@/lib/membersAppTokens';

/**
 * #833 — the Members App's visual settings, inside the existing Theme editor.
 *
 * Both Theme screens render this one component (`[locale]/themes` and
 * `[locale]/system/themes`), so Base Themes and Custom Themes get the same
 * settings, the same inheritance behaviour and the same UI without a second
 * editor anywhere (§15). It edits the caller's token draft and nothing else:
 * it names no endpoint, calls no API and holds no save state, so the Theme
 * editor's existing Save/Cancel and dirty-state machinery covers these
 * settings — including restoring inheritance, which is a token change like any
 * other (§17).
 *
 * There is deliberately no preview of the Members App here (§16): the two are
 * separate applications, and the Members App reads these settings when it
 * renders.
 */
interface Props {
  tokens: ThemeTokens;
  onChange: (next: ThemeTokens) => void;
  /**
   * #1038 — the Members App **Images** subsection: the page's rendered
   * `ThemeMembersImagesEditor`, placed inside this section rather than beside
   * it, because those images are Members App configuration and nothing else
   * configures them. It is a node and not a slot list, so this component keeps
   * knowing nothing about uploads, object keys, previews or removals — the page
   * owns the draft and performs both calls on Save, exactly as it did while the
   * editor was a top-level section.
   *
   * Omitted (the Base Themes screen, for a theme that does not exist yet) the
   * subsection is **absent** rather than rendered empty: there is no id to
   * upload an image to until the theme has been created.
   */
  images?: React.ReactNode;
  // Typed loosely — the caller passes its namespaced `useTranslations()`
  // result, whose key union does not statically admit the dynamic section and
  // label keys this editor maps over.
  t: (key: any) => string;
  readOnly?: boolean;
}

/**
 * The Images subsection's key — both its `openSections` identity and its locale
 * key, exactly as the five setting groups use theirs, so it is named in one
 * place and resolves in whichever namespace the page passed in (`gym_themes` or
 * `themes`).
 */
export const MEMBERS_APP_IMAGES_SECTION = 'group_members_images';

const BADGE: React.CSSProperties = {
  fontSize: 11, padding: '2px 8px', borderRadius: 12, fontWeight: 600,
};

const SECONDARY: React.CSSProperties = {
  fontSize: 11, color: 'var(--gd-text-muted, #999)', marginTop: 2,
};

export function ThemeMembersAppEditor({ tokens, onChange, t, readOnly, images }: Props) {
  // Which sections are expanded. Local to this component and independent per
  // section (a Set, not an accordion), and it never touches `tokens` — the same
  // shape the Colors groups use since #632. All start collapsed.
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());

  function toggleSection(sectionKey: string) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionKey)) next.delete(sectionKey);
      else next.add(sectionKey);
      return next;
    });
  }

  function renderControl(setting: MembersAppSetting) {
    const value = effectiveMembersAppValue(tokens, setting);
    const set = (next: string | number) => onChange(withMembersAppOverride(tokens, setting.key, next));

    if (setting.type === 'font') {
      return (
        <select
          value={String(value)}
          disabled={readOnly}
          onChange={(e) => set(e.target.value)}
          style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #ddd', fontSize: 13, background: '#fff', maxWidth: 160 }}
        >
          {FONT_STACKS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      );
    }
    if (setting.type === 'pixels') {
      return (
        <input
          type="number"
          min={0}
          max={20}
          disabled={readOnly}
          value={Number(value)}
          onChange={(e) => set(Number(e.target.value))}
          style={{ width: 80, padding: '4px 8px', border: '1px solid #ddd', borderRadius: 4, fontSize: 13 }}
        />
      );
    }
    if (setting.type === 'length') {
      return (
        <input
          type="text"
          disabled={readOnly}
          value={String(value)}
          onChange={(e) => set(e.target.value)}
          style={{ width: 110, padding: '4px 8px', border: '1px solid #ddd', borderRadius: 4, fontSize: 13 }}
        />
      );
    }
    return (
      <input
        type="color"
        disabled={readOnly}
        value={String(value)}
        onChange={(e) => set(e.target.value)}
        style={{ width: 48, height: 36, border: '1px solid #ccc', borderRadius: 4, cursor: readOnly ? 'default' : 'pointer', padding: 2 }}
      />
    );
  }

  /**
   * One subsection of this section: the collapsible header and its body. The
   * header chrome is declared **once**, so #1038's Images subsection is the
   * same control as the five setting groups rather than a second accordion look
   * beside them.
   */
  function renderSubsection(sectionKey: string, body: React.ReactNode) {
    const open = openSections.has(sectionKey);
    return (
      <div key={sectionKey} style={{ marginBottom: 10, border: '1px solid var(--gd-border, #eee)', borderRadius: 6, overflow: 'hidden' }}>
        {/* The whole header is the toggle — a <button> so it is keyboard- and
            screen-reader-operable, with the section name (which carries the
            "(Members App)" suffix, §1) as its accessible name. */}
        <button
          type="button"
          onClick={() => toggleSection(sectionKey)}
          aria-expanded={open}
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '10px 12px', background: 'var(--gd-card-bg, #ffffff)', border: 'none', cursor: 'pointer', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'var(--gd-section-heading-text, #888888)', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: 'inherit' }}
        >
          {t(sectionKey)}
          <span style={{ fontSize: 12, color: '#aaa', flexShrink: 0, display: 'inline-block', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
        </button>
        {open && (
          <div style={{ padding: '12px 12px 4px', borderTop: '1px solid var(--gd-border, #eee)' }}>
            {body}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {/* #1038 — Images first, then the settings groups: the images were the
          section above this one, so the reading order the admin had is the one
          they keep. */}
      {images !== undefined && renderSubsection(MEMBERS_APP_IMAGES_SECTION, images)}
      {MEMBERS_APP_SECTIONS.map((sectionKey) => {
        const settings = membersAppSettingsFor(sectionKey);
        return renderSubsection(sectionKey, (
          <>
            {settings.map((setting) => {
              const overridden = isMembersAppOverridden(tokens, setting.key);
              return (
                <div
                  key={setting.key}
                  style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}
                >
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{t(setting.labelKey)}</div>
                    {/* §9 / §10 — a secondary line under the control saying
                        either which Admin setting the value comes from, or
                        that it no longer comes from one. */}
                    <div style={SECONDARY}>
                      {overridden
                        ? t('members_custom_value')
                        : `${t('members_inherited_from')} ${t(setting.source.labelKey)}`}
                    </div>
                  </div>

                  <span style={{ ...BADGE, background: overridden ? '#e8f0fe' : '#f0f0f0', color: overridden ? '#1a56db' : '#666' }}>
                    {overridden ? t('adv_badge_custom') : t('adv_badge_inherited')}
                  </span>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {renderControl(setting)}
                    {/* §11 — per-setting, and it removes the override
                        rather than writing the Admin value into it, so the
                        setting goes back to following Admin. */}
                    {overridden && !readOnly && (
                      <button
                        type="button"
                        onClick={() => onChange(withMembersAppInherited(tokens, setting.key))}
                        style={{ background: 'none', border: '1px solid #ddd', cursor: 'pointer', color: '#666', fontSize: 11, padding: '4px 8px', borderRadius: 4, whiteSpace: 'nowrap' }}
                      >
                        {t('members_restore_inherited')}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        ));
      })}
    </div>
  );
}
