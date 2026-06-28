export default function NoGymPage() {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f5f5f5',
      gap: 12,
    }}>
      <div style={{ fontSize: 48 }}>🏋️</div>
      <h2 style={{ margin: 0, color: '#1a1a2e' }}>No gym access yet</h2>
      <p style={{ margin: 0, color: '#666', textAlign: 'center', maxWidth: 400 }}>
        You have not been added to any gym. Contact your gym administrator to get access.
      </p>
    </div>
  );
}
