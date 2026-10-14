/**
 * CoopRoom — the authoritative lobby/game room for online co-op.
 *
 * This is the Phase 2 matchmaking room: it owns a human-readable 6-char room
 * code (the code *is* the Colyseus roomId, so clients join by code), tracks the
 * connected players, elects a host, relays lightweight presence (position/aim/
 * hp/weapon) and lets the host start the match.
 *
 * Scope note: this room is a *lobby + presence* layer (see the two-player MVP).
 * Enemy/combat simulation stays client-side for now; server-authoritative
 * movement and horde sync arrive in Phase 3–5 (ARCHITECTURE.md §2.3–2.5).
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
} from '../../../shared/src/constants.ts';
import { DEFAULT_MAP_ID, getMap } from '../../../shared/src/maps.ts';

/** One player's synchronized presence inside the room. */
export const PlayerPresence = schema(
  {
    name: 'string',
    /** 0-based seat index, stable for the lifetime of the room. */
    seat: 'uint8',
    /** false while the player is inside their reconnection grace window. */
    connected: 'boolean',
    x: 'float32',
    z: 'float32',
    aimX: 'float32',
    aimZ: 'float32',
    hp: 'uint8',
    weapon: 'uint8',
  },
  'PlayerPresence'
);
export type PlayerPresence = SchemaType<typeof PlayerPresence>;

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
    players: { map: PlayerPresence },
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

export class CoopRoom extends Room {
  override maxClients = MAX_PLAYERS;
  /** 20 Hz presence updates — matches the snapshot cadence in shared constants. */
  override patchRate = 50;
  override state = new CoopRoomState();

  override onCreate(options: CoopJoinOptions = {}): void {
    this.roomId = allocateRoomCode();
    activeCodes.add(this.roomId);

    this.state.code = this.roomId;
    this.state.hostId = '';
    this.state.phase = 'lobby';
    this.state.mapId = getMap(options.mapId ?? DEFAULT_MAP_ID).id;

    // Metadata lets future matchmaking queries (and dashboards) find the room
    // by code/phase without receiving the full state.
    this.setMetadata({ code: this.roomId, mapId: this.state.mapId, phase: this.state.phase });

    // --- presence: high-frequency transform relay, no schema round-trip -------
    this.onMessage('presence', (client: Client, msg: Record<string, unknown>) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || this.state.phase !== 'playing') return;
      player.x = clamp(msg?.x, -512, 512, player.x);
      player.z = clamp(msg?.z, -512, 512, player.z);
      player.aimX = clamp(msg?.aimX, -1, 1, player.aimX);
      player.aimZ = clamp(msg?.aimZ, -1, 1, player.aimZ);
      player.hp = clamp(msg?.hp, 0, PLAYER_MAX_HP, player.hp);
      player.weapon = clamp(msg?.weapon, 0, 255, player.weapon);
    });

    // --- map choice: host-only, lobby-only -----------------------------------
    this.onMessage('setMap', (client: Client, msg: { mapId?: string }) => {
      if (client.sessionId !== this.state.hostId) return;
      if (this.state.phase !== 'lobby') return;
      this.state.mapId = getMap(msg?.mapId ?? DEFAULT_MAP_ID).id;
    });

    // --- start: host-only, from the lobby ------------------------------------
    this.onMessage('start', (client: Client) => {
      if (client.sessionId !== this.state.hostId) return;
      if (this.state.phase !== 'lobby') return;
      if (this.state.players.size < 1) return;
      this.state.phase = 'playing';
      this.setMetadata({ code: this.state.code, mapId: this.state.mapId, phase: 'playing' });
    });
  }

  override onJoin(client: Client, options: CoopJoinOptions = {}): void {
    const seat = this.firstFreeSeat();
    const player = new PlayerPresence();
    player.name = sanitizeName(options.name);
    player.seat = seat;
    player.connected = true;
    player.x = 0;
    player.z = 0;
    player.aimX = 1;
    player.aimZ = 0;
    player.hp = PLAYER_MAX_HP;
    player.weapon = 0;
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
