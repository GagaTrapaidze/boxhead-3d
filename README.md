# game_shoot

Boxhead-style online multiplayer top-down zombie shooter.
Full design: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Current status — offline slice + online lobby + authoritative shared world

Playable single-player/local co-op vs. waves, plus a working online mode where
the Colyseus room owns the whole **shared world**: mobs, barrels/crates, loot,
wave director, the Devil's fireballs/hazards, its phase-2 homing fire-trail charge
and explosive chains. Clients render
that world from the room state and report the shots they resolve (see
**Authoritative world** below). Monorepo foundation + shared packages in place:

```
shared/   wire codecs (Input/Snapshot/Event, pack/unpack tests), tick constants,
          grid.ts        — GridMap: circle collision + grid line-of-sight
          balance.config.ts — ALL gameplay tuning (weapon stats, cadence, drops, waves)
          weapons.ts     — weapon table (pistol…railgun) + RoF/ammo/tier helpers
          flowfield.ts   — Dijkstra flow field for the horde (no per-zombie A*)
          loot.ts        — wire-stable enemy/prop/drop kinds + the loot rolls both sides share
client/   Vite + Three.js angled-isometric game (keyboard-only, 8-way aim):
          src/game/world.ts     — ortho camera + lit 3D arena built onto the GridMap
          src/game/player.ts    — movement, 8-way facing, recoil, hitscan resolution
          src/game/projectiles.ts — arcing/bouncing grenades, rockets, fireballs
          src/game/fx.ts        — pooled tracers + muzzle flashes (no per-shot GC)
          src/game/enemies.ts   — boxhead zombies, flow-field steering, waves (offline)
          src/network/lobby.ts  — Colyseus client: create/join, presence, world state, events
          src/network/onlineWorld.ts — mirror: renders state.enemies/props/drops/hazards
          src/main.ts           — input, loop, HUD, combat glue + online match wiring
server/   Colyseus server: CoopRoom (6-char room codes, seats, host, presence,
          world authority) + rooms/world.ts (the mesh-free horde/props/drops sim),
          over the WebSocket transport, plus /healthz
```

## Requirements

- **Node.js ≥ 22.6** (built-in TypeScript type stripping — tests run with no build step)
- npm (bundled) or pnpm

## Commands

```bash
npm install            # client deps: three, vite; root: typescript (needed for dev/typecheck)

npm test               # 13 shared test files via node:test — no install needed to run them
npm run typecheck      # tsc --noEmit for shared + server + client

npm run dev:server     # Colyseus lobby on ws://localhost:2567 (http /healthz)
npm run dev:client     # Vite dev server on :5173 — then press „დაწყება"
```

### Online checks

