# Boxhead-Style Online Multiplayer Zombie Shooter — Architectural Blueprint

Target: cross-network, cross-device, real-time multiplayer top-down zombie shooter
(inspired by *Boxhead: 2Play*), browser-first, MVP in weeks not months.

---

## 0. Decision Summary (TL;DR)

| Decision | Choice | Why |
|---|---|---|
| Client | **TypeScript + Three.js** (orthographic top-down, blocky low-poly) | Already used in `game_shoot`, fastest path from the current prototype, ships as a URL → any PC/phone browser plays |
| Server | **Node.js + Colyseus** (TypeScript) | Built-in rooms/lobby/room-codes/reconnect + schema delta sync; one language across client/server/shared |
| Topology | **Authoritative dedicated server** (no P2P, no client-host) | Anti-cheat by construction, no host migration problem, deterministic horde ownership |
| Transport | **WebSocket for MVP → Geckos.io (WebRTC data channels) later** | WS ships now; WebRTC gives UDP-like unreliable snapshots when jitter matters |
| Tick rates | Sim **30 Hz**, snapshots **20 Hz**, render **60 fps** | Sweet spot for browser + ~200 entities |
| Horde sync | **Server-side flow-field AI + quantized delta snapshots + interpolation** | 100–200 zombies ≈ **5–10 KB/s per client** |
| Shared logic | `shared/` package: movement, collision, weapon stats, fixed-step math | Client prediction byte-identical to server authority → almost no desync |

---

# PILLAR 1 — Boxhead Gameplay & Core Mechanics

## 1.1 Visuals & Camera
- **Renderer:** Three.js scene, `OrthographicCamera` locked top-down (yaw fixed or slowly
  following mouse), blocky units = textured boxes/low-poly meshes (the "boxhead" look).
- **Camera framing modes (configurable per mode):**
  - *Solo/squad-off*: center on local player with lookahead toward aim direction.
  - *Co-op*: center on **squad centroid**, zoom out clamped by max inter-player distance
    (never show more than the visibility/AOI radius — this doubles as a bandwidth cull).
- Camera is **purely client-side**; it is never authoritative and never sent.

## 1.2 Movement & Combat
- **Input model:** WASD 8-direction normalized movement + mouse 360° aim (raycast/plane
  intersection on ground plane). Alt-fire / twin-stick fallback for gamepads.
- **Movement:** fixed-step (`dt = 1/30`) deterministic function in `shared/`:
  `stepPlayer(state, input, grid) -> state` — same code runs on client (prediction)
  and server (authority).
- **Collision:** uniform **grid / AABB** world:
  - static layer: tile grid (walls, map geometry) — cheap lookup, precomputed blocked cells;
  - dynamic layer: AABBs for players, barricades, barrels, projectiles;
  - spatial hash for dynamic broadphase (reused by zombie separation too).
- **Shooting:** hitscan for pistol/uzi/railgun, projectile entities for shotgun pellets,
  grenades, rockets, fireballs. **Server decides all damage** (see Pillar 2 §2.4).

## 1.3 Weapons & Upgrades
Weapon table lives in `shared/weapons.ts` (single source of truth for client HUD, server
validation — damage, RoF, spread, mag size, unlock tier):

| Weapon | Type | Ammo | Combo tier to unlock |
|---|---|---|---|
| Pistol | hitscan | infinite | 0 (start) |
| Shotgun | 8-pellet hitscan spread | limited | tier 1 |
| Uzi/SMG | hitscan, high RoF | limited | tier 2 |
| Grenades | arcing projectile, AoE | limited | tier 3 |
| Barrels (deployable) | static explosive entity | limited | tier 3 |
| Mine / C4 | proximity/trigger trap | limited | tier 4 |
| Rocket Launcher | projectile, AoE, self-damage | limited | tier 4 |
| Railgun | pierce hitscan, wall-tracer | limited | tier 5 |

- **Combo system:** killing without taking damage and without a 2.5s gap fills a combo
  meter; each tier bumps max ammo and unlocks weapons. Taking damage resets to tier 0.
  Meter is **server-computed** (client only animates it), because unlock gating must be
  cheat-proof.
- Weapon switch/fire events are broadcast as **events**, not per-tick state (cheap).

## 1.4 Barricades & Tactical Defense
- Deployables (barrel, wall, mine) are **server-owned entities** with `id`, `owner`,
  `hp`, `ttl`. Placement validated server-side (grid cell free, in range, ammo available).
- Barricades **mutate the flow field cost grid** → zombie paths reroute automatically
  (this is why pathfinding must live server-side, see §3.4).

## 1.5 Enemy Waves & AI
- **Roster:** White Zombie (slow, tanky-swarm), Red Runner (fast, low hp), Fast Mutant
  (dodges/strafes), **Hellhound boss** (ranged fireball projectile, phase-based).
