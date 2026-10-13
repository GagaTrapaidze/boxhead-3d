# game_shoot

Boxhead-style online multiplayer top-down zombie shooter.
Full design: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Current status — Phase 1 (offline vertical slice)

Playable single-player vs. waves; monorepo foundation + shared packages in place:

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
          src/main.ts           — input, loop, HUD, combat glue
server/   dependency-free HTTP scaffold (Colyseus rooms arrive in Phase 2)
```

## Requirements

- **Node.js ≥ 22.6** (built-in TypeScript type stripping — tests run with no build step)
- npm (bundled) or pnpm

## Commands

```bash
npm install            # client deps: three, vite; root: typescript (needed for dev/typecheck)

npm test               # 8 shared test files via node:test — no install needed to run them
npm run typecheck      # tsc --noEmit for shared + server + client

npm run dev:server     # http://localhost:2567/healthz
npm run dev:client     # Vite dev server on :5173 — then press „დაწყება"
```

## Deployment (Render + Vercel)

Two free services, both auto-deploying from the repo. The server is still the Phase 0
scaffold, so today it only serves `/healthz`; the pipeline is in place for Phase 2's
Colyseus rooms.

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

## Next

- **Phase 2** — Colyseus lobby with room codes (ARCHITECTURE.md §2.6)
- **Phase 3** — server-authoritative movement + prediction/reconciliation
