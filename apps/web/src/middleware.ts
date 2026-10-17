import { NextResponse, type NextRequest } from 'next/server';

// next.config's /api rewrite is fixed when the app is built (http://127.0.0.1:8000 unless API_URL
// was set then). The launcher (scripts/dev.mjs) may start the API on another port - :8000 taken by
// some other program, or API_PORT - and then passes API_URL at start; this sends /api there instead.
// It runs on Node, so process.env is read at run time, not baked in by the build.
export const config = { matcher: '/api/:path*', runtime: 'nodejs' };

export function middleware(req: NextRequest) {
  const api = process.env.API_URL;
  const { pathname, search } = req.nextUrl;
  // /api/internal is for the worker and exporter only and never goes through the web app.
  if (!api || pathname.startsWith('/api/internal')) return NextResponse.next();
  return NextResponse.rewrite(new URL(pathname + search, api));
}