- **Wave director** is a server state machine: intermission → spawn budget → escalation
  (count, mix, hp scale) → boss every N waves. Seedable for deterministic replays.
- **Pathfinding at scale — Flow Field (Dijkstra/BFS over the grid), not per-zombie A\*:**
  1. Recompute one potential field **per target group** (players are usually one group)
     at **5–10 Hz**, or immediately when topology changes (barricade placed/destroyed).
  2. Each zombie reads the gradient at its cell → desired velocity, then adds
     **local separation** via spatial hash (O(n) flocking term), plus wall-sliding.
  3. Cost: one Dijkstra over e.g. 100×100 grid ≈ 10k cells ≈ sub-ms; hundreds of zombies
     cost only the steering pass (also sub-ms at 30 Hz).
- Result: **100–500 zombies on one Node process** is realistic; AI never runs on clients
  (clients only animate/interpolate what the server sent).

## 1.6 Game Modes
- **Co-op Survival:** shared wave director, squad camera, revive mechanic. Room type `coop`.
- **Deathmatch / 1v1:** small arena maps, hitscan-heavy, no zombies (or zombie hazards).
  Room type `dm`. Same netcode, different rules module.
- Both are just **different room handlers** on the same server process.

---

# PILLAR 2 — Real-Time Network Architecture

## 2.1 Topology Recommendation

| Option | Latency | Cheat-resistance | Cross-internet complexity | MVP speed | Verdict |
|---|---|---|---|---|---|
| **A1. Colyseus (Node, WebSocket)** | good (20–30 Hz, TCP jitter) | excellent (authoritative) | trivial (one URL, one port) | **fastest** | ✅ **MVP** |
| A2. Geckos.io (Node, WebRTC data channels) | **best** (UDP-like, unreliable/ordered channels) | excellent | medium (ICE/STUN/TURN, UDP on server) | medium | ✅ phase 2 upgrade |
| B1. Godot 4 high-level multiplayer | excellent | good (if server-authoritative) | medium (client install or web export) | slower for a web deliverable | only if pivoting to desktop |
| B2. Unity Fish-Net / Netcode | excellent | excellent | heavier pipeline | slowest to prototype | not for this MVP |
| Client-hosted P2P / WebRTC host | variable | **poor** (host = cheatable) | hard (NAT traversal **+ host migration**) | fast locally, painful online | ❌ rejected |

**Why not P2P:** in a horde shooter the *host* also runs zombie AI and hit validation —
a cheating host ruins every match, and host migration mid-wave is a project by itself.
An **authoritative server** deletes both problems; a single 2-vCPU VPS handles the MVP
horde easily.

**Migration path:** keep the *protocol* (message schemas) transport-agnostic; swapping
Colyseus WebSocket transport for Geckos.io unreliable channels later changes only the
serialization layer (snapshots become loss-tolerant + need baseline keyframes, which the
schema in §2.5 already has).

## 2.2 Architecture Diagram & Data Flow

```
        ┌────────────── CLIENT (browser, 60 fps) ───────────────┐
        │ Input sampling (kbd/mouse) @ render rate              │
        │  → InputMsg {seq, tickAck, move, aim, buttons} @30Hz ─┼──┐
        │                                                       │  │
        │ Local player: PREDICT immediately (shared step())     │  │
        │  → on Snapshot: reconcile + replay pending inputs     │  │
        │ Remote players + zombies: INTERPOLATE from buffer     │  │
        │  (render at serverTick − 100 ms, 2 snapshot delay)    │  │
        │ FX/audio/prediction-error smoothing: client-only      │  │
        └───────────────────────────────────────────────────────┘  │
                                                                   ▼
   ┌────────────────── GAME SERVER (authoritative, Node) ─────────────────────┐
   │ Lobby/rooms: create code ▸ join by code/link ▸ reconnection tokens       │
   │                                                                          │
   │  ┌── 30 Hz fixed sim tick ────────────────────────────────────────────┐  │
   │  │ 1. drain inputs (drop/reject invalid: speed cap, RoF, ammo)        │  │
   │  │ 2. step players: shared movement + grid/AABB collision             │  │
   │  │ 3. weapons: hitscan lag-compensated (§2.4), projectiles step       │  │
   │  │ 4. zombies: flow-field steer + separation, damage, deaths          │  │
   │  │ 5. wave director, combo meters, deployables                        │  │
   │  └────────────────────────────────────────────────────────────────────┘  │
   │  Position history ring buffer (last ~250 ms) for lag compensation        │
   │                                                                          │
   │  ┌── 20 Hz snapshot builder ─────────────────────────────────────────┐   │
   │  │ delta vs baseline ▸ quantize ▸ pack ▸ AOI/relevancy filter        │   │
   │  └─────────────────────── SnapshotMsg ───────────────────────────┐   │   │
   └──────────────────────────────────────────────────────────────────┼───┘
                                                                       ▼
        back to every client: SnapshotMsg + EventMsg (shots, deaths, wave banner)
```

