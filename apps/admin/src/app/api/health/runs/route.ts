/**
 * #1166 — `GET /api/health/runs`: the endpoint Grafana Cloud's run-freshness
 * alerts (#872) read, relaying to the API's own `/health/runs` at
 * `CORDEL_FITNESS_API_URL`, so Grafana no longer needs a public API (#1087).
 *
 * Node runtime (not edge): edge fetch only allows ports 80/443, the API runs on 3000.
 *
 * What is relayed and where is `lib/healthRunsRelay.ts`' — this file is the I/O
 * half and decides nothing.
 */

import { NextResponse } from 'next/server';
import {
  HEALTH_RUNS_RELAY_TIMEOUT_MS,
  RELAY_TIMEOUT_STATUS,
  RELAY_UNCONFIGURED_STATUS,
  RELAY_UNREACHABLE_STATUS,
  healthRunsTarget,
} from '@/lib/healthRunsRelay';

export const runtime = 'nodejs';

// The target comes from the environment per request, and the answer changes
// with every run: neither may be prerendered or cached.
export const dynamic = 'force-dynamic';

export async function GET() {
  const url = healthRunsTarget(process.env.CORDEL_FITNESS_API_URL);
  if (!url) {
    console.error('Health runs relay: CORDEL_FITNESS_API_URL is not set');
    return NextResponse.json({ error: 'Relay not configured' }, { status: RELAY_UNCONFIGURED_STATUS });
  }

  let res: Response;
  try {
    // No request header is forwarded: the API route reads none.
    res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(HEALTH_RUNS_RELAY_TIMEOUT_MS),
    });
  } catch (err) {
    // Never a 200: the alert rules treat an error as Alerting, and an API the
    // relay could not reach must not read as a fresh run.
    if (err instanceof Error && err.name === 'TimeoutError') {
      console.error('Health runs relay: API did not answer in time', err);
      return NextResponse.json({ error: 'Backend timed out' }, { status: RELAY_TIMEOUT_STATUS });
    }
    console.error('Health runs relay: API unreachable', err);
    return NextResponse.json({ error: 'Backend unreachable' }, { status: RELAY_UNREACHABLE_STATUS });
  }

  // The API's own status and body: a 200 stale or not, a 503 when the run logs
  // cannot be read. Bytes rather than `res.text()`, for #830's reason.
  return new NextResponse(await res.arrayBuffer(), {
    status: res.status,
    headers: {
      'Content-Type': res.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
