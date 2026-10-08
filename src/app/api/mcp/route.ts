import { NextResponse } from 'next/server';

import { requireApiKey } from '@/lib/auth/api-context';
import { callTool, toolList, type ToolContext } from '@/lib/mcp/tools';

// ============================================================
// Remote MCP server (Streamable HTTP, stateless JSON responses) for
// connecting this CRM to Claude as a custom connector.
//
//   URL:  https://<your-domain>/api/mcp?key=<API key>
//
// The API key (Settings → API keys, scope `mcp:read`) may also be sent
// as `Authorization: Bearer …`. Every tool is read-only and scoped to
// the key's account. Only `initialize`, `tools/list`, `tools/call` and
// `ping` are implemented — enough for Claude and other MCP clients.
// ============================================================

export const maxDuration = 60;

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);

const SERVER_INSTRUCTIONS =
  'Wangoes DSA CRM (WhatsApp CRM). Read-only access to the WhatsApp inbox, contacts/leads, ' +
  'sales pipeline deals, follow-ups, phone-call recordings and the team activity report. ' +
  'Dates are YYYY-MM-DD in India time (IST). Indian phone numbers are shown without +91.';

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Accept',
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS });
}

function rpcError(id: RpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0' as const, id: id ?? null, error: { code, message } };
}

/** The key may come in the URL (Claude connectors) or as a bearer token. */
function withKeyHeader(request: Request): Request {
  if (request.headers.get('authorization')) return request;
  const key = new URL(request.url).searchParams.get('key');
  if (!key) return request;
  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${key}`);
  return new Request(request.url, { method: request.method, headers });
}

async function handle(msg: RpcRequest, ctx: ToolContext) {
  const id = msg.id;
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '');
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.has(asked) ? asked : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'wangoes-dsa-crm', version: '1.0.0' },
          instructions: SERVER_INSTRUCTIONS,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: toolList() } };
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const data = await callTool(ctx, name, args);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] },
        };
      } catch (err) {
        // Tool errors go back as results so the model can read and recover.
        const message = err instanceof Error ? err.message : 'Tool failed';
        console.warn(`[mcp] tool ${name} failed:`, message);
        return {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: message }] },
        };
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function POST(request: Request) {
  let ctx: ToolContext;
  try {
    const auth = await requireApiKey(withKeyHeader(request), 'mcp:read');
    ctx = { db: auth.supabase, accountId: auth.accountId };
  } catch (err) {
    const status = (err as { status?: number }).status ?? 401;
    const message =
      status === 403
        ? "This API key needs the 'mcp:read' scope"
        : status === 429
          ? 'Rate limited — try again in a minute'
          : 'Missing or invalid API key';
    return json(rpcError(null, -32001, message), status);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, -32700, 'Parse error'), 400);
  }

  const batch = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const raw of batch) {
    const msg = raw as RpcRequest;
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      responses.push(rpcError(null, -32600, 'Invalid request'));
      continue;
    }
    // Notifications (no id) get no response.
    if (msg.id === undefined || msg.id === null) continue;
    responses.push(await handle(msg, ctx));
  }

  if (responses.length === 0) return new NextResponse(null, { status: 202, headers: CORS });
  return json(Array.isArray(body) ? responses : responses[0]);
}

// No server-initiated stream / sessions in this stateless server.
export async function GET() {
  return new NextResponse('Method Not Allowed', { status: 405, headers: CORS });
}

export async function DELETE() {
  return new NextResponse(null, { status: 405, headers: CORS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
