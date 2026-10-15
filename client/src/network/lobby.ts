/**
 * Lobby — the client-side Colyseus connection for online co-op.
 *
 * Wraps the Colyseus `Client`/`Room` lifecycle behind a small, typed facade:
 * create/join a room by its 6-char code, track connection state, surface the
 * synchronized player list, relay presence (position/aim/hp/weapon), and let
 * the host start the match. `main.ts` owns one `Lobby` for the whole session
 * and feeds its presence samples from the game loop.
 *
 * The server endpoint comes from `VITE_SERVER_URL` (see ./serverUrl.ts).
 */
import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';

import {
  COOP_ROOM_NAME,
  MAX_PLAYERS,
  PLAYER_MAX_HP,
  RECONNECT_GRACE_MS,
  ROOM_CODE_LENGTH,
} from '../../../shared/src/constants.ts';
import { DEFAULT_MAP_ID } from '../../../shared/src/maps.ts';
import {
  dropKindFromCode,
  enemyKindFromCode,
  propKindCode,
  propKindFromCode,
} from '../../../shared/src/loot.ts';
import type { DropKind, EnemyKind, PropKind } from '../../../shared/src/loot.ts';
import type { WaveEventKind } from '../../../shared/src/waveEvents.ts';
import { SERVER_URL } from './serverUrl.ts';

/** Coarse connection lifecycle surfaced to the UI. */
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';

/** One player as seen in the synchronized room state. */
export interface OnlinePlayer {
  sessionId: string;
  name: string;
  seat: number;
  connected: boolean;
  /** Server-authoritative life state: false = downed, awaiting respawn. */
  alive: boolean;
  /** Seconds left on this player's respawn countdown (0 while alive). */
  respawnTimer: number;
  x: number;
  z: number;
  aimX: number;
  aimZ: number;
  hp: number;
  weapon: number;
  /**
   * Black Devil "Curse": the player was struck by a shockwave and is bleeding
   * ticking damage until a teammate stands in their cleansing circle for 3 s.
   */
  cursed: boolean;
  /** Cleanse hold progress (0..1) — drives the radial cleansing indicator. */
  cleanseProgress: number;
}

/** One authoritative mob as seen in the synchronized room state. */
export interface OnlineEnemy {
  /** Stable server-assigned id (the map key, parsed back to a number). */
  id: number;
  kind: EnemyKind;
  x: number;
  z: number;
  /** Facing angle in radians. */
  dir: number;
  hp: number;
  maxHp: number;
  /** Devil only: phase-2 rage (burning / dashing) is active. */
  phase2: boolean;
  /**
   * Black Devil only: 0 idle, 1 laser telegraph (charge), 2 laser beam. While
   * charging or firing the boss is frozen and every other attack is disabled.
   */
  attack: number;
  /** Beam aim direction (unit vector) — drives the aim line / beam render. */
  laserX: number;
  laserZ: number;
  /** Beam reach after the continuous raycast clamped it at the first obstacle
   * (the render stops here so the laser never passes through walls / crates). */
  laserLength: number;
  /** Seconds left in the active laser phase (telegraph or channel). */
  attackTimer: number;
  /** sessionId of the player this mob is chasing ("" = none). */
  target: string;
}

/** One authoritative deployable (explosive barrel or wooden crate). */
export interface OnlineProp {
  kind: PropKind;
  cx: number;
  cz: number;
  hp: number;
  maxHp: number;
}

/** One authoritative ground drop. */
export interface OnlineDrop {
  id: number;
  kind: DropKind;
  x: number;
  z: number;
  /** Seconds until the server despawns it. */
  ttl: number;
}

/** One fiery floor patch left by a phase-2 Devil dash. */
export interface OnlineHazard {
  x: number;
  z: number;
  radius: number;
  life: number;
  maxLife: number;
}

/** One enemy projectile in flight (fireball or Black Devil spinner). */
export interface OnlineFireball {
  kind: 'fireball' | 'spinner';
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  /** Spinner orbit phase (radians), synchronized to both clients. */
  spin: number;
}

/** One-shot event: a mob died (the room decides when, everyone reacts at once). */
export interface EnemyKilledEvent {
  id: number;
  kind: EnemyKind;
  x: number;
  z: number;
  /** sessionId of the client whose hit killed it ("" = the horde itself). */
  killer: string;
}

/** One-shot event: a barrel detonated (play the blast FX). */
export interface ExplosionEvent {
  x: number;
  z: number;
  radius: number;
}

