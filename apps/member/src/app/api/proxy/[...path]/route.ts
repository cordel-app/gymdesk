// Node runtime (not edge): edge fetch only allows ports 80/443, backend runs on 3000
import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.CORDEL_FITNESS_API_URL!;

async function handler(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const url = `${BACKEND_URL}/${path.join('/')}${req.nextUrl.search}`;

  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    if (['authorization', 'x-gym-id', 'x-center-id', 'x-impersonate-as', 'x-locale', 'content-type'].includes(key.toLowerCase())) {
      headers[key] = value;
    }
  });

  // Bytes for the same reason, in the other direction: a request body is
  // forwarded verbatim rather than decoded and re-encoded.
  const body = req.method !== 'GET' && req.method !== 'HEAD' ? await req.arrayBuffer() : undefined;

  try {
    const res = await fetch(url, { method: req.method, headers, body });
    // #830: bytes, never `res.text()` — the same defect the Admin proxy carried.
    // `GET /themes/:id/logo` answers raw image bytes, which is how the TopBar
    // renders the logo of a theme that still keeps it as a blob (a Base Theme),
    // and a UTF-8 decode turns every such byte into U+FFFD: the response still
    // looks like an image and the browser still cannot decode it.
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
