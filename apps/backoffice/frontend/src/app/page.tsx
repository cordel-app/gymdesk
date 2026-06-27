async function getHealth(): Promise<{ status: string } | null> {
  try {
    const res = await fetch(`${process.env.BACKEND_URL}/health`, { cache: 'no-store' });
    return res.json();
  } catch {
    return null;
  }
}

async function getMembers(): Promise<Array<{ id: number; name: string; email: string; phone: string | null }>> {
  try {
    const res = await fetch(`${process.env.BACKEND_URL}/members`, { cache: 'no-store' });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export default async function DashboardPage() {
  const [health, members] = await Promise.all([getHealth(), getMembers()]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 32 }}>
        <h1 style={{ margin: 0 }}>Dashboard</h1>
        <span
          style={{
            padding: '4px 10px',
            borderRadius: 12,
            fontSize: 13,
            background: health?.status === 'ok' ? '#d4edda' : '#f8d7da',
            color: health?.status === 'ok' ? '#155724' : '#721c24',
          }}
        >
          API {health?.status === 'ok' ? 'online' : 'offline'}
        </span>
      </div>

      <section>
        <h2 style={{ marginBottom: 16 }}>Members</h2>
        {members.length === 0 ? (
          <p style={{ color: '#666' }}>No members yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: 8, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
            <thead>
              <tr style={{ background: '#f0f0f0', textAlign: 'left' }}>
                <th style={{ padding: '12px 16px' }}>Name</th>
                <th style={{ padding: '12px 16px' }}>Email</th>
                <th style={{ padding: '12px 16px' }}>Phone</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} style={{ borderTop: '1px solid #eee' }}>
                  <td style={{ padding: '12px 16px' }}>{m.name}</td>
                  <td style={{ padding: '12px 16px' }}>{m.email}</td>
                  <td style={{ padding: '12px 16px' }}>{m.phone ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
