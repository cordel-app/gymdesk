/**
 * #3471: starts a system job from the application by calling its own internal route.
 *
 * The route is the one the scheduler calls, reached in-process: a throwaway HTTP
 * server bound to the loopback interface over the running Express app, one POST
 * carrying `X-Internal-Secret` from this process's environment. The secret never
 * leaves the API, the route's own guards decide (a run already completed today, an
 * overlap), and the run records itself in the same history a scheduled run does —
 * so there is no second notion of "last run" for a manual one.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { SystemJob } from '../domain/systemJobs';

export interface JobRouteAnswer {
  status: number;
  body: unknown;
}

/** Jobs a manual start is waiting on, in this process: a second click is refused. */
const inFlight = new Set<string>();

export function isManualRunInFlight(job: string): boolean {
  return inFlight.has(job);
}

const MANUAL_RUN_TIMEOUT_MS = 660_000;

export async function callJobRoute(app: Express, job: SystemJob, secret: string): Promise<JobRouteAnswer> {
  inFlight.add(job.job);
  const server = http.createServer(app);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    return await new Promise<JobRouteAnswer>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: job.path,
        headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
        timeout: MANUAL_RUN_TIMEOUT_MS,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = null;
          try { body = text ? JSON.parse(text) : null; } catch { body = null; }
          resolve({ status: res.statusCode ?? 0, body });
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('job route timed out')));
      req.on('error', reject);
      req.end('{}');
    });
  } finally {
    inFlight.delete(job.job);
    server.close();
  }
}
