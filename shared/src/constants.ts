// ---------------------------------------------------------------------------
// Network / simulation timing (single source of truth for client & server)
// ---------------------------------------------------------------------------

/** Server simulation frequency, Hz. */
export const TICK_RATE = 30;

/** Milliseconds per simulation tick (33.33…). */
export const TICK_MS = 1000 / TICK_RATE;

/** State broadcast frequency, Hz. */
export const SNAPSHOT_RATE = 20;

/** Lag-compensation window: how far the server may rewind history for a shot. */
export const LAG_COMPENSATION_MS = 250;

/** The window above expressed in whole ticks (ceil → 8 ticks ≈ 266 ms). */
export const LAG_COMPENSATION_TICKS = Math.ceil((LAG_COMPENSATION_MS * TICK_RATE) / 1000);

/** Render remote entities this many ticks behind the latest server tick (≈100 ms). */
export const INTERP_DELAY_TICKS = 3;

/** The delay above in milliseconds. */
export const INTERP_DELAY_MS = INTERP_DELAY_TICKS * TICK_MS;

/**
 * True on ticks where a snapshot must be broadcast.
 *
 * SNAPSHOT_RATE (20) does not divide TICK_RATE (30), so the interval is 1.5
 * ticks: snapshots alternate 2, 1, 2, 1… ticks apart and exactly SNAPSHOT_RATE
 * snapshots are produced per TICK_RATE ticks.
 */
export function isSnapshotTick(tick: number): boolean {
  if (tick <= 0) return true;
  return (
    Math.floor((tick * SNAPSHOT_RATE) / TICK_RATE) !==
    Math.floor(((tick - 1) * SNAPSHOT_RATE) / TICK_RATE)
  );
}

// ---------------------------------------------------------------------------
// Rooms / matchmaking
// ---------------------------------------------------------------------------

export const MAX_PLAYERS = 4;

/** Public Colyseus room name used for matchmaking (see server/src/rooms/CoopRoom.ts). */
export const COOP_ROOM_NAME = 'coop';

/** Human-readable room-code length; the 6-char code doubles as the Colyseus roomId. */
export const ROOM_CODE_LENGTH = 6;
/** Crockford-ish alphabet: no 0/O, 1/I/L to keep codes readable aloud. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 23 letters + 8 digits = 31
export const RECONNECT_GRACE_MS = 30_000;

// ---------------------------------------------------------------------------
// Gameplay / world
// ---------------------------------------------------------------------------

export const ARENA_RADIUS = 30; // world units, playable circle
export const PLAYER_SPEED = 9; // world units per second
export const PLAYER_RADIUS = 0.4; // world units, AABB/circle collision
export const PLAYER_MAX_HP = 100;
export const MAX_ZOMBIES = 512; // hard cap per room (wire ids are u16)

// ---------------------------------------------------------------------------
// Wire quantization
// ---------------------------------------------------------------------------

/** 1 world unit = 100 on the wire → i16 covers ±327.67 world units at 1 cm steps. */
export const POSITION_SCALE = 100;

/** Aim vectors are normalized then scaled into i16 (±32767). */
export const AIM_SCALE = 32767;

/** Heading is stored as angle/360° × 256 in a u8 (≈1.41° per step). */
export const DIRECTION_STEPS = 256;
