/**
 * CoopRoom — the authoritative lobby/game room for online co-op.
 *
 * The room owns the whole shared world: a human-readable 6-char room code (the
 * code *is* the Colyseus roomId, so clients join by code), the connected players
 * (presence + life state), and — through {@link WorldSim} — every enemy's id,
 * position, health and target, the wave director, barrels / crates, explosive
 * chain reactions, the Devil's fireballs / hazards and dropped loot.
 *
 * Clients are thin renderers for that world: they mirror `state.enemies`,
 * `state.props` and `state.drops` into meshes, resolve their own shots against
 * the mirrored positions and report the damage back (`damageEnemy`,
 * `damageProp`, `explode`); the room applies it, kills/destroys, rolls drops and
 * broadcasts one-shot events (`enemyKilled`, `propDestroyed`, `explosion`,
 * `waveStart`, `waveClear`) so every client reacts at the same instant.
 *
 * Player HP stays client-authoritative: the room forwards melee / hazard /
 * fireball / explosion damage to the affected client via `damagePlayer`.
 *
 * State is declared with the decorator-free `schema()` builder, so it runs
 * under Node's type-stripping dev server (`node --experimental-strip-types`)
 * with no compiler transform.
 */
import { Room } from 'colyseus';
import type { Client } from 'colyseus';
import { schema, type SchemaType } from '@colyseus/schema';

import {
  MAX_PLAYERS,
  PLAYER_MAX_HP,
  RECONNECT_GRACE_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  SNAPSHOT_RATE,
  TICK_MS,
} from '../../../shared/src/constants.ts';
import { COOP_CONFIG, ENEMY_CONFIG, WAVE_CONFIG } from '../../../shared/src/balance.config.ts';
import { DEFAULT_MAP_ID, getMap } from '../../../shared/src/maps.ts';
import { dropKindCode, enemyKindCode, propKindCode } from '../../../shared/src/loot.ts';
import type { PropKind } from '../../../shared/src/loot.ts';
import { WorldSim } from './world.ts';

/** One player's synchronized presence inside the room. */
export const PlayerPresence = schema(
  {
    name: 'string',
    /** 0-based seat index, stable for the lifetime of the room. */
    seat: 'uint8',
    /** false while the player is inside their reconnection grace window. */
    connected: 'boolean',
    /** Server-authoritative life state: false = downed, awaiting respawn. */
    alive: 'boolean',
    /** Seconds left before this downed player respawns (0 while alive). */
    respawnTimer: 'float32',
    x: 'float32',
    z: 'float32',
    aimX: 'float32',
    aimZ: 'float32',
    hp: 'uint8',
    weapon: 'uint8',
    //
    // Black Devil "Curse" (co-op): set the instant a shockwave lands on this
    // player. While true the client draws the 2 u cleansing circle around them
    // and the server bleeds `curseDamage` on the configured interval.
    cursed: 'boolean',
    /** Cleanse hold progress (0..1): a teammate inside the circle for 3 s lifts
     * the curse. Both clients render the same radial progress indicator. */
    cleanseProgress: 'float32',
  },
  'PlayerPresence'
);
export type PlayerPresence = SchemaType<typeof PlayerPresence>;

/** One authoritative mob in the shared world. */
export const EnemyState = schema(
  {
    /** `EnemyKind` wire code (see shared/src/loot.ts). */
    kind: 'uint8',
    /** Stable server-assigned id (the map key is its decimal string). */
    id: 'uint16',
    x: 'float32',
    z: 'float32',
    /** Facing angle in radians — clients copy this onto the mesh rotation. */
    dir: 'float32',
    hp: 'uint16',
    maxHp: 'uint16',
    /** Devil only: phase-2 rage (burning / dashing) is active. */
    phase2: 'boolean',
    /**
     * Black Devil only: attack state — 0 idle, 1 laser telegraph (charge),
     * 2 laser beam channel. While charge/fire the boss is frozen and every
     * other attack is disabled.
     */
    attack: 'uint8',
    /** Beam aim direction (unit vector) — clients draw the telegraph/beam. */
    laserX: 'float32',
    laserZ: 'float32',
    /** Beam reach after the continuous raycast clamps it at the first wall /
     * crate (clients draw the telegraph and beam only this far). */
    laserLength: 'float32',
    /** Seconds left in the active laser phase (telegraph or channel). */
    attackTimer: 'float32',
    /** sessionId of the player this mob is currently chasing ("" = none). */
    target: 'string',
  },
  'EnemyState'
);
export type EnemyState = SchemaType<typeof EnemyState>;

