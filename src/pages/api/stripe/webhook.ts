// Stripe → Ziffer: card saved, invoice paid or failed. Verified with the endpoint's signing secret.
import type { APIRoute } from 'astro';
import { handleEvent, verifyWebhook } from '../../../lib/stripe';

export const POST: APIRoute = async ({ request }) => {
  const payload = await request.text();
  if (!(await verifyWebhook(payload, request.headers.get('Stripe-Signature')))) return new Response('Bad signature', { status: 400 });
  let evt: any;
  try { evt = JSON.parse(payload); } catch { return new Response('Bad JSON', { status: 400 }); }
  try { await handleEvent(evt); } catch (e) { console.error('ziffer: stripe event', evt?.type, e); return new Response('Error', { status: 500 }); }
  return new Response('ok');
};