/** One-shot event: the Black Devil fired a radial shockwave. */
export interface ShockwaveEvent {
  x: number;
  z: number;
  /** Outer radius the ring expands to. */
  radius: number;
  /** Expansion speed (world units/second) — the ring's travel time must match
   * the server's collision sweep, so the FX uses this rather than a fixed life. */
  speed: number;
}

/** One-shot event: a deployable was destroyed (barrel blast or crate splinters). */
export interface PropDestroyedEvent {
  kind: PropKind;
  cx: number;
  cz: number;
}

/** A stable snapshot of the room the UI and game loop can read. */
export interface RoomInfo {
  /** 6-char shareable room code. */
  code: string;
  hostId: string;
  mapId: string;
  phase: 'lobby' | 'playing';
  /** This client's sessionId. */
  selfId: string;
  isHost: boolean;
  /** True once every player is down at once — Game Over for the whole room. */
  matchOver: boolean;
  /**
   * Shared team score owned by the room: kills and loot credit this one pool, so
   * every client renders the identical number on the same patch.
   */
  teamScore: number;
  /** Players ordered by seat (index 0 first). */
  players: OnlinePlayer[];
  /** Wave director mirrored from the server. */
  wave: number;
  event: WaveEventKind;
  directorPhase: 'intermission' | 'spawning' | 'active';
  directorTimer: number;
  /** Authoritative world entities. */
  enemies: OnlineEnemy[];
  props: OnlineProp[];
  drops: OnlineDrop[];
  hazards: OnlineHazard[];
  fireballs: OnlineFireball[];
}

/** The transform sample the game loop sends ~20 Hz once playing. */
export interface PresenceSample {
  x: number;
  z: number;
  aimX: number;
  aimZ: number;
  hp: number;
  weapon: number;
  /** Current kill-combo multiplier — the room scores kills with it so the team
   * total matches what the shooter's own HUD reads. */
  mult: number;
}

export interface LobbyHandlers {
  onStatus: (state: ConnectionState, message: string) => void;
  /** Fires on every state patch (and once on connect). `null` clears the lobby. */
  onRoom: (info: RoomInfo | null) => void;
  /** Fires exactly once when the room transitions lobby → playing. */
  onStart: (info: RoomInfo) => void;
  /** A mob died — play its death FX (and credit it when we landed the blow). */
  onEnemyKilled: (event: EnemyKilledEvent) => void;
  /** A deployable was destroyed by the server. */
  onPropDestroyed: (event: PropDestroyedEvent) => void;
  /** A barrel blast happened — play the flash / shake at that point. */
  onExplosion: (event: ExplosionEvent) => void;
  /** The boss fired a radial shockwave — play the ring + subtle screen shake. */
  onShockwave: (event: ShockwaveEvent) => void;
  /** The server dealt damage to this client's player (melee / hazard / blast). */
  onDamagePlayer: (amount: number) => void;
  /** A walk-over pickup was granted by the server (broadcast to every client,
   * so both players receive the shared loot benefit). `by` = collector. */
  onGranted: (kind: DropKind, by: string) => void;
  /** A new wave started (banner + toast). */
  onWaveStart: (wave: number, event: WaveEventKind) => void;
  /** A wave was cleared (full-HP restore + magazine refill). */
  onWaveClear: (wave: number) => void;
}

const PRESENCE_INTERVAL_MS = 50; // 20 Hz, matching the server's snapshot cadence
const RECONNECT_TOKEN_KEY = 'boxhead.reconnectionToken';

/** Shape of one decoded player entry in the client's room state. */
interface RawPlayer {
  name: string;
  seat: number;
  connected: boolean;
  alive: boolean;
  respawnTimer: number;
  x: number;
  z: number;
  aimX: number;
  aimZ: number;
  hp: number;
  weapon: number;
  cursed: boolean;
  cleanseProgress: number;
}

interface RawEnemy {
  id: number;
  kind: number;
  x: number;
  z: number;
  dir: number;
  hp: number;
  maxHp: number;
  phase2: boolean;
  attack: number;
  laserX: number;
  laserZ: number;
  laserLength: number;
  attackTimer: number;
  target: string;
}

interface RawProp {
  kind: number;
  cx: number;
  cz: number;
  hp: number;
  maxHp: number;
}

interface RawDrop {
  id: number;
  kind: number;
  x: number;
  z: number;
  ttl: number;
}

interface RawHazard {
  x: number;
  z: number;
  radius: number;
  life: number;
  maxLife: number;
}

interface RawFireball {
  kind: number;
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  spin: number;
}