/** One authoritative deployable (explosive barrel or wooden crate). */
export const PropState = schema(
  {
    /** `PropKind` wire code (see shared/src/loot.ts). */
    kind: 'uint8',
    cx: 'uint16',
    cz: 'uint16',
    hp: 'uint16',
    maxHp: 'uint16',
  },
  'PropState'
);
export type PropState = SchemaType<typeof PropState>;

/** One authoritative ground drop (map key = its decimal drop id). */
export const DropState = schema(
  {
    /** `DropKind` wire code (see shared/src/loot.ts). */
    kind: 'uint8',
    id: 'uint16',
    x: 'float32',
    z: 'float32',
    /** Seconds until the server despawns it (clients blink near the end). */
    ttl: 'float32',
  },
  'DropState'
);
export type DropState = SchemaType<typeof DropState>;

/** One fiery floor patch left behind by a phase-2 Devil dash. */
export const HazardState = schema(
  { x: 'float32', z: 'float32', radius: 'float32', life: 'float32', maxLife: 'float32' },
  'HazardState'
);
export type HazardState = SchemaType<typeof HazardState>;

/** One authoritative enemy projectile in flight (fireball or spinner). */
export const FireballState = schema(
  {
    /** 0 = red Devil fireball, 1 = Black Devil spinner (4 orbiting cubes). */
    kind: 'uint8',
    x: 'float32',
    z: 'float32',
    dirX: 'float32',
    dirZ: 'float32',
    /** Spinner orbit phase in radians (synchronized so both clients agree). */
    spin: 'float32',
  },
  'FireballState'
);
export type FireballState = SchemaType<typeof FireballState>;

/** The room's synchronized state (patched to clients at `patchRate`). */
export const CoopRoomState = schema(
  {
    /** The 6-char shareable room code (mirrors the Colyseus roomId). */
    code: 'string',
    /** sessionId of the host — the only client allowed to start the match. */
    hostId: 'string',
    mapId: 'string',
    /** 'lobby' until the host starts; 'playing' once the match has begun. */
    phase: 'string',
    /** true once every player is down at once — Game Over for the whole room. */
    matchOver: 'boolean',
    /**
     * Shared team score. Every kill (base score × the shooter's combo) and
     * every loot pickup credits this ONE pool, so both clients patch to the
     * same number in the same instant — co-op can never desync on score.
     */
    teamScore: 'uint32',
    /** Wave director: current wave, its themed event and phase/timer. */
    wave: 'uint16',
    event: 'string',
    directorPhase: 'string',
    directorTimer: 'float32',
    players: { map: PlayerPresence },
    enemies: { map: EnemyState },
    props: { map: PropState },
    drops: { map: DropState },
    hazards: { map: HazardState },
    fireballs: { map: FireballState },
  },
  'CoopRoomState'
);
export type CoopRoomState = SchemaType<typeof CoopRoomState>;

/** Options a client may pass to `create()` / `joinById()`. */
export interface CoopJoinOptions {
  name?: string;
  mapId?: string;
}

/**
 * Codes currently in use by live rooms, so `onCreate` never hands out a code
 * that collides with another room in this process (the code doubles as the
 * roomId, which must be unique).
 */
const activeCodes = new Set<string>();

const NAME_MAX_LENGTH = 14;
/** Milliseconds per state patch — the shared 20 Hz snapshot cadence. */
const PATCH_INTERVAL_MS = 1000 / SNAPSHOT_RATE;
/** A single reported hit may never exceed this (guards a rogue/malicious client). */
const MAX_HIT_DAMAGE = 1000;
/** Largest blast radius a client may report (rocket/barell blasts are ≤ 5). */
const MAX_EXPLOSION_RADIUS = 12;
/** Hard ceiling on a client-reported combo multiplier (score-input guard). */
const MAX_SCORE_MULTIPLIER = 1000;

function randomRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

