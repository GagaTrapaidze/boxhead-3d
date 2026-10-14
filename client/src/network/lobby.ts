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
  /** Players ordered by seat (index 0 first). */
  players: OnlinePlayer[];
}

/** The transform sample the game loop sends ~20 Hz once playing. */
export interface PresenceSample {
  x: number;
  z: number;
  aimX: number;
  aimZ: number;
  hp: number;
  weapon: number;
}

export interface LobbyHandlers {
  onStatus: (state: ConnectionState, message: string) => void;
  /** Fires on every state patch (and once on connect). `null` clears the lobby. */
  onRoom: (info: RoomInfo | null) => void;
  /** Fires exactly once when the room transitions lobby → playing. */
  onStart: (info: RoomInfo) => void;
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
}

interface RawState {
  code: string;
  hostId: string;
  mapId: string;
  phase: string;
  matchOver: boolean;
  players: {
    size: number;
    forEach: (callback: (player: RawPlayer, key: string) => void) => void;
  };
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
      });
    });
    players.sort((a, b) => a.seat - b.seat);

    const phase = state.phase === 'playing' ? 'playing' : 'lobby';
    return {
      code: state.code ?? room.roomId,
      hostId: state.hostId ?? '',
      mapId: state.mapId ?? DEFAULT_MAP_ID,
      phase,
      selfId: room.sessionId,
      isHost: state.hostId === room.sessionId,
      matchOver: state.matchOver === true,
      players,
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
