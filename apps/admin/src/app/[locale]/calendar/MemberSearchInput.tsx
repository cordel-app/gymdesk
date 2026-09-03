'use client';

import { useEffect, useRef, useState } from 'react';
import { useApiClient } from '@/lib/apiClient';

export interface MemberResult {
  id: number;
  name: string;
  email: string;
}

interface Props {
  placeholder?: string;
  onSelect: (member: MemberResult) => void;
  disabled?: boolean;
}

export function MemberSearchInput({ placeholder = 'Search member…', onSelect, disabled }: Props) {
  const { apiFetch } = useApiClient();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemberResult[]>([]);
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!query.trim()) { setResults([]); setOpen(false); return; }
    timerRef.current = setTimeout(async () => {
      try {
        const data = await apiFetch<MemberResult[]>(`/members?q=${encodeURIComponent(query)}`);
        setResults(data);
        setOpen(true);
      } catch {
        setResults([]);
      }
    }, 300);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query]);

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, []);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        style={{
          width: '100%', boxSizing: 'border-box',
          padding: '8px 10px', borderRadius: 6,
          border: '1px solid #d1d5db', fontSize: 13,
          background: 'var(--gd-input-bg, #fff)',
          color: 'var(--gd-text, inherit)',
        }}
      />
      {open && results.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 9999,
          background: 'var(--gd-card-bg, #fff)',
          border: '1px solid #d1d5db', borderRadius: 6,
          boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          maxHeight: 240, overflowY: 'auto',
        }}>
          {results.map((m) => (
            <div
              key={m.id}
              onMouseDown={() => { onSelect(m); setQuery(''); setOpen(false); }}
              style={{
                padding: '8px 12px', cursor: 'pointer', fontSize: 13,
                borderBottom: '1px solid #f3f4f6',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f5f3ff')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '')}
            >
              <div style={{ fontWeight: 600 }}>{m.name}</div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>{m.email}</div>
            </div>
          ))}
        </div>
      )}
      {open && results.length === 0 && query.trim() && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 9999,
          background: 'var(--gd-card-bg, #fff)',
          border: '1px solid #d1d5db', borderRadius: 6,
          padding: '10px 12px', fontSize: 13, color: '#6b7280',
        }}>
          No members found
        </div>
      )}
    </div>
  );
}
