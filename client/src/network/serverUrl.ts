/**
 * Game-server endpoint for the current build.
 *
 * Vite inlines `VITE_SERVER_URL` at build time, so set it in the deploy
 * environment (Vercel → Project → Settings → Environment Variables) to the
 * Render service URL, e.g. `wss://game-shoot-server.onrender.com`. Local dev
 * falls back to the Phase 0 scaffold.
 *
 * The online lobby (`src/network/lobby.ts`) builds its Colyseus `Client` from
 * this URL; room create/join and presence relay live there.
 */
const DEFAULT_SERVER_URL = 'ws://localhost:2567';

/** WebSocket URL of the authoritative game server. */
export const SERVER_URL: string = import.meta.env.VITE_SERVER_URL || DEFAULT_SERVER_URL;

/** HTTP(S) equivalent of {@link SERVER_URL} — for REST calls (matchmaking, health). */
export const SERVER_HTTP_URL: string = SERVER_URL.replace(/^ws/, 'http');
