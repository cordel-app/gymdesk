/**
 * Who the client of a request is, when the request reached us through proxies.
 *
 * The API runs behind Traefik, so `req.ip` is only ever right because
 * `app.set('trust proxy', n)` tells Express how many hops to discount (#599).
 * Since #1083 one route reaches us through **one more** hop: Monei posts its
 * webhook to the isolated payment app (`PAYMENT_NOTIFICATION_URL` →
 * `https://pay.…/webhooks/payment`) and that app's nginx relays it to the API's
 * internal address, so the chain in front of `/webhooks/payment` is one longer
 * than the chain in front of every other route.
 *
 * That matters for exactly one thing: the payment webhook is rate-limited at
 * **60 requests per minute per IP**, and the key is the client address. Count
 * the relay as a client and every webhook of every gym shares one budget — 61
 * payments in a minute and the API starts refusing payment confirmations.
 *
 * Why this is a per-route hop count rather than `TRUST_PROXY_HOPS = 2`:
 * raising the global count would make Express trust one *more* entry of
 * `X-Forwarded-For` on every route, including the ones a client can still
 * reach directly — and the entries further left in that header are supplied by
 * whoever is calling. A caller could then choose the address every per-IP
 * limiter in the app buckets them under. The API is not private yet (#1087 is
 * the open question of whether it becomes so), so the extra hop is declared
 * where it is real and nowhere else, and it defaults to 0 — the pre-#1083
 * shape, where `paymentWebhookClientKey()` answers exactly `req.ip`.
 */

/** What `TRUST_PROXY_HOPS` defaults to: one reverse proxy (Traefik). */
export const TRUST_PROXY_HOPS_DEFAULT = 1;

/**
 * What `PAYMENT_WEBHOOK_RELAY_HOPS` defaults to: none, i.e. Monei posts to the
 * API directly. Set it to 1 wherever `PAYMENT_NOTIFICATION_URL` points at the
 * payment app's relay instead.
 */
export const PAYMENT_WEBHOOK_RELAY_HOPS_DEFAULT = 0;

/**
 * A whole number of hops from the environment, or `fallback`. A negative, a
 * fraction and anything non-numeric fall back; `0` is a legitimate value for
 * both settings (no proxy at all / no relay) and is honoured.
 */
function hopCount(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n;
}

/** How many proxy hops sit in front of every route. Mirrors `app.set('trust proxy')`. */
export function trustProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  return hopCount(env.TRUST_PROXY_HOPS, TRUST_PROXY_HOPS_DEFAULT);
}

/** How many *further* hops sit in front of `POST /webhooks/payment`. */
export function paymentWebhookRelayHops(env: NodeJS.ProcessEnv = process.env): number {
  return hopCount(env.PAYMENT_WEBHOOK_RELAY_HOPS, PAYMENT_WEBHOOK_RELAY_HOPS_DEFAULT);
}

/** Only the fields of a request this module reads — so it is unit-testable. */
export interface ForwardedRequest {
  /** Express's own answer, which already discounts `trust proxy` hops. */
  ip?: string;
  /** The immediate peer: `req.socket.remoteAddress`. */
  socketAddress?: string;
  /** The raw `X-Forwarded-For` header, as Node gives it. */
  forwardedFor?: string | string[];
}

function forwardedList(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  const joined = Array.isArray(raw) ? raw.join(',') : raw;
  return joined
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * The address `hops` proxies away from us, resolved exactly as Express resolves
 * `req.ip` so that the two agree when `hops` is the trusted count.
 *
 * The addresses nearest us come last in `X-Forwarded-For` (each proxy appends
 * the peer it heard from), and the nearest address of all is the socket's own,
 * which no header carries. So the chain from here outwards is
 * `[socket, ...reverse(X-Forwarded-For)]` and the answer is its `hops`th entry.
 * A chain shorter than that — a request that arrived through fewer proxies than
 * configured, or with no header at all — answers its outermost entry rather
 * than `undefined`: a key is still needed, and the socket address is the one
 * thing no caller can forge.
 */
export function forwardedClientAddress(req: ForwardedRequest, hops: number): string | undefined {
  const chain = [req.socketAddress, ...forwardedList(req.forwardedFor).reverse()].filter(
    (address): address is string => typeof address === 'string' && address !== '',
  );
  if (chain.length === 0) return undefined;
  return chain[Math.min(Math.max(hops, 0), chain.length - 1)];
}

/**
 * The rate-limit key for `POST /webhooks/payment`: the client address, counting
 * the configured relay as the extra hop it is.
 *
 * With no relay configured this is `req.ip` verbatim, so the route behaves as
 * it did before #1083 — including when `req.ip` is undefined, where the key is
 * the empty string and every such request shares one bucket, which is what
 * `express-rate-limit`'s own default does.
 */
export function paymentWebhookClientKey(
  req: ForwardedRequest,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const relayHops = paymentWebhookRelayHops(env);
  if (relayHops === 0) return req.ip ?? '';
  return forwardedClientAddress(req, trustProxyHops(env) + relayHops) ?? req.ip ?? '';
}
