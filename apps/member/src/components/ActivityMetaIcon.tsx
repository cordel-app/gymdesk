import React from 'react';

/**
 * The center / space / trainer icons Activity cards use in the Admin app
 * (#1556), duplicated here because the two apps share no frontend module
 * (#1637). `currentColor` only, so the caller's text colour is the one colour.
 */
export type ActivityMetaIconName = 'center' | 'trainer' | 'space';

const PATHS: Record<ActivityMetaIconName, React.ReactNode> = {
  center: (
    <>
      <path d="M12 21s-6-5.4-6-10a6 6 0 0 1 12 0c0 4.6-6 10-6 10z" />
      <circle cx="12" cy="11" r="2" />
    </>
  ),
  trainer: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  space: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 10h16M10 10v10" />
    </>
  ),
};

export function ActivityMetaIcon({ name, size = 14 }: { name: ActivityMetaIconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {PATHS[name]}
    </svg>
  );
}
