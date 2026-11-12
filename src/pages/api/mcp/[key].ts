// The same MCP endpoint for apps that only take an address: the key is the last part of it.
import type { APIRoute } from 'astro';
import { serveMcp } from '../../../lib/mcp';
export const ALL: APIRoute = ({ request, params }) => serveMcp(request, String(params.key || ''));
