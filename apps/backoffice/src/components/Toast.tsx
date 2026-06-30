'use client';

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

export type ToastType = 'error' | 'success' | 'info';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

let _nextId = 0;

const STYLES: Record<ToastType, { border: string; icon: string; iconColor: string }> = {
  error:   { border: '#e74c3c', icon: '✕', iconColor: '#e74c3c' },
  success: { border: '#27ae60', icon: '✓', iconColor: '#27ae60' },
  info:    { border: '#3498db', icon: 'i', iconColor: '#3498db' },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, type: ToastType = 'error') => {
    const id = ++_nextId;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4500);
  }, []);

  function dismiss(id: number) {
    setToasts(prev => prev.filter(t => t.id !== id));
  }

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div style={{
        position: 'fixed', bottom: 24, right: 24,
        zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 10,
        pointerEvents: 'none',
      }}>
        {toasts.map(t => {
          const s = STYLES[t.type];
          return (
            <div key={t.id} className="toast-item" style={{
              background: '#fff',
              border: `1px solid ${s.border}`,
              borderLeft: `4px solid ${s.border}`,
              borderRadius: 8,
              padding: '12px 14px',
              minWidth: 280,
              maxWidth: 380,
              boxShadow: '0 4px 20px rgba(0,0,0,0.13)',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              pointerEvents: 'all',
            }}>
              <span style={{
                width: 20, height: 20, borderRadius: '50%',
                background: s.border, color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 700, flexShrink: 0, marginTop: 1,
              }}>
                {s.icon}
              </span>
              <span style={{ fontSize: 14, flex: 1, color: '#222', lineHeight: 1.45 }}>
                {t.message}
              </span>
              <button
                onClick={() => dismiss(t.id)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: '#aaa', fontSize: 18, padding: 0, lineHeight: 1,
                  flexShrink: 0, marginTop: -1,
                }}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <style>{`
        .toast-item {
          animation: toast-in 0.22s cubic-bezier(0.16,1,0.3,1);
        }
        @keyframes toast-in {
          from { opacity: 0; transform: translateX(24px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
