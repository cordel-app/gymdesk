/**
 * #1086 — the **transport** half of the internal-run relay: one POST to the
 * API, over `node:http`/`node:https`.
 *
 * It decides nothing (that is `lib/internalRunRelay.ts`) and shapes no
 * response (that is the route). It exists as a module of its own for one
 * reason: `fetch` cannot be used here.
 *
 * Node's global `fetch` is undici, whose agent abandons a request when the
 * response **headers** take longer than 300 s. `POST /recurring-bookings/run`
 * is allowed 600 s by its own workflow and answers nothing at all until the
 * whole window has been re-projected, so a long night would be cut off at five
 * minutes — and a run the API completed but the workflow saw as failed is the
 * worst outcome available, because the guard then refuses the retry as
 * `already_completed_today` (#780). Those timeouts are not configurable per
 * call, so the request is made with the core HTTP client, where the one
 * timeout that applies is the one passed in.
 */

import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** Thrown when the API did not answer within the relay's timeout. */
export class UpstreamTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Upstream did not answer within ${timeoutMs}ms`);
    this.name = 'UpstreamTimeoutError';
  }
}

export interface UpstreamResponse {
  /** The API's own status code, relayed verbatim. */
  status: number;
  /** The API's body as bytes — never decoded, for #830's reason. */
  body: Buffer;
  /** The API's `Content-Type`, or `undefined` when it sent none. */
  contentType?: string;
}

/**
 * POST `body` to `target` with `headers`, resolving with the API's status and
 * raw body. The timeout covers inactivity on the socket, so a run that is
 * simply slow is bounded by one number rather than by two different defaults
 * in two different layers.
 */
export function postToApi(
  target: string,
  headers: Record<string, string>,
  body: Buffer,
  timeoutMs: number,
): Promise<UpstreamResponse> {
  const url = new URL(target);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise<UpstreamResponse>((resolve, reject) => {
    let req: ClientRequest;
    const onResponse = (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          // A response with no status line is not something to invent one for.
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks),
          contentType: res.headers['content-type'],
        }),
      );
      res.on('error', reject);
    };

    try {
      req = send(
        url,
        {
          method: 'POST',
          headers: {
            ...headers,
            // Explicit, because the body is already in memory: without it the
            // request would be chunked, which is fine for the API but needless.
            'content-length': String(body.byteLength),
          },
        },
        onResponse,
      );
    } catch (err) {
      reject(err);
      return;
    }

    req.setTimeout(timeoutMs, () => req.destroy(new UpstreamTimeoutError(timeoutMs)));
    req.on('error', reject);
    req.end(body);
  });
}