Timeline for one shot (lag compensation):

```
client t=0    input #42 (fire) ────────────────► server (RTT/2 later)
client t=100ms ◄────────────── snapshot tick 2900 confirms fire event
server: rewind history to clientTick(42) (clamped to now−250ms) → raycast
        → hit? apply damage → broadcast HitEvent (killer, victim, weapon)
```

## 2.3 Latency Compensation & Netcode

1. **Client-side prediction (local player only):** run the same `stepPlayer()` from
   `shared/` every input; zero perceived latency for movement.
2. **Server reconciliation:** server acks input `seq`; client discards acked inputs,
   replaces its state with the authoritative one, **replays** unacked inputs.
   Corrections under ~0.15 m are smoothed (exponential blend) instead of snapped;
   bigger errors snap (desync/cheat indicator).
3. **Entity interpolation (remote players, zombies, projectiles):** client keeps a
   ~200 ms buffer of snapshots, renders at `latest − 2×snapshotInterval`. Never
   extrapolate zombies (their motion is server-driven); extrapolate remote *players*
   ≤100 ms only if the buffer starves.
4. **Lag compensation (hitscan):** server keeps a ring buffer of entity positions for
   the last **250 ms** (7–8 ticks). On a fire input, rewind to the shooter's client tick
   (clamped to `now − 250 ms`), raycast against the rewound world, validate
   direction/ammo/RoF. Projectiles (rockets, fireballs) are **not** rewound — they are
   stepped in present time.
5. **Input redundancy:** over WS (reliable/ordered) one input per packet is enough;
   when moving to WebRTC unreliable channels, send **last 3 inputs per packet** so loss
   never stalls the stream.

## 2.4 Anti-cheat / Server Validation (non-negotiable)
- Movement: server clamps velocity (max speed × dt + epsilon), re-runs collision itself.
- Firing: server checks weapon unlocked, ammo, rate-of-fire window, line-of-sight.
- Hits: only server raycasts (with rewind); client "hits" are cosmetic tracers.
- Aim: validate aim vector is within tolerance of the client-declared direction.
- All economy/state (score, combo, waves, spawns) lives server-side.

## 2.5 Horde Synchronization Strategy (100+ zombies)

**Principle: clients never simulate AI; they interpolate compact server state.**

1. **State payload per zombie (quantized, packed):**
   ```
   id        uint16   (room-local index, recycled)
   x, z      int16    (centimeter quantization of world coords)  → 4 B
   dir       uint8    (angle / 256)                               → 1 B
   anim      uint8    (anim state 2b + hp tier 2b + flags 4b)     → 1 B
   hp        uint8    (0 = dying/death anim)                      → 1 B
                                            total ≈ 7 B / zombie
   ```
2. **Delta vs baseline:** snapshot header carries `tick`, `ackSeq`, `baselineTick`,
   plus a **dirty bitmask** (100 zombies → 13 B) so only changed entities are sent.
   A **full keyframe every 50 ticks (~2.5 s)** re-baselines clients (and is the
   recovery point when moving to lossy WebRTC transport).
3. **AOI / spatial hashing:** cells around the camera/squad centroid + margin are
   relevant; far zombies are dropped (or, in co-op with a shared squad view, the whole
   arena is relevant — AOI then only matters for big maps).
4. **Direction instead of full motion:** send `dir` + speed tier; the client advances
   positions between snapshots inside the interpolation window, so 20 Hz reads as smooth.
5. **Events, not state,** for the bursty stuff: `SpawnEvent {type, wave, seed}`,
   `DeathEvent`, `ShotEvent {origin, dir, weapon}`, `ExplosionEvent`, `WaveEvent`.
   One shot informs all clients without per-entity state churn.
6. **Bandwidth budget (MVP):**
   - 100 zombies × 7 B ≈ 700 B full; typical delta ~40 % changed ≈ 300 B
     + bitmask 13 B + header ~12 B ≈ **330 B/tick × 20 Hz ≈ 6.6 KB/s**
   - 4 players × 20 B × 20 Hz ≈ 1.6 KB/s; events ~1 KB/s
   - **≈ 10 KB/s down per client** (≈ 80 kbps) — trivial for any home connection.
7. **Scale-up levers (in order):** shrink snapshot rate for distant groups →
   interest-management per squad → **deterministic shared horde sim** (server sends
   spawn seeds + flow-field version + target assignments; clients step identical
   fixed-point zombie code locally → ~0 B/tick for unchanged groups). The `shared/`
   package is deliberately structured so this later switch is contained.