/** Returns an unused code, retrying a bounded number of times. */
function allocateRoomCode(): string {
  for (let attempt = 0; attempt < 25; attempt++) {
    const code = randomRoomCode();
    if (!activeCodes.has(code)) return code;
  }
  // Astronomically unlikely (31^6 ≈ 887M codes); fall back to a code with a
  // digit suffix so we never throw on a collision burst.
  return `${randomRoomCode()}${Math.floor(Math.random() * 10)}`.slice(0, ROOM_CODE_LENGTH);
}

function sanitizeName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  return (name || 'Player').slice(0, NAME_MAX_LENGTH);
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Normalises a client-reported combo multiplier: whole numbers ≥ 1, capped so a
 * rogue client cannot mint unbounded score.
 */
function comboMultiplier(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 1;
  return Math.min(MAX_SCORE_MULTIPLIER, Math.max(1, n));
}

/** Reads a grid coordinate from a message, or null when it is not an integer. */
function readCell(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 0 || value > 255) return null;
  return value;
}

export class CoopRoom extends Room {
  override maxClients = MAX_PLAYERS;
  /** 20 Hz world snapshots (shared/src/constants.ts SNAPSHOT_RATE). */
  override patchRate = PATCH_INTERVAL_MS;
  override state = new CoopRoomState();

  /** Authoritative world simulation (enemies / props / drops / hazards). */
  private sim: WorldSim = new WorldSim(DEFAULT_MAP_ID);
  /**
   * Last combo multiplier each client reported with its presence sample. A kill
   * is scored `base × this`, which is exactly the value the shooter's own HUD
   * shows at the moment of the killing blow — resolved server-side so every
   * client patches the same team total.
   */
  private readonly combos = new Map<string, number>();

  override onCreate(options: CoopJoinOptions = {}): void {
    this.roomId = allocateRoomCode();
    activeCodes.add(this.roomId);

    this.state.code = this.roomId;
    this.state.hostId = '';
    this.state.phase = 'lobby';
    this.state.matchOver = false;
    this.state.mapId = getMap(options.mapId ?? DEFAULT_MAP_ID).id;
    this.state.teamScore = 0;
    this.state.wave = 0;
    this.state.event = 'none';
    this.state.directorPhase = 'intermission';
    this.state.directorTimer = 0;

    this.sim = new WorldSim(this.state.mapId);

    // Metadata lets future matchmaking queries (and dashboards) find the room
    // by code/phase without receiving the full state.
    this.setMetadata({ code: this.roomId, mapId: this.state.mapId, phase: this.state.phase });

    // --- presence: high-frequency transform relay, no schema round-trip -------
    this.onMessage('presence', (client: Client, msg: Record<string, unknown>) => {
      const player = this.state.players.get(client.sessionId);
      // Downed players are frozen at their death spot until respawn.
      if (!player || this.state.phase !== 'playing' || !player.alive) return;
      player.x = clamp(msg?.x, -512, 512, player.x);
      player.z = clamp(msg?.z, -512, 512, player.z);
      player.aimX = clamp(msg?.aimX, -1, 1, player.aimX);
      player.aimZ = clamp(msg?.aimZ, -1, 1, player.aimZ);
      player.hp = clamp(msg?.hp, 0, PLAYER_MAX_HP, player.hp);
      player.weapon = clamp(msg?.weapon, 0, 255, player.weapon);
      this.combos.set(client.sessionId, comboMultiplier(msg?.mult));
    });

    // --- map choice: host-only, lobby-only -----------------------------------
    this.onMessage('setMap', (client: Client, msg: { mapId?: string }) => {
      if (client.sessionId !== this.state.hostId) return;
      if (this.state.phase !== 'lobby') return;
      this.state.mapId = getMap(msg?.mapId ?? DEFAULT_MAP_ID).id;
    });

    // --- start / restart: host-only, resets every player to full ------------
    this.onMessage('start', (client: Client) => {
      if (client.sessionId !== this.state.hostId) return;
      if (this.state.phase === 'playing' && !this.state.matchOver) return; // already live
      if (this.state.players.size < 1) return;
      this.beginMatch();
    });

    // --- death: a client reports its own local player reached 0 HP ----------
    this.onMessage('death', (client: Client) => {
      if (this.state.phase !== 'playing' || this.state.matchOver) return;
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.alive) return;
      player.alive = false;
      player.hp = 0;
      player.respawnTimer = COOP_CONFIG.reviveCountdown;
      // Downing a cursed player lifts their curse immediately ("until cleansed
      // or dies"), freeing the single-curse slot for a teammate. It also opens
      // the respawn / revive immunity window: while this body is down, the
      // simulation's curse guards refuse to curse anyone.
      this.sim.clearCurse(client.sessionId);
      player.cursed = false;
      player.cleanseProgress = 0;
      this.checkGameOver();
    });

