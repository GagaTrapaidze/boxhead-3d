// Phase 0 scaffold: dependency-free HTTP server so the workspace runs before
// any package is installed. The Colyseus room/tick loop lands in Phase 2.
//
// Deploy notes (Render):
//   · PORT is injected by the platform — never hard-code it.
//   · CORS is intentionally wide open: the client is served from a different
//     origin (Vercel) and Phase 2's matchmaking calls will need it too.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  MAX_PLAYERS,
  MAX_ZOMBIES,
  SNAPSHOT_RATE,
  TICK_MS,
  TICK_RATE,
} from '../../shared/src/constants.ts';

// Render (and most PaaS) set PORT; 2567 is the local / Colyseus convention.
const port = Number(process.env.PORT) || 2567;

// Permissive CORS on every reply, plus the preflight headers browsers probe for.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'Content-Type,Authorization',
  'access-control-max-age': '86400',
} as const;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', ...CORS_HEADERS });
  response.end(JSON.stringify(body));
}

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  // CORS preflight — answer before routing so cross-origin POSTs can be probed.
  if (request.method === 'OPTIONS') {
    response.writeHead(204, CORS_HEADERS);
    response.end();
    return;
  }

  const path = (request.url ?? '/').split('?')[0];

  if (path === '/healthz') {
    sendJson(response, 200, {
      ok: true,
      tickRate: TICK_RATE,
      tickMs: TICK_MS,
      snapshotRate: SNAPSHOT_RATE,
      maxPlayers: MAX_PLAYERS,
      maxZombies: MAX_ZOMBIES,
      uptime: Math.round(process.uptime()),
    });
    return;
  }

  if (path === '/') {
    sendJson(response, 200, {
      service: 'game-shoot-server',
      status: 'ok',
      phase: 'scaffold',
      health: '/healthz',
    });
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain', ...CORS_HEADERS });
  response.end('not found — try /healthz\n');
});

server.listen(port, () => {
  console.log(`[server] Phase 0 scaffold listening on http://localhost:${port}`);
  console.log(`[server] sim ${TICK_RATE} Hz (${TICK_MS.toFixed(2)} ms/tick), snapshots ${SNAPSHOT_RATE} Hz`);
});
