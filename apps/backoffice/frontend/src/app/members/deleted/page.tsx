'use client';

import { useEffect, useState } from 'react';

const BACKEND = process.env.BACKEND_URL as string;

interface Member {
  id: number;
  name: string;
  email: string;
  phone: string | null;
}

export default function DeletedMembersPage() {
  const [deleted, setDeleted] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const res = await fetch(`${BACKEND}/members/deleted`);
    setDeleted(res.ok ? await res.json() : []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleRestore(id: number) {
    await fetch(`${BACKEND}/members/${id}/restore`, { method: 'POST' });
    load();
  }

  return (
    <div>
      <h1 style={{ margin: '0 0 24px' }}>Deleted Members</h1>

      {loading ? (
        <p style={{ color: '#666' }}>Loading…</p>
      ) : deleted.length === 0 ? (
        <p style={{ color: '#666' }}>No deleted members.</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ background: '#f0f0f0', textAlign: 'left' }}>
              <th style={th}>Name</th>
              <th style={th}>Email</th>
              <th style={th}>Phone</th>
              <th style={{ ...th, width: 100 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {deleted.map((m) => (
              <tr key={m.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ ...td, color: '#999', textDecoration: 'line-through' }}>{m.name}</td>
                <td style={{ ...td, color: '#999', textDecoration: 'line-through' }}>{m.email}</td>
                <td style={{ ...td, color: '#999' }}>{m.phone ?? '—'}</td>
                <td style={td}>
                  <button onClick={() => handleRestore(m.id)} style={btnRestore}>Restore</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  background: '#fff',
  borderRadius: 8,
  overflow: 'hidden',
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
};
const th: React.CSSProperties = { padding: '12px 16px', fontWeight: 600, fontSize: 13 };
const td: React.CSSProperties = { padding: '12px 16px', fontSize: 14 };
const btnRestore: React.CSSProperties = {
  background: '#27ae60', color: '#fff', border: 'none', borderRadius: 4,
  padding: '5px 10px', cursor: 'pointer', fontSize: 12,
};
