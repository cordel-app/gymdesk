export const dynamic = 'force-dynamic';

const apiBase = process.env.CORDEL_FITNESS_API_URL ?? '';

export default function PaymentProvidersPage() {
  const provider = process.env.PAYMENT_PROVIDER ?? 'monei';
  const env = process.env.PAYMENT_ENV ?? 'sandbox';
  const webhookUrl = `${apiBase}/webhooks/payment`;

  const moneiConfigured =
    !!process.env.MONEI_API_KEY && !!process.env.MONEI_WEBHOOK_SECRET;

  return (
    <div style={{ maxWidth: 680 }}>
      <h1 style={{ margin: '0 0 24px' }}>Payment Providers</h1>

      <section style={card}>
        <h2 style={sectionTitle}>Active provider</h2>
        <Row label="Provider" value={provider} />
        <Row label="Environment" value={env} highlight={env === 'sandbox' ? 'warning' : 'ok'} />
      </section>

      {provider === 'monei' && (
        <section style={{ ...card, marginTop: 16 }}>
          <h2 style={sectionTitle}>MONEI configuration</h2>
          <Row
            label="API key"
            value={process.env.MONEI_API_KEY ? '••••••••' : '— not set —'}
            highlight={process.env.MONEI_API_KEY ? 'ok' : 'error'}
          />
          <Row
            label="Webhook secret"
            value={process.env.MONEI_WEBHOOK_SECRET ? '••••••••' : '— not set —'}
            highlight={process.env.MONEI_WEBHOOK_SECRET ? 'ok' : 'error'}
          />
          <Row
            label="Overall status"
            value={moneiConfigured ? 'Configured' : 'Incomplete'}
            highlight={moneiConfigured ? 'ok' : 'error'}
          />
        </section>
      )}

      <section style={{ ...card, marginTop: 16 }}>
        <h2 style={sectionTitle}>Webhook endpoint</h2>
        <p style={{ fontSize: 14, color: '#555', margin: '0 0 10px' }}>
          Register this URL in your payment provider dashboard to receive payment notifications:
        </p>
        <code style={{
          display: 'block', background: '#f4f4f4', borderRadius: 6,
          padding: '10px 14px', fontSize: 13, wordBreak: 'break-all',
          border: '1px solid #e0e0e0',
        }}>
          {webhookUrl || '(CORDEL_FITNESS_API_URL not set)'}
        </code>
      </section>
    </div>
  );
}

function Row({
  label, value, highlight,
}: {
  label: string;
  value: string;
  highlight?: 'ok' | 'warning' | 'error';
}) {
  const color =
    highlight === 'ok' ? '#1e7e40'
    : highlight === 'warning' ? '#b26a00'
    : highlight === 'error' ? '#c0392b'
    : '#333';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
      <span style={{ fontSize: 14, color: '#555' }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 600, color }}>{value}</span>
    </div>
  );
}

const card: React.CSSProperties = {
  background: '#fff',
  borderRadius: 10,
  border: '1px solid #e8e8e8',
  padding: '20px 24px',
  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
};

const sectionTitle: React.CSSProperties = {
  margin: '0 0 16px',
  fontSize: 16,
  fontWeight: 600,
  color: '#222',
};