    // --- combat: a client resolves its own shot, the room applies the damage --
    this.onMessage('damageEnemy', (client: Client, msg: { id?: number; damage?: number; weaponId?: number }) => {
      if (!this.isLive()) return;
      const id = readCell(msg?.id);
      if (id === null) return;
      const damage = clamp(msg?.damage, 0, MAX_HIT_DAMAGE, 0);
      const weaponId = clamp(msg?.weaponId, 0, 255, 0);
      this.sim.damageEnemy(id, damage, weaponId, client.sessionId);
    });

    // --- props: shot damage, and player placement -----------------------------
    this.onMessage('damageProp', (client: Client, msg: { cx?: number; cz?: number; damage?: number }) => {
      if (!this.isLive()) return;
      const cx = readCell(msg?.cx);
      const cz = readCell(msg?.cz);
      if (cx === null || cz === null) return;
      this.sim.damageProp(cx, cz, clamp(msg?.damage, 0, MAX_HIT_DAMAGE, 0), client.sessionId);
    });

    this.onMessage('placeProp', (client: Client, msg: { kind?: number; cx?: number; cz?: number }) => {
      if (!this.isLive()) return;
      const cx = readCell(msg?.cx);
      const cz = readCell(msg?.cz);
      if (cx === null || cz === null) return;
      const kind: PropKind = msg?.kind === propKindCode('crate') ? 'crate' : 'barrel';
      this.sim.placeProp(kind, cx, cz); // the state patch confirms it for everyone
    });

    // --- confirmation: the room owns the blast (damage, chains, kills) --------
    this.onMessage(
      'explode',
      (client: Client, msg: { x?: number; z?: number; radius?: number; damage?: number; playerDamage?: number }) => {
        if (!this.isLive()) return;
        const x = clamp(msg?.x, -512, 512, 0);
        const z = clamp(msg?.z, -512, 512, 0);
        const radius = clamp(msg?.radius, 0, MAX_EXPLOSION_RADIUS, 0);
        const damage = clamp(msg?.damage, 0, MAX_HIT_DAMAGE, 0);
        // The client's sentinel: a negative value (it sends -1) or an absent
        // field means the blast scales its player damage with distance —
        // barrels and rockets, exactly as offline. A positive value is flat
        // blast damage (grenade/mine), and 0 means the blast spares players.
        const reportedPlayerDamage = msg?.playerDamage;
        const playerDamage =
          typeof reportedPlayerDamage === 'number' && reportedPlayerDamage >= 0
            ? clamp(reportedPlayerDamage, 0, MAX_HIT_DAMAGE, 0)
            : undefined;
        this.sim.explode(x, z, radius, damage, playerDamage, true, client.sessionId);
      }
    );