/** A Colyseus map-like collection (MapSchema). */
interface RawMap<T> {
  size: number;
  forEach: (callback: (value: T, key: string) => void) => void;
}

interface RawState {
  code: string;
  hostId: string;
  mapId: string;
  phase: string;
  matchOver: boolean;
  teamScore: number;
  wave: number;
  event: string;
  directorPhase: string;
  directorTimer: number;
  players: RawMap<RawPlayer>;
  enemies: RawMap<RawEnemy>;
  props: RawMap<RawProp>;
  drops: RawMap<RawDrop>;
  hazards: RawMap<RawHazard>;
  fireballs: RawMap<RawFireball>;
}

function readReconnectToken(): string | null {
  try {
    return window.sessionStorage.getItem(RECONNECT_TOKEN_KEY);
  } catch {
    return null; // storage can throw in private mode
  }
}

function writeReconnectToken(token: string | null): void {
  try {
    if (token) window.sessionStorage.setItem(RECONNECT_TOKEN_KEY, token);
    else window.sessionStorage.removeItem(RECONNECT_TOKEN_KEY);
  } catch {
    /* storage unavailable — reconnection simply won't survive a reload */
  }
}

/** Coerces a wire event string into the shared `WaveEventKind` union. */
function normalizeEvent(value: unknown): WaveEventKind {
  return value === 'speedHorde' || value === 'blackout' ? value : 'none';
}

/** Human-readable message for a matchmaking/connection failure. */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|invalid room/i.test(message)) {
    return 'ასეთი კოდით ოთახი ვერ მოიძებნა — შეამოწმე კოდი.';
  }
  return `ვერ დავუკავშირდი სერვერს. (${message})`;
}

export class Lobby {
  private readonly client: Client;
  private room: Room | null = null;
  private started = false;
  /** True once we deliberately leave, so onLeave doesn't try to reconnect. */
  private leaving = false;
  private lastPresenceAt = 0;

  constructor(private readonly handlers: LobbyHandlers) {
    this.client = new Client(SERVER_URL);
  }

  get selfId(): string {
    return this.room?.sessionId ?? '';
  }

  get isConnected(): boolean {
    return this.room !== null && !this.leaving;
  }

  /** Creates a fresh room (this client becomes host) and waits for its state. */
  async createRoom(name: string, mapId: string): Promise<void> {
    this.handlers.onStatus('connecting', 'ოთახი იქმნება…');
    try {
      const room = await this.client.create(COOP_ROOM_NAME, { name, mapId });
      this.attach(room);
    } catch (error) {
      this.fail(error);
    }
  }

  /** Joins an existing room by its 6-char code. */
  async joinRoom(code: string, name: string): Promise<void> {
    const normalized = code.trim().toUpperCase();
    if (normalized.length !== ROOM_CODE_LENGTH) {
      this.handlers.onStatus('error', `კოდი ${ROOM_CODE_LENGTH} სიმბოლო უნდა იყოს.`);
      return;
    }
    this.handlers.onStatus('connecting', 'ოთახს ვუკავშირდები…');
    try {
      const room = await this.client.joinById(normalized, { name });
      this.attach(room);
    } catch (error) {
      this.fail(error);
    }
  }

  /** Host only: flips the room to `playing` so every client starts together. */
  startMatch(): void {
    this.room?.send('start');
  }

  /**
   * Host only: (re)starts the match. The server resets every player to full
   * health and clears Game Over, so this doubles as the "Play Again" action.
   */
  requestRestart(): void {
    this.room?.send('start');
  }

  /** Reports the local player's HP hitting 0 — starts the server respawn clock. */
  reportDeath(): void {
    this.room?.send('death');
  }

  // --- authoritative world messages ----------------------------------------

  /**
   * Reports damage this client resolved against a mob (its own shot). The room
   * applies it, kills/destroys as needed and broadcasts the result.
   */
  reportEnemyHit(enemyId: number, damage: number, weaponId: number): void {
    if (damage <= 0) return;
    this.room?.send('damageEnemy', { id: enemyId, damage, weaponId });
  }

  /** Reports shot damage to a deployed barrel / crate at a grid cell. */
  reportPropDamage(cx: number, cz: number, damage: number): void {
    if (damage <= 0) return;
    this.room?.send('damageProp', { cx, cz, damage });
  }

  /** Asks the room to deploy a barrel / crate on a grid cell (server-validated). */
  requestPlaceProp(kind: PropKind, cx: number, cz: number): void {
    this.room?.send('placeProp', { kind: propKindCode(kind), cx, cz });
  }