```bash
# server-only: create → join → downed → 10 s respawn → Game Over → restart
node scripts/lobby-check.mjs           # needs dev:server

# server-only, world authority: server-authored mobs, prop placement/destruction,
# kill broadcast + loot roll, server-validated walk-over pickup
LOBBY_URL=ws://localhost:2567 node scripts/online-world-check.mjs   # needs dev:server

# server-only, remote-shot FX: a `playerShoot` reaches every OTHER client with
# the origin/direction/weapon intact, never echoes to the shooter, and spawns no
# server entity (fast bullets stay pure client-side tracers)
LOBBY_URL=ws://localhost:2567 node scripts/player-shoot-check.mjs   # needs dev:server

# two real browser tabs over CDP: create room, join by code, start, downed
# countdown, respawn, and Game Over reaching both clients
node scripts/lobby-browser-check.mjs   # needs dev:server + dev:client
                                       #   + Chrome on --remote-debugging-port=9333

# two real browser tabs: both render the identical server world (same mob ids,
# replicated props, a kill vanishing from both, loot mirrored)
node scripts/online-world-browser-check.mjs   # same requirements as above

# local 2-player downed → passive revive → Game Over (guards the local rules)
node scripts/local-revive-check.mjs    # needs dev:client + Chrome on :9333

# darkness cadence: the arena stays lit below GAME_CONFIG.DARKNESS_START_WAVE
# (6), eases dark on that wave, is bright again on the next one, and goes dark
# once more a WAVE_EVENT_CONFIG.period later — driven over CDP against the real
# render loop
node scripts/darkness-check.mjs        # needs dev:client + Chrome on :9333

# Red Devil phase-2 charge: a perpendicularly-committed dash steers its heading
# toward the live player instead of holding the frozen vector (offline client)
node scripts/devil-dash-check.mjs      # needs dev:client + Chrome on :9333

# Wave-7 Black Devil boss: black mesh + dedicated top-centre "BLACK DEVIL" HP
# bar, the 3 u/4.5 s shockwave, the 1 s → 3.5 s tracking laser, the 4-cube
# spinner projectile and the 3–4 reward loot explosion
node scripts/black-devil-browser-check.mjs   # same requirements as above

# Secret character "LIZI": no standard picker (defaults auto-assigned), the
# discreet "Secret" button + "moon" code modal (trimmed, case-insensitive), the
# SESSION-ONLY override (nothing persisted, so a reload resets to the default),
# her LIZI_STATS in-match (150 HP, ×1.3 outgoing weapon damage), the LIZI-only
# 'G'/'F8' GOD MODE (invulnerable, all weapons, infinite ammo) and the god-mode
# speed slider (1.0–3.5x, its events isolated from gameplay input)
node scripts/lizi-check.mjs                  # same requirements as above
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

Cross-mode values that must agree between **Solo, local co-op and online** live
in **`shared/src/gameConfig.ts`** (`GAME_CONFIG`): `DARKNESS_START_WAVE` (the
first wave darkness falls — darkness IS the periodic one-wave `blackout` event,
so it hits this wave and then every `WAVE_EVENT_CONFIG.period` waves, 6/14/22 …
by default; `BLACKOUT_EVENT_WAVE` and `WAVE_EVENT_CONFIG.blackoutOffset` both
derive from it, so the event and the lighting can never drift apart),
`BLACK_DEVIL_START_WAVE` (the earliest wave the boss may spawn — a floor; the
wave that actually hosts the encounter is `DIRECTOR_CONFIG.blackDevilWave` in
balance.config.ts) and `SHOCKWAVE_EXPANSION_SPEED`. `balance.config.ts`
re-exports them, so changing one number there applies to every mode at once —
the client lighting rig, the offline director and the server world all read the
same value.

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
- **Downed & respawn** → at 0 HP the client reports its death; the room marks
  the player **downed** and runs a **10 s** clock (`alive` / `respawnTimer` in
  the schema). When it expires and a teammate is still alive, the player
  respawns at full HP at their seat's safe spawn. If every player is down at
  once, the room sets `matchOver` → **Game Over** for everyone.
- **Restart** → the host's restart resets every player to full HP and clears
  Game Over.
- **Reconnect** → an unexpected drop holds the seat for 30 s and the client
  reconnects with its reconnection token.

## Authoritative world (Phase 3–5)

In an online match the room owns the shared world and each client is a renderer:

| Entity | Server (source of truth) | Client (mirror) |
|---|---|---|
| Mobs | `state.enemies` — server id, kind, `x`/`z`, `dir`, `hp`/`maxHp`, `phase2`, `target` | `onlineWorld.ts` spawns/removes/lerps a mesh per id |
| Props | `state.props` — kind, cell, `hp`/`maxHp` | renders each cell as a barrel/crate |
| Drops | `state.drops` — kind, position, despawn `ttl` | renders each drop cube + blink |
| Hazards / fireballs | `state.hazards`, `state.fireballs` | rendered patches / flames |
| Director | `wave`, `event`, `directorPhase`, `directorTimer` | HUD banners + timers |

**Request → confirm.** The client resolves its own shots and reports them; the
room applies the damage, kills/destroys, rolls loot and broadcasts the result:

| Client → server | Server → all clients |
|---|---|
| `damageEnemy {id, damage, weaponId}` | `enemyKilled {id, kind, x, z, killer}` |
| `damageProp {cx, cz, damage}` | `propDestroyed {kind, cx, cz}` |
| `placeProp {kind, cx, cz}` | `explosion {x, z, radius}` |
| `explode {x, z, radius, damage, playerDamage}` | `damagePlayer {amount}` (to one client) |
| `pickupItem {id, x, z}` | `granted {kind}` (to one client) |
| `presence {x, z, aimX, aimZ, hp, weapon}` | `waveStart` / `waveClear` |

- **Player HP stays client-authoritative**: the room forwards melee, hazard,
  fireball and blast damage (`damagePlayer`) to the owner's normal `applyDamage`,
  so the existing downed/respawn/Game-Over rules keep working unchanged.
- **Explosive chains** are server-side: a barrel that detonates queues its
  neighbours on a staggered fuse (`chainFuseDelay`), and every client plays the
  same blasts in the same order.
- **Loot is per-player**: a walk-over grant is delivered ONLY to the player who
  stepped on the cube (`granted {kind, by}`), and the cube is removed from
  `state.drops` on the same tick — so a grenade / weapon drop never lands in a
  teammate's inventory. Only the shared `teamScore` still credits the whole team.
- **Offline modes are untouched** — every online branch is behind `isOnline`, and
  local single-player/co-op still simulate the horde in the browser.
- Simulation runs at the shared `TICK_RATE` (30 Hz) with `SNAPSHOT_RATE`-paced
  (20 Hz) state patches; mob meshes interpolate between patches.

> Scope note: player projectiles (grenades/rockets/mines) still fly on the
> owner's client, which reports the resulting blast to the room instead of
> applying it locally.

## Next

- **Phase 6** — server-authoritative movement with client prediction/reconciliation
- Move player projectiles into the room so peers see each other's grenades in flight
