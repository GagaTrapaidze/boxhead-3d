import { ByteReader, ByteWriter } from '../binary/bytes.ts';
import { dequantizeAim, dequantizePosition, quantizeAim, quantizePosition } from '../quantize.ts';
import { EventKind, MsgType } from './messages.ts';
import type { EventMsg, GameEvent, InputMsg, PlayerState, SnapshotMsg, ZombieState } from './messages.ts';

/**
 * Binary codecs for the three wire messages.
 *
 * Layouts (little-endian; first byte is always MsgType):
 *
 * Input (17 bytes, fixed):
 *   u8 type | u32 seq | u32 tickAck | i8 moveX | i8 moveZ
 *   | i16 aimX | i16 aimZ | u8 buttons | u8 weapon
 *
 * Snapshot (variable):
 *   u8 type | u32 tick | u32 ackSeq | u32 baselineTick
 *   | u8 playerCount | u16 zombieTotal
 *   | playerCount × { u8 id | i16 x | i16 z | u8 dir | u8 hp | u8 weapon | u8 flags }
 *   | [u8 × ceil(zombieTotal/8) delta mask — only if baselineTick !== 0]
 *   | u16 zombieEntryCount
 *   | zombieEntryCount × { u16 id | i16 x | i16 z | u8 dir | u8 state }
 *
 * Event (variable):
 *   u8 type | u32 tick | u8 kind | kind-specific payload (see encodeEvent)
 */

/** Exact wire size of an InputMsg packet. */
export const INPUT_BYTE_LENGTH = 17;

/** Header size shared by every snapshot (before player entries). */
export const SNAPSHOT_HEADER_BYTES = 16;

/** Bytes per player entry inside a snapshot. */
export const PLAYER_ENTRY_BYTES = 9;

/** Bytes per zombie entry inside a snapshot. */
export const ZOMBIE_ENTRY_BYTES = 8;

function packAim(x: number, z: number): [number, number] {
  const length = Math.hypot(x, z);
  if (length < 1e-6) return [0, 0];
  return [quantizeAim(x / length), quantizeAim(z / length)];
}

function popcount8(value: number): number {
  let count = 0;
  for (let bit = 0; bit < 8; bit++) count += (value >> bit) & 1;
  return count;
}

function maskBitIsSet(mask: Uint8Array, id: number): boolean {
  return (((mask[id >> 3] as number) >> (id & 7)) & 1) === 1;
}

function expectType(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`wrong message type: expected ${expected}, got ${actual}`);
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export function encodeInput(msg: InputMsg): Uint8Array {
  const writer = new ByteWriter(INPUT_BYTE_LENGTH);
  const [aimX, aimZ] = packAim(msg.aimX, msg.aimZ);
  writer
    .u8(MsgType.Input)
    .u32(msg.seq)
    .u32(msg.tickAck)
    .i8(msg.moveX)
    .i8(msg.moveZ)
    .i16(aimX)
    .i16(aimZ)
    .u8(msg.buttons)
    .u8(msg.weapon);
  return writer.toBytes();
}

