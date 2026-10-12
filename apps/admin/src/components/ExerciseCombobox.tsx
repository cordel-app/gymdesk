'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { exerciseMatchesQuery, exerciseName } from '@/lib/exerciseNames';
import {
  TREE_COMBO_ITEM_SELECTED_BG, treeComboCaretStyle, treeComboDropdownStyle, treeComboItemEmptyStyle,
  treeComboItemStyle, treeComboListStyle, treeComboPlaceholderStyle, treeComboSearchStyle,
  treeComboTriggerStyle,
} from '@/components/workoutChrome';

export interface ExerciseComboOption {
  id: number; name: string;
  /** #967: the name in the user's language, and the stored translations a search also matches. */
  display_name?: string | null; translations?: Record<string, string> | null;
}

const PANEL_MIN_WIDTH = 220;
const PANEL_MAX_HEIGHT = 280; // search field + the list's 220px
const GAP = 2;
const EDGE = 8;

/**
 * The searchable exercise picker shared by Assigned Training Plans and Workout
 * Templates (#1525). The panel is rendered in a portal with fixed positioning,
 * so no workout, block or table container (`overflow: auto`) can clip it; it
 * follows its trigger on scroll/resize, opens upwards when there is no room
 * below and is kept inside the viewport horizontally.
 */
export function ExerciseCombobox<T extends ExerciseComboOption>({ value, options, placeholder, onChange }: {
  value: number | null;
  options: T[];
  placeholder: string;
  onChange: (opt: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<React.CSSProperties | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.id === value);
  // #967 §7: the same three things the API's `?q=` matches — the displayed
  // name, the base name and every stored translation.
  const filtered = query ? options.filter((o) => exerciseMatchesQuery(o, query)) : options;

  const place = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.max(PANEL_MIN_WIDTH, r.width);
    const left = Math.max(EDGE, Math.min(r.left, vw - width - EDGE));
    const below = vh - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const openUp = below < PANEL_MAX_HEIGHT && above > below;
    const room = Math.max(120, openUp ? above : below);
    setPos({
      position: 'fixed', left, width,
      ...(openUp ? { bottom: vh - r.top + GAP, top: 'auto' } : { top: r.bottom + GAP, bottom: 'auto' }),
      maxHeight: room, display: 'flex', flexDirection: 'column', marginTop: 0,
    });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      const n = e.target as Node;
      if (containerRef.current?.contains(n) || panelRef.current?.contains(n)) return;
      setOpen(false);
      setQuery('');
    }
    document.addEventListener('mousedown', handleClick);
    // capture: scrolling any ancestor (not just the window) moves the trigger.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  function handleOpen() {
    setOpen(true);
    setQuery('');
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function pick(opt: T) {
    onChange(opt);
    setOpen(false);
    setQuery('');
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', minWidth: 160 }}>
      <button type="button" onClick={handleOpen} style={treeComboTriggerStyle}>
        {selected ? exerciseName(selected) : <span style={treeComboPlaceholderStyle}>{placeholder}</span>}
        <span style={treeComboCaretStyle}>▾</span>
      </button>
      {open && pos && typeof document !== 'undefined' && createPortal(
        <div ref={panelRef} style={{ ...treeComboDropdownStyle, ...pos }}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            style={treeComboSearchStyle}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setOpen(false); setQuery(''); }
              if (e.key === 'Enter' && filtered.length === 1) pick(filtered[0]);
            }}
          />
          <ul style={{ ...treeComboListStyle, flex: '1 1 auto', minHeight: 0 }}>
            {filtered.length === 0 && <li style={treeComboItemEmptyStyle}>—</li>}
            {filtered.map((opt) => (
              <li
                key={opt.id}
                onMouseDown={() => pick(opt)}
                style={{ ...treeComboItemStyle, background: opt.id === value ? TREE_COMBO_ITEM_SELECTED_BG : undefined }}
              >
                {exerciseName(opt)}
              </li>
            ))}
          </ul>
        </div>,
        document.body,
      )}
    </div>
  );
}
