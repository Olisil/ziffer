// Remembers that the signed-in person has closed the latest "What's new" note.
import type { APIRoute } from 'astro';
import { markNewsSeen } from '../../lib/news';
import { me } from '../../lib/users';

export const POST: APIRoute = async (ctx) => {
  const u = await me(ctx);
  if (!u) return new Response(null, { status: 401 });
  await markNewsSeen(u.id);
  return new Response(null, { status: 204 });
};
