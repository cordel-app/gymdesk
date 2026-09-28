// Node runtime (not edge): edge fetch only allows ports 80/443, backend runs on 3000
import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.CORDEL_FITNESS_API_URL!;

async function handler(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const url = `${BACKEND_URL}/${path.join('/')}${req.nextUrl.search}`;

  const headers: Record<string, string> = {
    'ngrok-skip-browser-warning': '1',
  };
  req.headers.forEach((value, key) => {
    if (['authorization', 'x-gym-id', 'x-locale', 'content-type'].includes(key.toLowerCase())) {
      headers[key] = value;
    }
  });

  const body = req.method !== 'GET' && req.method !== 'HEAD'
    ? await req.arrayBuffer()
    : undefined;

  try {
    const res = await fetch(url, {
      method: req.method,
      headers,
      body,
      cache: 'no-store',
    });

    // #830: read the body as **bytes**, never `res.text()`. Most responses here
    // are JSON, but not all of them: `GET /themes/:id/logo` answers the logo's
    // raw bytes and `POST /payments/:id/receipt` a PDF, and decoding either as
    // UTF-8 replaces every byte that is not valid UTF-8 with U+FFFD. The body
    // then still has the right `Content-Type` and the right shape, so nothing
    // errors — the browser simply cannot decode it and renders the Theme's
    // `logo preview` as a broken image. A Base Theme's logo is a blob served by
    // that route (it has no R2 `logo_url`), which is why the complaint was a
    // Base Theme's. `ArrayBuffer` is a valid body and byte-exact for JSON too.
    const resBody = res.status === 204 ? null : await res.arrayBuffer();

    return new NextResponse(resBody, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
    });
  } catch (err) {
    // Path and query are caller-controlled: strip line breaks so they can't forge log entries.
    console.error('Proxy error for %s:', url.replace(/[\r\n]/g, ''), err);
    return NextResponse.json({ error: 'Backend unreachable' }, { status: 502 });
  }
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