  /** Reports walking over a drop — the room grants the item and removes it. */
  requestPickup(dropId: number, x: number, z: number): void {
    this.room?.send('pickupItem', { id: dropId, x, z });
  }

  /**
   * Reports a blast this client resolved (grenade / rocket / mine). The room owns
   * the outcome: mob damage, prop chains, kills and player damage.
   * `playerDamage` of -1 means "scale with distance" (barrels); 0 = mobs only.
   */
  reportExplosion(
    x: number,
    z: number,
    radius: number,
    damage: number,
    playerDamage: number
  ): void {
    this.room?.send('explode', { x, z, radius, damage, playerDamage });
  }

  /** Host only, lobby only: changes the arena everyone will play. */
  setMap(mapId: string): void {
    this.room?.send('setMap', { mapId });
  }

  /**
   * Relays this client's transform to the room. Throttled to 20 Hz internally,
   * so the game loop can call it every frame.
   */
  sendPresence(sample: PresenceSample): void {
    const room = this.room;
    if (!room) return;
    const now = performance.now();
    if (now - this.lastPresenceAt < PRESENCE_INTERVAL_MS) return;
    this.lastPresenceAt = now;
    room.send('presence', sample);
  }

  /** Leaves the current room (consented). Safe to call when not connected. */
  leave(): void {
    this.leaving = true;
    this.started = false;
    this.room?.leave(true);
    this.room = null;
    writeReconnectToken(null);
    this.handlers.onRoom(null);
    this.handlers.onStatus('idle', '');
  }

  // --- internals ------------------------------------------------------------

  private attach(room: Room): void {
    this.room = room;
    this.started = false;
    this.leaving = false;
    this.lastPresenceAt = 0;
    writeReconnectToken(`${room.roomId}:${room.reconnectionToken}`);

    this.handlers.onStatus('connected', `დაკავშირებულია — ოთახი ${room.roomId}`);

    room.onStateChange(() => this.handleState());
    room.onError((code, message) => {
      this.handlers.onStatus('error', `სერვერის შეცდომა (${code}): ${message ?? ''}`);
    });
    room.onLeave((code) => this.handleLeave(code));

    // One-shot world events — every client reacts to these at the same instant.
    room.onMessage('enemyKilled', (msg: { id: number; kind: number; x: number; z: number; killer: string }) => {
      this.handlers.onEnemyKilled({
        id: msg.id,
        kind: enemyKindFromCode(msg.kind),
        x: msg.x,
        z: msg.z,
        killer: msg.killer ?? '',
      });
    });
    room.onMessage('propDestroyed', (msg: { kind: number; cx: number; cz: number }) => {
      this.handlers.onPropDestroyed({
        kind: propKindFromCode(msg.kind),
        cx: msg.cx,
        cz: msg.cz,
      });
    });
    room.onMessage('explosion', (msg: { x: number; z: number; radius: number }) => {
      this.handlers.onExplosion({ x: msg.x, z: msg.z, radius: msg.radius });
    });
    room.onMessage('shockwave', (msg: { x: number; z: number; radius: number; speed?: number }) => {
      this.handlers.onShockwave({
        x: msg.x,
        z: msg.z,
        radius: msg.radius,
        speed: msg.speed ?? 0,
      });
    });
    room.onMessage('damagePlayer', (msg: { amount: number }) => {
      this.handlers.onDamagePlayer(msg.amount);
    });
    room.onMessage('granted', (msg: { kind: number; by?: string }) => {
      this.handlers.onGranted(dropKindFromCode(msg.kind), msg.by ?? '');
    });
    room.onMessage('waveStart', (msg: { wave: number; event: string }) => {
      this.handlers.onWaveStart(msg.wave, normalizeEvent(msg.event));
    });
    room.onMessage('waveClear', (msg: { wave: number }) => {
      this.handlers.onWaveClear(msg.wave);
    });

    this.handleState(); // initial state may already be present
  }

  private handleState(): void {
    const room = this.room;
    if (!room) return;
    const info = this.buildInfo(room);
    this.handlers.onRoom(info);
    if (info.phase === 'playing' && !info.matchOver && !this.started) {
      this.started = true;
      this.handlers.onStart(info);
    } else if (info.phase !== 'playing' || info.matchOver) {
      // Not live (lobby, or Game Over) — arm a fresh start when the host restarts.
      this.started = false;
    }
  }