export function decodeInput(bytes: Uint8Array): InputMsg {
  const reader = new ByteReader(bytes);
  expectType(reader.u8(), MsgType.Input);
  const seq = reader.u32();
  const tickAck = reader.u32();
  const moveX = reader.i8();
  const moveZ = reader.i8();
  const aimX = reader.i16();
  const aimZ = reader.i16();
  const buttons = reader.u8();
  const weapon = reader.u8();
  return {
    seq,
    tickAck,
    moveX,
    moveZ,
    aimX: dequantizeAim(aimX),
    aimZ: dequantizeAim(aimZ),
    buttons,
    weapon,
  };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export function encodeSnapshot(snapshot: SnapshotMsg): Uint8Array {
  const isKeyframe = snapshot.baselineTick === 0;

  if (snapshot.players.length > 255) throw new Error('too many players for a snapshot');
  if (snapshot.zombieTotal < 0 || snapshot.zombieTotal > 65535) {
    throw new Error(`zombieTotal out of range: ${snapshot.zombieTotal}`);
  }
  if (snapshot.zombies.length > 65535) throw new Error('too many zombie entries');
  for (const player of snapshot.players) {
    if (!Number.isInteger(player.id) || player.id < 0 || player.id > 255) {
      throw new Error(`player id out of u8 range: ${player.id}`);
    }
  }

  if (isKeyframe) {
    if (snapshot.zombieMask !== null) throw new Error('keyframe must not carry a zombie mask');
    if (snapshot.zombies.length !== snapshot.zombieTotal) {
      throw new Error(
        `keyframe must carry all ${snapshot.zombieTotal} zombies, got ${snapshot.zombies.length}`
      );
    }
  } else {
    const expectedMaskBytes = Math.ceil(snapshot.zombieTotal / 8);
    if (!snapshot.zombieMask) throw new Error('delta snapshot requires a zombie mask');
    if (snapshot.zombieMask.length !== expectedMaskBytes) {
      throw new Error(
        `zombie mask must be ${expectedMaskBytes} bytes, got ${snapshot.zombieMask.length}`
      );
    }
    for (const zombie of snapshot.zombies) {
      if (zombie.id >= snapshot.zombieTotal) {
        throw new Error(`zombie id ${zombie.id} outside mask range (${snapshot.zombieTotal})`);
      }
      if (!maskBitIsSet(snapshot.zombieMask, zombie.id)) {
        throw new Error(`zombie ${zombie.id} sent but its mask bit is clear`);
      }
    }
  }

  const capacity =
    SNAPSHOT_HEADER_BYTES +
    snapshot.players.length * PLAYER_ENTRY_BYTES +
    (isKeyframe ? 0 : snapshot.zombieMask!.length) +
    2 +
    snapshot.zombies.length * ZOMBIE_ENTRY_BYTES;

  const writer = new ByteWriter(capacity);
  writer
    .u8(MsgType.Snapshot)
    .u32(snapshot.tick)
    .u32(snapshot.ackSeq)
    .u32(snapshot.baselineTick)
    .u8(snapshot.players.length)
    .u16(snapshot.zombieTotal);

  for (const player of snapshot.players) {
    writer
      .u8(player.id)
      .i16(quantizePosition(player.x))
      .i16(quantizePosition(player.z))
      .u8(player.dir)
      .u8(player.hp)
      .u8(player.weapon)
      .u8(player.flags);
  }

  if (!isKeyframe) writer.bytes(snapshot.zombieMask!);

  writer.u16(snapshot.zombies.length);
  for (const zombie of snapshot.zombies) {
    writer
      .u16(zombie.id)
      .i16(quantizePosition(zombie.x))
      .i16(quantizePosition(zombie.z))
      .u8(zombie.dir)
      .u8(zombie.state);
  }

  return writer.toBytes();
}

export function decodeSnapshot(bytes: Uint8Array): SnapshotMsg {
  const reader = new ByteReader(bytes);
  expectType(reader.u8(), MsgType.Snapshot);
  const tick = reader.u32();
  const ackSeq = reader.u32();
  const baselineTick = reader.u32();
  const playerCount = reader.u8();
  const zombieTotal = reader.u16();

  const players: PlayerState[] = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({
      id: reader.u8(),
      x: dequantizePosition(reader.i16()),
      z: dequantizePosition(reader.i16()),
      dir: reader.u8(),
      hp: reader.u8(),
      weapon: reader.u8(),
      flags: reader.u8(),
    });
  }

  let zombieMask: Uint8Array | null = null;
  if (baselineTick !== 0) {
    zombieMask = reader.bytes(Math.ceil(zombieTotal / 8));
  }

  const entryCount = reader.u16();
  if (zombieMask !== null) {
    let bits = 0;
    for (let i = 0; i < zombieMask.length; i++) bits += popcount8(zombieMask[i]);
    if (bits !== entryCount) {
      throw new Error(
        `zombie mask declares ${bits} dirty entities but snapshot carries ${entryCount} entries`
      );
    }
  } else if (entryCount !== zombieTotal) {
    throw new Error(`keyframe must carry all ${zombieTotal} zombies, got ${entryCount}`);
  }

  const zombies: ZombieState[] = [];
  for (let i = 0; i < entryCount; i++) {
    zombies.push({
      id: reader.u16(),
      x: dequantizePosition(reader.i16()),
      z: dequantizePosition(reader.i16()),
      dir: reader.u8(),
      state: reader.u8(),
    });
  }

  return { tick, ackSeq, baselineTick, players, zombieTotal, zombieMask, zombies };
}

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------