## 2.6 Matchmaking, Rooms, Lifecycle
- **Lobby:** `POST /rooms` (or Colyseus `create`) → human-readable **6-char room code**
  + shareable link `https://…/join/CODE3X`. Second player types code or opens link →
  instant join; map/weapon/mode options chosen by host in the lobby screen.
- **Join flow:** code → room reservation (20 s) → first player = host (options rights) →
  `onStart` → all clients get `initMsg {roomId, mapSeed, tickRate, yourId, entities}`.
- **Disconnect/reconnect:** Colyseus **reconnection token** stored in `sessionStorage`;
  30 s grace where the player entity is frozen/invulnerable (co-op) or bot-piloted;
  on reconnect the client receives a **full keyframe** and re-syncs to the live tick.
  Expired token → new join = fresh spawn (score kept per session id if desired).
- **Host migration: N/A by design** (server-authoritative — the "host" is the server).
- **Room lifecycle:** `lobby → countdown → playing → (intermission/wave) → ended`;
  empty rooms disposed after 30 s; server crash → clients auto-recreate + rejoin by code.

---

## Deliverable 1 — Tech Stack (final)

```
shared/    TypeScript  — schemas, weapons table, movement/collision, flow-field math,
                         quantization + binary packing helpers, tick constants
client/    TypeScript + Three.js (orthographic) + Vite
             · input, prediction/reconciliation, interpolation buffer, camera modes
             · UI: lobby (room code), HUD (combo/ammo/wave), results screen
server/    Node.js + TypeScript + Colyseus
             · rooms: CoopRoom, DeathmatchRoom
             · 30 Hz sim loop, 20 Hz snapshot builder, wave director, flow-field AI
             · lag-compensated hit validation, deployable entities
deploy/    single VPM VM (Docker), one process per shard, `/healthz` + tick-time metrics
transport  WebSocket (MVP) → Geckos.io WebRTC data channels (phase 2)
```

## Deliverable 2 — Data-flow contract (message schemas)

```ts
// client → server, 30 Hz
InputMsg  { seq: u32, tickAck: u32, moveX: i8, moveZ: i8,
            aim: {x: f32, z: f32}, buttons: u8, weapon: u8 }

// server → client, 20 Hz
SnapshotMsg { tick: u32, ackSeq: u32, baselineTick: u32,
              players: PlayerState[], zombieMask: u32[], zombies: PackedZombie[],
              projectiles: Projectile[], deployables: Deployable[] }

// server → client, unreliable/infrequent
EventMsg   { tick, kind: 'shot'|'hit'|'death'|'spawn'|'wave'|'explosion'|'combo',
             payload }
```

## Deliverable 4 — MVP Roadmap

| Phase | Scope | Acceptance criteria |
|---|---|---|
| **0. Foundation** (2–3 d) | monorepo `client/ server/ shared/`; tick constants; schemas; binary pack/unpack unit tests | `pnpm test` green; round-trip pack = unpack |
| **1. Offline vertical slice** (3–4 d) | refactor current `game_shoot` into top-down: 8-dir movement, grid collision, hitscan shooting, 1 zombie type, wave spawner | playable single-player vs. waves (this proves Pillar 1 core) |
| **2. Lobby** (2 d) | Colyseus room, room code + join link, lobby screen, `initMsg`, reconnect token | 2 PCs on different networks join the same room in <10 s |
| **3. Movement netcode** (3–4 d) | input protocol, server-authoritative players, prediction + reconciliation, interpolation of remote players | 150 ms simulated latency: local move is instant; remote player motion smooth; no rubber-banding |
| **4. Combat** (3 d) | server hitscan + 250 ms lag-comp rewind, damage/death, respawn, hit events, tracer FX | shooting feels correct at 100–200 ms RTT; speed/RoF hacks rejected |
| **5. Horde sync** (4–5 d) | server flow-field AI, spatial-hash separation, packed delta snapshots, zombie interpolation, spawn/death events | **200 zombies @ 30 Hz server, ≤10 KB/s per client, <10 % dropped frames at 60 fps** |
| **6. Waves + weapons** (4 d) | wave director, combo tiers, full weapon roster, barrels/barricades/mines (server-owned, flow-field reroute) | co-op survives to wave 10; barricades visibly reroute zombies |
| **7. Modes & hardening** (3–4 d) | deathmatch room, disconnect handling, keyframe resync, metrics (tick time, bytes/tick), basic anti-cheat audit | 30-min soak test, kill/reconnect mid-wave without desync |

Total ≈ **4–5 weeks** to a playable online co-op MVP with 2 players and 200 zombies.

**Risks & mitigations:** JS server CPU (flow field is O(cells), steering O(n) — profile
at phase 5, keep zombies in typed arrays); WS head-of-line blocking under loss (mitigate
with small snapshots, then Geckos.io); browser pointer-lock/audio quirks (already handled
in the current prototype); map authoring (ship one graybox arena first).
