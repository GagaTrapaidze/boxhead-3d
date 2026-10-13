// ---------------------------------------------------------------------------
// Wire message schemas — the contract between client and server.
//
// Binary layouts are implemented in ./codec.ts; this module only declares the
// shapes so client and server share one typed source of truth.
// ---------------------------------------------------------------------------

/** First byte of every packet. */
export const MsgType = {
  Input: 1,
  Snapshot: 2,
  Event: 3,
} as const;

export type MsgTypeValue = (typeof MsgType)[keyof typeof MsgType];

/** Bit flags carried in InputMsg.buttons. */
export const Buttons = {
  Fire: 1 << 0,
  AltFire: 1 << 1,
  Reload: 1 << 2,
} as const;

/** client → server, sent once per simulation tick (30 Hz). */
export interface InputMsg {
  /** Monotonic input sequence number (server echoes it back as ackSeq). */
  seq: number;
  /** Latest server tick the client has processed (for RTT estimation). */
  tickAck: number;
  /** -1 | 0 | 1 */
  moveX: number;
  /** -1 | 0 | 1 */
  moveZ: number;
  /** World-space aim direction; normalized by the encoder. */
  aimX: number;
  aimZ: number;
  /** Bitmask of Buttons flags. */
  buttons: number;
  /** Selected weapon id (server validates it is unlocked). */
  weapon: number;
}

/** Flags carried in PlayerState.flags. */
export const PlayerFlags = {
  Dead: 1 << 0,
  Firing: 1 << 1,
  Invulnerable: 1 << 2,
} as const;

/** One player inside a snapshot. x/z are world units (quantized on the wire). */
export interface PlayerState {
  id: number;
  x: number;
  z: number;
  /** 0..255 = angle/360° × 256 (see quantizeDirection). */
  dir: number;
  hp: number;
  weapon: number;
  /** Bitmask of PlayerFlags. */
  flags: number;
}

/** One zombie inside a snapshot. */
export interface ZombieState {
  id: number;
  x: number;
  z: number;
  dir: number;
  /** Packed byte: anim(3 bits) | flags(2 bits) | hpTier(3 bits) — see packZombieState. */
  state: number;
}

/** server → client, broadcast on snapshot ticks (20 Hz). */
export interface SnapshotMsg {
  tick: number;
  /** Highest input seq the server has consumed (client reconciliation point). */
  ackSeq: number;
  /** 0 = keyframe (full state); otherwise the tick the delta is relative to. */
  baselineTick: number;
  players: PlayerState[];
  /** Number of zombie slots in the room (sizes the delta mask). */
  zombieTotal: number;
  /** ceil(zombieTotal/8) bytes; present iff baselineTick !== 0. */
  zombieMask: Uint8Array | null;
  /** Keyframe: every zombie. Delta: only zombies whose mask bit is set. */
  zombies: ZombieState[];
}

/** Occasional reliable events; never per-tick state. */
export const EventKind = {
  Shot: 1,
  Hit: 2,
  Death: 3,
  Spawn: 4,
  Wave: 5,
  Explosion: 6,
  Combo: 7,
} as const;

/** Who died (Death event). */
export const VictimKind = {
  Player: 0,
  Zombie: 1,
  Boss: 2,
} as const;

export type GameEvent =
  | {
      kind: typeof EventKind.Shot;
      shooterId: number;
      weapon: number;
      x: number;
      z: number;
      /** u8-quantized heading (quantizeDirection). */
      dir: number;
    }
  | {
      kind: typeof EventKind.Hit;
      attackerId: number;
      targetId: number;
      weapon: number;
      damage: number;
    }
  | { kind: typeof EventKind.Death; victimKind: number; id: number }
  | {
      kind: typeof EventKind.Spawn;
      zombieType: number;
      id: number;
      x: number;
      z: number;
      wave: number;
    }
  | { kind: typeof EventKind.Wave; wave: number; count: number }
  | { kind: typeof EventKind.Explosion; x: number; z: number; radius: number; damage: number }
  | { kind: typeof EventKind.Combo; playerId: number; tier: number; combo: number };

export interface EventMsg {
  tick: number;
  event: GameEvent;
}

// ---------------------------------------------------------------------------
// Zombie state byte helpers
// ---------------------------------------------------------------------------

/** Packs animation, flags and hp tier into a single wire byte. */
export function packZombieState(anim: number, flags: number, hpTier: number): number {
  return (anim & 0x07) | ((flags & 0x03) << 3) | ((hpTier & 0x07) << 5);
}

/** Inverse of packZombieState. */
export function unpackZombieState(state: number): {
  anim: number;
  flags: number;
  hpTier: number;
} {
  return {
    anim: state & 0x07,
    flags: (state >> 3) & 0x03,
    hpTier: (state >> 5) & 0x07,
  };
}