  private handleLeave(code: number): void {
    if (this.leaving) return; // we initiated it
    this.room = null;

    const token = readReconnectToken();
    if (!token) {
      this.fail(null);
      return;
    }

    // Unexpected drop: the server holds the seat for RECONNECT_GRACE_MS.
    this.handlers.onStatus('connecting', 'კავშირი გაწყდა — ვცდილობ ხელახლა დაკავშირებას…');
    this.client
      .reconnect(token)
      .then((room) => this.attach(room))
      .catch(() => {
        writeReconnectToken(null);
        this.handlers.onStatus(
          'error',
          `კავშირი აღარ აღდგა (კოდი ${code}). სცადე ხელახლა.`
        );
        this.handlers.onRoom(null);
      });
  }

  private buildInfo(room: Room): RoomInfo {
    const state = room.state as RawState;
    const players: OnlinePlayer[] = [];
    // Guard: the first patch may carry a partially-built state object.
    state.players?.forEach((player, sessionId) => {
      players.push({
        sessionId,
        name: player.name,
        seat: player.seat,
        connected: player.connected,
        alive: player.alive !== false,
        respawnTimer: player.respawnTimer ?? 0,
        x: player.x,
        z: player.z,
        aimX: player.aimX,
        aimZ: player.aimZ,
        hp: player.hp,
        weapon: player.weapon,
        cursed: player.cursed === true,
        cleanseProgress: player.cleanseProgress ?? 0,
      });
    });
    players.sort((a, b) => a.seat - b.seat);

    const enemies: OnlineEnemy[] = [];
    state.enemies?.forEach((enemy) => {
      enemies.push({
        id: enemy.id,
        kind: enemyKindFromCode(enemy.kind),
        x: enemy.x,
        z: enemy.z,
        dir: enemy.dir ?? 0,
        hp: enemy.hp,
        maxHp: enemy.maxHp,
        phase2: enemy.phase2 === true,
        attack: enemy.attack ?? 0,
        laserX: enemy.laserX ?? 0,
        laserZ: enemy.laserZ ?? 0,
        laserLength: enemy.laserLength ?? 0,
        attackTimer: enemy.attackTimer ?? 0,
        target: enemy.target ?? '',
      });
    });

    const props: OnlineProp[] = [];
    state.props?.forEach((prop) => {
      props.push({
        kind: propKindFromCode(prop.kind),
        cx: prop.cx,
        cz: prop.cz,
        hp: prop.hp,
        maxHp: prop.maxHp,
      });
    });

    const drops: OnlineDrop[] = [];
    state.drops?.forEach((drop) => {
      drops.push({
        id: drop.id,
        kind: dropKindFromCode(drop.kind),
        x: drop.x,
        z: drop.z,
        ttl: drop.ttl ?? 0,
      });
    });

    const hazards: OnlineHazard[] = [];
    state.hazards?.forEach((hazard) => {
      hazards.push({
        x: hazard.x,
        z: hazard.z,
        radius: hazard.radius,
        life: hazard.life,
        maxLife: hazard.maxLife,
      });
    });

    const fireballs: OnlineFireball[] = [];
    state.fireballs?.forEach((ball) => {
      fireballs.push({
        kind: ball.kind === 1 ? 'spinner' : 'fireball',
        x: ball.x,
        z: ball.z,
        dirX: ball.dirX,
        dirZ: ball.dirZ,
        spin: ball.spin ?? 0,
      });
    });

    const phase = state.phase === 'playing' ? 'playing' : 'lobby';
    const directorPhase =
      state.directorPhase === 'spawning' || state.directorPhase === 'active'
        ? state.directorPhase
        : 'intermission';
    return {
      code: state.code ?? room.roomId,
      hostId: state.hostId ?? '',
      mapId: state.mapId ?? DEFAULT_MAP_ID,
      phase,
      selfId: room.sessionId,
      isHost: state.hostId === room.sessionId,
      matchOver: state.matchOver === true,
      teamScore: state.teamScore ?? 0,
      players,
      wave: state.wave ?? 0,
      event: normalizeEvent(state.event),
      directorPhase,
      directorTimer: state.directorTimer ?? 0,
      enemies,
      props,
      drops,
      hazards,
      fireballs,
    };
  }

  private fail(error: unknown): void {
    this.room = null;
    this.handlers.onStatus('error', error ? describeError(error) : 'დაკავშირება ვერ მოხერხდა.');
    this.handlers.onRoom(null);
  }
}

/** Re-exported so callers don't need to reach into shared constants directly. */
export { MAX_PLAYERS, PLAYER_MAX_HP };

/** The reconnection grace window the server grants, in seconds (for UI copy). */
export const RECONNECT_GRACE_SECONDS = RECONNECT_GRACE_MS / 1000;
