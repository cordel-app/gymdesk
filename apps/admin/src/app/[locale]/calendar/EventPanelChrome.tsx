import type { ReactNode } from 'react';

/**
 * #1892 stage 4 — the one chrome both calendar detail panels wear: the
 * panel surface (border, background, viewport-bounded height) and its
 * header (title, secondary lines, close control). Presentational only: the
 * panels keep their own fields, actions and permission checks, so a custom
 * event and an Activity-based one share a look without sharing behaviour.
 */
export const eventPanelSurfaceStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', height: '100%', maxHeight: '100dvh',
  minWidth: 0, boxSizing: 'border-box',
  borderLeft: '1px solid var(--gd-card-border, #e5e7eb)',
  background: 'var(--gd-card-bg, #fff)',
};

export const eventPanelHeaderStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8,
  flexShrink: 0,
};

export function EventPanelCloseButton({ onClick, label = 'Close' }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      style={{
        background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, lineHeight: 1,
        color: 'var(--gd-text-secondary, #6b7280)', minWidth: 32, minHeight: 32, padding: 4, flexShrink: 0,
      }}
    >
      ×
    </button>
  );
}

export function EventPanelHeader({ title, lines, onClose, closeLabel }: {
  title: ReactNode;
  lines?: ReactNode[];
  onClose: () => void;
  closeLabel?: string;
}) {
  return (
    <div style={eventPanelHeaderStyle}>
      <div style={{ minWidth: 0 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700, overflowWrap: 'anywhere' }}>{title}</h3>
        {(lines ?? []).map((line, i) => (
          <div key={i} style={{ fontSize: 13, color: i === 0 ? '#374151' : '#6b7280' }}>{line}</div>
        ))}
      </div>
      <EventPanelCloseButton onClick={onClose} label={closeLabel} />
    </div>
  );
}
