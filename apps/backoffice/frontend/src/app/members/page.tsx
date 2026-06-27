'use client';

import { useEffect, useState } from 'react';

const BACKEND = process.env.BACKEND_URL as string;

interface Member {
  id: number;
  name: string;
  email: string;
  phone: string | null;
}

const emptyForm = { name: '', email: '', phone: '' };

export default function MembersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const res = await fetch(`${BACKEND}/members`);
    setMembers(res.ok ? await res.json() : []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function openAdd() {
    setEditing(null);
    setForm(emptyForm);
    setError(null);
    setModalOpen(true);
  }

  function openEdit(m: Member) {
    setEditing(m);
    setForm({ name: m.name, email: m.email, phone: m.phone ?? '' });
    setError(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
    setForm(emptyForm);
    setError(null);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.email.trim()) {
      setError('Name and email are required.');
      return;
    }
    setSaving(true);
    setError(null);
    const body = { name: form.name.trim(), email: form.email.trim(), phone: form.phone.trim() || null };
    const res = editing
      ? await fetch(`${BACKEND}/members/${editing.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      : await fetch(`${BACKEND}/members`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? 'Something went wrong.');
      setSaving(false);
      return;
    }
    setSaving(false);
    closeModal();
    load();
  }

  async function handleDelete(id: number) {
    if (!confirm('Remove this member?')) return;
    await fetch(`${BACKEND}/members/${id}`, { method: 'DELETE' });
    load();
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Members</h1>
        <button onClick={openAdd} style={btnStyle('#6c63ff')}>+ Add Member</button>
      </div>

      {loading ? (
        <p style={{ color: '#666' }}>Loading…</p>
      ) : members.length === 0 ? (
        <p style={{ color: '#666' }}>No members yet.</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ background: '#f0f0f0', textAlign: 'left' }}>
              <th style={th}>Name</th>
              <th style={th}>Email</th>
              <th style={th}>Phone</th>
              <th style={{ ...th, width: 120 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={td}>{m.name}</td>
                <td style={td}>{m.email}</td>
                <td style={td}>{m.phone ?? '—'}</td>
                <td style={{ ...td, display: 'flex', gap: 8 }}>
                  <button onClick={() => openEdit(m)} style={btnSmall('#444')}>Edit</button>
                  <button onClick={() => handleDelete(m.id)} style={btnSmall('#c0392b')}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {modalOpen && (
        <div style={overlayStyle} onClick={closeModal}>
          <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 20px' }}>{editing ? 'Edit Member' : 'Add Member'}</h2>

            <label style={labelStyle}>Name *</label>
            <input
              style={inputStyle}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Full name"
              autoFocus
            />

            <label style={labelStyle}>Email *</label>
            <input
              style={inputStyle}
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="email@example.com"
            />

            <label style={labelStyle}>Phone</label>
            <input
              style={inputStyle}
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="+1 555 000 0000"
            />

            {error && <p style={{ color: '#c0392b', margin: '8px 0 0', fontSize: 14 }}>{error}</p>}

            <div style={{ display: 'flex', gap: 10, marginTop: 24, justifyContent: 'flex-end' }}>
              <button onClick={closeModal} style={btnStyle('#aaa')} disabled={saving}>Cancel</button>
              <button onClick={handleSave} style={btnStyle('#6c63ff')} disabled={saving}>
                {saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Member'}
              </button>
            </div>
          </div>
        </div>
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

function btnStyle(bg: string): React.CSSProperties {
  return { background: bg, color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontSize: 14, fontWeight: 500 };
}
function btnSmall(bg: string): React.CSSProperties {
  return { background: bg, color: '#fff', border: 'none', borderRadius: 4, padding: '5px 10px', cursor: 'pointer', fontSize: 12 };
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
};
const modalStyle: React.CSSProperties = {
  background: '#fff', borderRadius: 12, padding: 32, width: 420, maxWidth: '90vw', boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
};
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4, marginTop: 14, color: '#333' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '9px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box' };
