// MCP endpoint for AI agents. The key travels in the Authorization header: "Bearer pk_…".
import type { APIRoute } from 'astro';
import { serveMcp } from '../../../lib/mcp';
export const ALL: APIRoute = ({ request }) => serveMcp(request);
