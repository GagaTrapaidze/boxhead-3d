/**
 * Authoritative game server (Phase 2 — Colyseus lobby).
 *
 * Boots a Colyseus `Server` over the WebSocket transport and the `CoopRoom`
 * matchmaking room, then keeps the Phase 0 `/healthz` probe alive so Render's
 * health check (and the client) can verify the process.
 *
 * Deploy notes (Render):
 *   · PORT is injected by the platform — never hard-code it.
 *   · CORS stays wide open: the client is served from a different origin
 *     (Vercel) and the Colyseus matchmaking HTTP calls need it.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';

import {
  COOP_ROOM_NAME,
  MAX_PLAYERS,
  MAX_ZOMBIES,
  SNAPSHOT_RATE,
  TICK_MS,
  TICK_RATE,
} from '../../shared/src/constants.ts';
import { CoopRoom } from './rooms/CoopRoom.ts';

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

// Plain-HTTP surface: the health probe and a small info document. Colyseus
// wraps this server and claims the matchmaking routes; everything else falls
// through to the handler below.
const httpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, CORS_HEADERS);
    response.end();
    return;
  }

  const path = (request.url ?? '/').split('?')[0];

  if (path === '/healthz') {
    sendJson(response, 200, {
      ok: true,
      phase: 'colyseus-lobby',
      room: COOP_ROOM_NAME,
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
      phase: 'colyseus-lobby',
      room: COOP_ROOM_NAME,
      health: '/healthz',
    });
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain', ...CORS_HEADERS });
  response.end('not found — try /healthz\n');
});

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// One room type for now: the co-op survival lobby/game room.
gameServer.define(COOP_ROOM_NAME, CoopRoom);

gameServer
  .listen(port)
  .then(() => {
    console.log(`[server] Colyseus lobby listening on http://localhost:${port}`);
    console.log(`[server] room "${COOP_ROOM_NAME}" · sim ${TICK_RATE} Hz · snapshots ${SNAPSHOT_RATE} Hz`);
    console.log(`[server] health: http://localhost:${port}/healthz`);
  })
  .catch((error: unknown) => {
    console.error('[server] failed to start:', error);
    process.exit(1);
  });