    // --- loot: walk-over pickup, granted by the server ------------------------
    this.onMessage('pickupItem', (client: Client, msg: { id?: number; x?: number; z?: number }) => {
      if (!this.isLive()) return;
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.alive) return;
      const id = readCell(msg?.id);
      if (id === null) return;
      // Trust the *server's* copy of the player position, not the message's.
      const kind = this.sim.pickup(id, player.x, player.z);
      if (!kind) return;
      // The drop itself is gone from `sim.drops` → it leaves `state.drops` on
      // this same tick, so the cube vanishes for BOTH clients immediately.
      // Loot is a shared team benefit: it credits the team pool and is granted
      // to *every* client (each applies it to its own player), never just the
      // collector.
      this.state.teamScore += WAVE_CONFIG.pickupScore;
      this.broadcast('granted', { kind: dropKindCode(kind), by: client.sessionId });
    });

    // Fixed-rate clock (shared TICK_RATE, 30 Hz): advances the world and the
    // respawn countdowns; the schema is patched at the 20 Hz snapshot rate.
    this.setSimulationInterval((deltaMs: number) => this.tick(deltaMs), TICK_MS);
  }

  /** True while a live match is running (not lobby, not game over). */
  private isLive(): boolean {
    return this.state.phase === 'playing' && !this.state.matchOver;
  }

  /** Resets the room to a fresh, fully-alive match (initial start and restart). */
  private beginMatch(): void {
    this.state.phase = 'playing';
    this.state.matchOver = false;
    this.state.players.forEach((player) => {
      player.alive = true;
      player.hp = PLAYER_MAX_HP;
      player.respawnTimer = 0;
    });
    // A fresh (or re-rolled) world: clears mobs, props, drops and the director.
    this.sim.reset(this.state.mapId);
    // A fresh match starts from zero team score (restart included).
    this.state.teamScore = 0;
    this.combos.clear();
    this.syncWorld();
    this.setMetadata({ code: this.state.code, mapId: this.state.mapId, phase: 'playing' });
  }

  /**
   * One simulation tick: advance the world, flush damage to the affected
   * clients, broadcast the one-shot events, then mirror the world into the
   * schema (patched to everyone at `patchRate`).
   */
  private tick(deltaMs: number): void {
    const dt = deltaMs / 1000;

    if (this.state.phase === 'playing') {
      this.tickRespawns(dt);
      if (!this.state.matchOver) {
        this.sim.syncPlayers(this.simPlayers());
        this.sim.step(dt);
        this.flushPlayerDamage();
        this.flushEvents();
      }
      this.syncWorld();
    }
  }

  /** Live snapshot of the players the simulation chases. */
  private simPlayers(): { id: string; x: number; z: number; alive: boolean }[] {
    const list: { id: string; x: number; z: number; alive: boolean }[] = [];
    this.state.players.forEach((player, sessionId) => {
      list.push({ id: sessionId, x: player.x, z: player.z, alive: player.alive });
    });
    return list;
  }

  /** Routes accumulated melee / hazard / fireball / blast damage to its owner. */
  private flushPlayerDamage(): void {
    const damage = this.sim.drainPlayerDamage();
    if (damage.size === 0) return;
    damage.forEach((amount, sessionId) => {
      const client = this.clients.getById(sessionId);
      if (client) client.send('damagePlayer', { amount });
    });
  }

  /** Broadcasts one-shot world events so every client reacts at the same time. */
  private flushEvents(): void {
    for (const event of this.sim.drainEvents()) {
      if (event.type === 'enemyKilled') {
        // Score is credited here, once, for the whole room: base score × the
        // killer's combo — so both players' HUDs show the same total.
        const multiplier = event.killer ? this.combos.get(event.killer) ?? 1 : 1;
        this.state.teamScore += ENEMY_CONFIG[event.kind].score * multiplier;
        this.broadcast('enemyKilled', {
          id: event.id,
          kind: enemyKindCode(event.kind),
          x: event.x,
          z: event.z,
          killer: event.killer,
        });
      } else if (event.type === 'propDestroyed') {
        this.broadcast('propDestroyed', {
          kind: propKindCode(event.kind),
          cx: event.cx,
          cz: event.cz,
        });
      } else if (event.type === 'explosion') {
        this.broadcast('explosion', { x: event.x, z: event.z, radius: event.radius });
      } else if (event.type === 'shockwave') {
        this.broadcast('shockwave', {
          x: event.x,
          z: event.z,
          radius: event.radius,
          speed: event.speed,
        });
      } else if (event.type === 'waveStart') {
        this.broadcast('waveStart', { wave: event.wave, event: event.event });
      } else {
        this.broadcast('waveClear', { wave: event.wave });
      }
    }
  }

  /**
   * Mirrors the simulation into the schema. Entities are diffed against the
   * existing maps so a steady wave does not thrash the patch stream.
   */
  private syncWorld(): void {
    this.state.wave = this.sim.wave;
    this.state.event = this.sim.event;
    this.state.directorPhase = this.sim.phase;
    this.state.directorTimer = Math.max(0, this.sim.timer);

    // Curse status is sim-owned: mirror it onto each player so both clients see
    // the cleansing circle and its progress bar the moment it changes.
    this.state.players.forEach((player, sessionId) => {
      const cursed = this.sim.isCursed(sessionId);
      player.cursed = cursed;
      player.cleanseProgress = cursed ? this.sim.curseProgressOf(sessionId) : 0;
    });

    // enemies
    const enemyKeys = new Set<string>();
    for (const enemy of this.sim.enemies) {
      const key = String(enemy.id);
      enemyKeys.add(key);
      let entry = this.state.enemies.get(key);
      if (!entry) {
        entry = new EnemyState();
        entry.id = enemy.id;
        this.state.enemies.set(key, entry);
      }
      entry.kind = enemyKindCode(enemy.kind);
      entry.x = enemy.x;
      entry.z = enemy.z;
      entry.dir = enemy.dir;
      entry.hp = Math.max(0, Math.round(enemy.hp));
      entry.maxHp = enemy.maxHp;
      entry.phase2 = enemy.phase2;
      entry.attack =
        enemy.attackState === 'charge' ? 1 : enemy.attackState === 'fire' ? 2 : 0;
      entry.laserX = enemy.laserDirX;
      entry.laserZ = enemy.laserDirZ;
      entry.laserLength = enemy.laserLength;
      entry.attackTimer = Math.max(0, enemy.attackTimer);
      entry.target = enemy.target;
    }
    this.pruneMap(this.state.enemies, enemyKeys);

    // props
    const propKeys = new Set<string>();
    for (const prop of this.sim.props) {
      const key = `${prop.cx},${prop.cz}`;
      propKeys.add(key);
      let entry = this.state.props.get(key);
      if (!entry) {
        entry = new PropState();
        this.state.props.set(key, entry);
      }
      entry.kind = propKindCode(prop.kind);
      entry.cx = prop.cx;
      entry.cz = prop.cz;
      entry.hp = Math.max(0, Math.round(prop.hp));
      entry.maxHp = prop.maxHp;
    }
    this.pruneMap(this.state.props, propKeys);

    // drops
    const dropKeys = new Set<string>();
    for (const drop of this.sim.drops) {
      const key = String(drop.id);
      dropKeys.add(key);
      let entry = this.state.drops.get(key);
      if (!entry) {
        entry = new DropState();
        entry.id = drop.id;
        this.state.drops.set(key, entry);
      }
      entry.kind = dropKindCode(drop.kind);
      entry.x = drop.x;
      entry.z = drop.z;
      entry.ttl = Math.max(0, drop.ttl);
    }
    this.pruneMap(this.state.drops, dropKeys);

    // hazards
    const hazardIds = this.sim.hazards.map((hazard) => String(hazard.id));
    this.state.hazards.clear();
    for (let i = 0; i < this.sim.hazards.length; i++) {
      const hazard = this.sim.hazards[i];
      const entry = new HazardState();
      entry.x = hazard.x;
      entry.z = hazard.z;
      entry.radius = hazard.radius;
      entry.life = Math.max(0, hazard.life);
      entry.maxLife = hazard.maxLife;
      this.state.hazards.set(hazardIds[i], entry);
    }

    // fireballs
    const fireballIds = this.sim.fireballs.map((ball) => String(ball.id));
    this.state.fireballs.clear();
    for (let i = 0; i < this.sim.fireballs.length; i++) {
      const ball = this.sim.fireballs[i];
      const entry = new FireballState();
      entry.kind = ball.kind === 'spinner' ? 1 : 0;
      entry.x = ball.x;
      entry.z = ball.z;
      entry.dirX = ball.dirX;
      entry.dirZ = ball.dirZ;
      entry.spin = ball.spin;
      this.state.fireballs.set(fireballIds[i], entry);
    }
  }

  /** Deletes every map entry whose key is not in `keep`. */
  private pruneMap(map: { forEach: (fn: (value: unknown, key: string) => void) => void; delete: (key: string) => boolean }, keep: Set<string>): void {
    const stale: string[] = [];
    map.forEach((_value, key) => {
      if (!keep.has(key)) stale.push(key);
    });
    for (const key of stale) map.delete(key);
  }

  /**
   * One respawn-clock tick: advance every downed player's countdown and revive
   * anyone whose 10 s lapses while at least one teammate is still alive. If no
   * teammate is alive the room is already over (see {@link checkGameOver}), so
   * respawns simply never fire in that state.
   */
  private tickRespawns(dt: number): void {
    if (this.state.matchOver) return;
    this.state.players.forEach((player) => {
      if (player.alive) return;
      player.respawnTimer = Math.max(0, player.respawnTimer - dt);
      if (player.respawnTimer > 0) return;
      if (!this.anyTeammateAlive(player)) return;
      this.respawnPlayer(player);
    });
  }

  /** Revives one player at full health, back at their seat's authored spawn. */
  private respawnPlayer(player: PlayerPresence): void {
    const spawn = this.spawnForSeat(player.seat);
    player.alive = true;
    player.hp = PLAYER_MAX_HP;
    player.respawnTimer = 0;
    player.x = spawn.x;
    player.z = spawn.z;
    player.aimX = 1;
    player.aimZ = 0;
  }

  /** True while at least one *other* player is still alive. */
  private anyTeammateAlive(player: PlayerPresence): boolean {
    let alive = false;
    this.state.players.forEach((other) => {
      if (other !== player && other.alive) alive = true;
    });
    return alive;
  }

  /** Game Over for the whole room the instant no player is left alive. */
  private checkGameOver(): void {
    if (this.state.matchOver) return;
    let anyAlive = false;
    this.state.players.forEach((player) => {
      if (player.alive) anyAlive = true;
    });
    if (!anyAlive) this.state.matchOver = true;
  }

  /** A seat's safe spawn point from the active map's authored spawn list. */
  private spawnForSeat(seat: number): { x: number; z: number } {
    const spawns = getMap(this.state.mapId).playerSpawns;
    const slot = spawns[seat % spawns.length];
    return { x: slot.x, z: slot.y };
  }

  override onJoin(client: Client, options: CoopJoinOptions = {}): void {
    const seat = this.firstFreeSeat();
    const player = new PlayerPresence();
    player.name = sanitizeName(options.name);
    player.seat = seat;
    player.connected = true;
    player.alive = true;
    player.respawnTimer = 0;
    player.x = 0;
    player.z = 0;
    player.aimX = 1;
    player.aimZ = 0;
    player.hp = PLAYER_MAX_HP;
    player.weapon = 0;
    player.cursed = false;
    player.cleanseProgress = 0;
    this.state.players.set(client.sessionId, player);

    // First player in becomes the host.
    if (!this.state.hostId) {
      this.state.hostId = client.sessionId;
      this.setMetadata({ code: this.state.code, mapId: this.state.mapId, phase: this.state.phase });
    }
  }

  override async onLeave(client: Client, consented?: boolean): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = false;

    // Unexpected drop: hold the seat for a short window so the client can
    // rejoin with its reconnection token (ARCHITECTURE.md §2.6).
    if (!consented) {
      try {
        await this.allowReconnection(client, RECONNECT_GRACE_MS / 1000);
        const rejoined = this.state.players.get(client.sessionId);
        if (rejoined) rejoined.connected = true;
        return;
      } catch {
        // grace window expired — fall through and free the seat
      }
    }

    this.removePlayer(client.sessionId);
  }

  override onDispose(): void {
    activeCodes.delete(this.roomId);
  }

  /** Lowest seat index not currently taken by a connected/pending player. */
  private firstFreeSeat(): number {
    const used = new Set<number>();
    this.state.players.forEach((player) => used.add(player.seat));
    for (let seat = 0; seat < MAX_PLAYERS; seat++) {
      if (!used.has(seat)) return seat;
    }
    return 0; // unreachable while maxClients === MAX_PLAYERS
  }

  private removePlayer(sessionId: string): void {
    // A departed player never keeps the single-curse slot alive.
    this.sim.clearCurse(sessionId);
    this.combos.delete(sessionId);
    this.state.players.delete(sessionId);
    if (this.state.hostId === sessionId) {
      // Elect the lowest-seated remaining player as the new host.
      let nextHost = '';
      let lowestSeat = Infinity;
      this.state.players.forEach((player, id) => {
        if (player.seat < lowestSeat) {
          lowestSeat = player.seat;
          nextHost = id;
        }
      });
      this.state.hostId = nextHost;
    }
  }
}
