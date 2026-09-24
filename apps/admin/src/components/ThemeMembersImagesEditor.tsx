'use client';

import { useRef } from 'react';
import { btnSmall } from '@/components/ui';

// #725: the Members App background images of one Custom Theme — six fixed
// slots, one per Members section, edited inside the existing Theme editor.
//
// Presentational, like the rest of `ThemeSectionEditor`: it never fetches,
// never uploads and never persists. The page owns the draft (a picked file, a
// queued removal) and performs both calls on Save, which is what makes
// "Upload + Cancel does not persist" and "Remove + Cancel preserves the
// existing reference" true — the same lifecycle the logo has had since #188.

/** The six slots, in the order the Members App presents the sections. */
export const MEMBER_IMAGE_SLOTS = ['training', 'nutrition', 'calendar', 'bookings', 'membership', 'background'] as const;

export type MemberImageSlot = (typeof MEMBER_IMAGE_SLOTS)[number];

/** What the API returns on a theme: one nullable URL per slot. */
export type MembersImages = Record<`${MemberImageSlot}_url`, string | null>;

/** Accepted by the server (`MEMBER_IMAGE_MIME_TYPES`) — kept in step by hand. */
export const MEMBER_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp';

/** 4 MB, the server's `MEMBER_IMAGE_MAX_BYTES`; rejected here too, for a
 *  message the admin gets before the upload rather than after it. */
export const MEMBER_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

interface ThemeMembersImagesEditorProps {
  /** Per slot: the URL/data-URL to show, or null for "not configured". */
  previews: Record<MemberImageSlot, string | null>;
  onPick: (slot: MemberImageSlot, file: File) => void;
  onRemove: (slot: MemberImageSlot) => void;
  /** Typed loosely — callers pass their namespaced `useTranslations()`. */
  t: (key: any) => string;
  /** A Base Theme viewed from a gym: Members images are out of scope for it. */
  readOnly?: boolean;
}

export function ThemeMembersImagesEditor({ previews, onPick, onRemove, t, readOnly = false }: ThemeMembersImagesEditorProps) {
  return (
    <div>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: '#888' }}>{t('members_images_hint')}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16 }}>
        {MEMBER_IMAGE_SLOTS.map((slot) => (
          <MemberImageSlotField
            key={slot}
            slot={slot}
            preview={previews[slot]}
            onPick={onPick}
            onRemove={onRemove}
            t={t}
            readOnly={readOnly}
          />
        ))}
      </div>
    </div>
  );
}

function MemberImageSlotField({
  slot,
  preview,
  onPick,
  onRemove,
  t,
  readOnly,
}: {
  slot: MemberImageSlot;
  preview: string | null;
  onPick: (slot: MemberImageSlot, file: File) => void;
  onRemove: (slot: MemberImageSlot) => void;
  t: (key: any) => string;
  readOnly: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div>
      <p style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600 }}>{t(`members_image_${slot}`)}</p>
      <div
        style={{
          height: 96,
          borderRadius: 6,
          border: '1px solid #eee',
          // The preview is the background of its own box, `cover` and centred —
          // the same treatment the Members App gives it, so what the admin sees
          // here is what the member gets.
          background: preview ? `center / cover no-repeat url(${JSON.stringify(preview)})` : 'var(--gd-app-bg, #f5f5f5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 8,
        }}
      >
        {!preview && <span style={{ fontSize: 12, color: '#888' }}>{t('members_image_none')}</span>}
      </div>
      {!readOnly && (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={() => fileInputRef.current?.click()} style={btnSmall('#444')}>
              {t('members_image_upload')}
            </button>
            {preview && (
              <button type="button" onClick={() => onRemove(slot)} style={btnSmall('#c0392b')}>
                {t('members_image_remove')}
              </button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={MEMBER_IMAGE_ACCEPT}
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onPick(slot, file);
              // Reset so picking the same file twice still fires a change.
              e.target.value = '';
            }}
          />
        </>
      )}
    </div>
  );
}
