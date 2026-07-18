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
    if (['authorization', 'x-gym-id', 'content-type'].includes(key.toLowerCase())) {
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
    });

    const resBody = res.status === 204 ? null : await res.text();

    return new NextResponse(resBody, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
    });
  } catch (err) {
    console.error(`Proxy error for ${url}:`, err);
    return NextResponse.json({ error: 'Backend unreachable' }, { status: 502 });
  }
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
