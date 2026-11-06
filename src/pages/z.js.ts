import type { APIRoute } from 'astro';
import tracker from '../tracker/z.js?raw';

// The install snippet loads this: <script defer src="https://…/app/z.js" data-site="zs_…"></script>
export const GET: APIRoute = () =>
  new Response(tracker, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    },
  });
