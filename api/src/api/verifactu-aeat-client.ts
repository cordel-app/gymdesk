// #2648 stage 4 — the transport to AEAT's VERI*FACTU SOAP service. It sends one
// request over mutual TLS with the gym's own certificate (Tax & Compliance,
// #2647 stage 3) and hands back the status and the raw body; it decides nothing
// about what the answer means (`domain/verifactuXml.ts`) and logs nothing — not
// the request, not the certificate, not the passphrase.
import https from 'node:https';
import { URL } from 'node:url';

export interface AeatHttpResult { status: number; body: string }

/** Thrown for a failure before any HTTP answer: the outcome at AEAT is unknown. */
export class AeatTransportError extends Error {
  constructor(message: string, readonly code: 'certificate_error' | 'network_error' | 'timeout') {
    super(message);
  }
}

export const AEAT_REQUEST_TIMEOUT_MS = 60_000;

export async function postToAeat(
  endpoint: string,
  xml: string,
  cert: { pfx: Buffer; passphrase: string },
  timeoutMs = AEAT_REQUEST_TIMEOUT_MS,
): Promise<AeatHttpResult> {
  let agent: https.Agent;
  try {
    agent = new https.Agent({ pfx: cert.pfx, passphrase: cert.passphrase, keepAlive: false });
  } catch {
    // The message of a PKCS#12 failure says nothing secret, but it is not ours to
    // repeat either: the code is enough for an operator.
    throw new AeatTransportError('The certificate could not be loaded', 'certificate_error');
  }
  const url = new URL(endpoint);
  const body = Buffer.from(xml, 'utf8');
  return new Promise<AeatHttpResult>((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      agent,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': body.length,
        SOAPAction: '""',
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (err) => reject(new AeatTransportError(err.message, 'network_error')));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new AeatTransportError('AEAT did not answer in time', 'timeout')));
    req.on('error', (err) => reject(err instanceof AeatTransportError
      ? err
      : new AeatTransportError(/certificate|pkcs|mac verify|ssl/i.test(err.message)
        ? 'The TLS client certificate was refused' : err.message,
      /certificate|pkcs|mac verify|ssl/i.test(err.message) ? 'certificate_error' : 'network_error')));
    req.end(body);
  });
}
