# game_shoot

Boxhead-style online multiplayer top-down zombie shooter.
Full design: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Current status — Phase 1 offline slice + Phase 2 online lobby

Playable single-player/local co-op vs. waves, plus a working online lobby:
create a room, share its 6-char code, join from another browser, and start a
match together (see **Online lobby** below). Monorepo foundation + shared
packages in place:

```
shared/   wire codecs (Input/Snapshot/Event, pack/unpack tests), tick constants,
          grid.ts        — GridMap: circle collision + grid line-of-sight
          balance.config.ts — ALL gameplay tuning (weapon stats, cadence, drops, waves)
          weapons.ts     — weapon table (pistol…railgun) + RoF/ammo/tier helpers
          flowfield.ts   — Dijkstra flow field for the horde (no per-zombie A*)
client/   Vite + Three.js angled-isometric game (keyboard-only, 8-way aim):
          src/game/world.ts     — ortho camera + lit 3D arena built onto the GridMap
          src/game/player.ts    — movement, 8-way facing, recoil, hitscan resolution
          src/game/projectiles.ts — arcing/bouncing grenades, rockets, fireballs
          src/game/fx.ts        — pooled tracers + muzzle flashes (no per-shot GC)
          src/game/enemies.ts   — boxhead zombies, flow-field steering, waves
          src/network/lobby.ts  — Colyseus client: create/join by code, presence, reconnect
          src/main.ts           — input, loop, HUD, combat glue + online match wiring
server/   Colyseus server: CoopRoom lobby (6-char room codes, seats, host,
          presence relay, start) over the WebSocket transport, plus /healthz
```

## Requirements

- **Node.js ≥ 22.6** (built-in TypeScript type stripping — tests run with no build step)
- npm (bundled) or pnpm

## Commands

```bash
npm install            # client deps: three, vite; root: typescript (needed for dev/typecheck)

npm test               # 8 shared test files via node:test — no install needed to run them
npm run typecheck      # tsc --noEmit for shared + server + client

npm run dev:server     # Colyseus lobby on ws://localhost:2567 (http /healthz)
npm run dev:client     # Vite dev server on :5173 — then press „დაწყება"
```

### Online lobby checks

```bash
# server-only: create → join-by-code → presence relay → host start
node scripts/lobby-check.mjs           # needs dev:server

# two real browser tabs over CDP: create room, join by code, start, both in play
node scripts/lobby-browser-check.mjs   # needs dev:server + dev:client
                                       #   + Chrome on --remote-debugging-port=9333
```

## Deployment (Render + Vercel)

Two free services, both auto-deploying from the repo. The server is a Colyseus
websocket server: it answers the matchmaking routes for the `coop` room and still
serves `/healthz` for Render's health check.

| Piece | Host | Config | Build → run |
|---|---|---|---|
| Game server | **Render** — Web Service (free) | [`render.yaml`](./render.yaml) | `npm run build --workspace server` → `node dist/index.js` |
| Three.js client | **Vercel** | [`vercel.json`](./vercel.json) | `npm run build --workspace client` → `client/dist` |

### Server → Render

1. Render Dashboard → **New → Blueprint** → pick this repo (`render.yaml` is read automatically).
2. Render injects `PORT`; the server binds `Number(process.env.PORT) || 2567`.
3. Health check path is `/healthz`. CORS is permissive (`Access-Control-Allow-Origin: *`)
   so the browser client on a different origin can reach it.
4. The build bundles the `shared/` package into a self-contained `server/dist/index.js`
   with esbuild — the deploy needs no TypeScript runtime flags.

### Client → Vercel

1. Import the repo and keep the **Root Directory** at the repo root so the npm-workspace
   commands in `vercel.json` run.
2. Add an environment variable (Production **and** Preview):
   `VITE_SERVER_URL=wss://<your-service>.onrender.com` — use `wss://`, not `http://`.
3. Deploy. `VITE_SERVER_URL` is inlined at build time and falls back to
   `ws://localhost:2567` locally (see `client/.env.example` and
   `client/src/network/serverUrl.ts`).

> ⚠️ Render's free tier sleeps after ~15 min idle, so the first request (or WebSocket
> handshake) after a quiet period pays a ~50 s cold start.

## Balancing

Every gameplay number lives in **`shared/src/balance.config.ts`** — damage, cadence,
spread, ranges, close-range shotgun scaling, grenade fuse/lethality, drop rates,
wave pacing, player and enemy stats. Edit that file alone to rebalance the game;
no engine code hardcodes tuning. `weapons.ts` builds its table from it, so the
weapons/combo tests check the config directly.

`npm test` runs:

- `bytes` / `quantize` / `constants` / `codec` — wire protocol round-trips, exact byte
  sizes, rejection cases (Input 17 B, keyframe ≈8.18 B/zombie, delta mask validation)
- `grid` — cell math, circle-vs-wall resolution, DDA line of sight
- `weapons` — table sanity, combo-tier gating, RoF/ammo boundaries
- `flowfield` — distances, steering direction, no corner cutting, unreachable cells
- `combo` — kill/decay math and the weapon-unlock ladder

## Wire protocol (summary)

| Type | Message | Direction | Rate |
|---|---|---|---|
| 1 | `InputMsg` (17 B fixed) | client → server | 30 Hz |
| 2 | `SnapshotMsg` (delta + baseline keyframe) | server → client | 20 Hz |
| 3 | `EventMsg` (shot/hit/death/spawn/wave/explosion/combo) | server → client | on occurrence |

Schemas: `shared/src/protocol/messages.ts`, layouts: `shared/src/protocol/codec.ts`.

## Online lobby (Phase 2)

The client (`src/network/lobby.ts`) builds a Colyseus `Client` from `VITE_SERVER_URL`
and the server (`server/src/rooms/CoopRoom.ts`) hosts one room type, `coop`:

- **Create** → `client.create('coop', { name, mapId })`. The server generates a
  unique **6-char room code** and uses it as the Colyseus `roomId`.
- **Join** → `client.joinById(code, { name })` with the shared code (wrong code
  surfaces a friendly error in the lobby panel).
- **Presence** → each client sends its transform ~20 Hz; the room relays it and
  peers render each other. `patchRate` is 50 ms.
- **Host** → first player in; only the host may `start`, which flips the room to
  `playing` and every client launches the match in sync.
- **Reconnect** → an unexpected drop holds the seat for 30 s and the client
  reconnects with its reconnection token.

> Scope: this is a **lobby + presence** layer. Enemy/combat simulation is still
> per-client; server-authoritative movement and horde sync are Phase 3–5.

## Next

- **Phase 3** — server-authoritative movement + prediction/reconciliation
- **Phase 4–5** — server hitscan/combat and horde snapshot sync