export function encodeEvent(msg: EventMsg): Uint8Array {
  const writer = new ByteWriter(32);
  writer.u8(MsgType.Event).u32(msg.tick);
  const event = msg.event;
  writer.u8(event.kind);
  switch (event.kind) {
    case EventKind.Shot:
      writer.u8(event.shooterId).u8(event.weapon).f32(event.x).f32(event.z).u8(event.dir);
      break;
    case EventKind.Hit:
      writer.u8(event.attackerId).u8(event.targetId).u8(event.weapon).u8(event.damage);
      break;
    case EventKind.Death:
      writer.u8(event.victimKind).u16(event.id);
      break;
    case EventKind.Spawn:
      writer.u8(event.zombieType).u16(event.id).f32(event.x).f32(event.z).u16(event.wave);
      break;
    case EventKind.Wave:
      writer.u16(event.wave).u16(event.count);
      break;
    case EventKind.Explosion:
      writer.f32(event.x).f32(event.z).u8(event.radius).u8(event.damage);
      break;
    case EventKind.Combo:
      writer.u8(event.playerId).u8(event.tier).u16(event.combo);
      break;
    default: {
      const exhaustive: never = event;
      throw new Error(`unknown event kind: ${JSON.stringify(exhaustive)}`);
    }
  }
  return writer.toBytes();
}

export function decodeEvent(bytes: Uint8Array): EventMsg {
  const reader = new ByteReader(bytes);
  expectType(reader.u8(), MsgType.Event);
  const tick = reader.u32();
  const kind = reader.u8();
  let event: GameEvent;
  switch (kind) {
    case EventKind.Shot:
      event = {
        kind: EventKind.Shot,
        shooterId: reader.u8(),
        weapon: reader.u8(),
        x: reader.f32(),
        z: reader.f32(),
        dir: reader.u8(),
      };
      break;
    case EventKind.Hit:
      event = {
        kind: EventKind.Hit,
        attackerId: reader.u8(),
        targetId: reader.u8(),
        weapon: reader.u8(),
        damage: reader.u8(),
      };
      break;
    case EventKind.Death:
      event = { kind: EventKind.Death, victimKind: reader.u8(), id: reader.u16() };
      break;
    case EventKind.Spawn:
      event = {
        kind: EventKind.Spawn,
        zombieType: reader.u8(),
        id: reader.u16(),
        x: reader.f32(),
        z: reader.f32(),
        wave: reader.u16(),
      };
      break;
    case EventKind.Wave:
      event = { kind: EventKind.Wave, wave: reader.u16(), count: reader.u16() };
      break;
    case EventKind.Explosion:
      event = {
        kind: EventKind.Explosion,
        x: reader.f32(),
        z: reader.f32(),
        radius: reader.u8(),
        damage: reader.u8(),
      };
      break;
    case EventKind.Combo:
      event = {
        kind: EventKind.Combo,
        playerId: reader.u8(),
        tier: reader.u8(),
        combo: reader.u16(),
      };
      break;
    default:
      throw new Error(`unknown event kind: ${kind}`);
  }
  return { tick, event };
}
