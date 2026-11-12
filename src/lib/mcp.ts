// A small MCP server (Streamable HTTP, stateless): AI agents read a project's statistics with a read-only key.
import { AgentError, callerFor, countCall, CALLS_PER_MINUTE, TOOLS, type Caller } from './agents';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, accept', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Max-Age': '86400' };
const json = (o: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...extra } });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

const INSTRUCTIONS = 'Probe is cookieless website and virtual-tour statistics by Nassau. This connection reads one project and can’t change anything. Call list_environments first, then ask about a website (get_overview, get_pages, get_page_detail, list_sessions, get_ai_traffic) or a virtual tour (get_tour_stats). Every tool takes "period" (24h, 7d, 30d, 90d) or exact "from"/"to" days, and returns the period before for comparison. All data is anonymous.';

async function answer(c: Caller, m: any): Promise<object | null> {
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return rpcError(m?.id, -32600, 'Invalid request.');
  if (m.id === undefined || m.id === null) return null; // notifications need no answer
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize': {
      const asked = m.params?.protocolVersion;
      return ok({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'probe', title: 'Probe', version: '1.0.0' },
        instructions: `${INSTRUCTIONS} Project: ${c.project.name}.`,
      });
    }
    case 'ping': return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === m.params?.name);
      if (!tool) return rpcError(m.id, -32602, `Unknown tool: ${String(m.params?.name).slice(0, 80)}`);
      const fail = (text: string) => ok({ content: [{ type: 'text', text }], isError: true });
      if (!(await countCall(c.key))) return fail(`Too many questions at once: this key allows ${CALLS_PER_MINUTE} a minute. Wait a moment and try again.`);
      try {
        const out = await tool.run(c, m.params?.arguments ?? {});
        return ok({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError: false });
      } catch (e: any) {
        // Messages written for the agent are passed on; anything unexpected stays inside.
        const known = e instanceof Error && !/SQLITE|D1_|prepare|undefined|null/i.test(e.message);
        if (!known) console.error('mcp tool failed', tool.name, e);
        return fail(known ? e.message : 'Probe couldn’t answer that just now.');
      }
    }
    case 'resources/list': return ok({ resources: [] });
    case 'prompts/list': return ok({ prompts: [] });
    default: return rpcError(m.id, -32601, `Method not found: ${m.method.slice(0, 80)}`);
  }
}

/** key: from the address (api/mcp/<key>) when the app can't send a header; otherwise the Authorization header is used. */
export async function serveMcp(request: Request, pathKey?: string): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return json(rpcError(null, -32000, 'Probe’s MCP endpoint answers POST requests only.'), 405, { Allow: 'POST, OPTIONS' });
  const header = request.headers.get('authorization') || '';
  const key = pathKey || (/^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? null);
  let caller: Caller;
  try { caller = await callerFor(key); } catch (e) {
    const err = e instanceof AgentError ? e : new AgentError(500, 'Probe couldn’t check the key just now.');
    return json(rpcError(null, -32001, err.message), err.status, err.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="Probe"' } : {});
  }
  const text = await request.text();
  if (text.length > 100_000) return json(rpcError(null, -32600, 'Request too large.'), 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return json(rpcError(null, -32700, 'Parse error.'), 400); }
  if (Array.isArray(body)) {
    if (!body.length || body.length > 20) return json(rpcError(null, -32600, 'Invalid request.'), 400);
    const out = [];
    for (const m of body) { const r = await answer(caller, m); if (r) out.push(r); }
    return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
  }
  const r = await answer(caller, body);
  return r ? json(r) : new Response(null, { status: 202, headers: CORS });
}
