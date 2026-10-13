import { test } from 'node:test';
import assert from 'node:assert/strict';

import { POSITION_SCALE } from '../src/constants.ts';
import {
  INPUT_BYTE_LENGTH,
  PLAYER_ENTRY_BYTES,
  SNAPSHOT_HEADER_BYTES,
  ZOMBIE_ENTRY_BYTES,
  decodeEvent,
  decodeInput,
  decodeSnapshot,
  encodeEvent,
  encodeInput,
  encodeSnapshot,
} from '../src/protocol/codec.ts';
import { EventKind, MsgType, packZombieState } from '../src/protocol/messages.ts';
import type { GameEvent, InputMsg, PlayerState, SnapshotMsg, ZombieState } from '../src/protocol/messages.ts';

const HALF_POSITION_STEP = 0.5 / POSITION_SCALE;

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeZombie(id: number, random: () => number): ZombieState {
  return {
    id,
    x: Math.round((random() * 60 - 30) * 100) / 100,
    z: Math.round((random() * 60 - 30) * 100) / 100,
    dir: Math.floor(random() * 256),
    state: packZombieState(
      Math.floor(random() * 8),
      Math.floor(random() * 4),
      Math.floor(random() * 8)
    ),
  };
}

function assertSnapshotEqual(actual: SnapshotMsg, expected: SnapshotMsg): void {
  assert.equal(actual.tick, expected.tick);
  assert.equal(actual.ackSeq, expected.ackSeq);
  assert.equal(actual.baselineTick, expected.baselineTick);
  assert.equal(actual.zombieTotal, expected.zombieTotal);

  assert.equal(actual.players.length, expected.players.length);
  expected.players.forEach((player, index) => {
    const decoded = actual.players[index] as PlayerState;
    assert.equal(decoded.id, player.id);
    assert.ok(Math.abs(decoded.x - player.x) <= HALF_POSITION_STEP + 1e-9, 'player x drift');
    assert.ok(Math.abs(decoded.z - player.z) <= HALF_POSITION_STEP + 1e-9, 'player z drift');
    assert.equal(decoded.dir, player.dir);
    assert.equal(decoded.hp, player.hp);
    assert.equal(decoded.weapon, player.weapon);
    assert.equal(decoded.flags, player.flags);
  });

  if (expected.zombieMask === null) {
    assert.equal(actual.zombieMask, null);
  } else {
    assert.ok(actual.zombieMask !== null, 'expected a zombie mask');
    assert.deepEqual(Array.from(actual.zombieMask), Array.from(expected.zombieMask));
  }

  assert.equal(actual.zombies.length, expected.zombies.length);
  expected.zombies.forEach((zombie, index) => {
    const decoded = actual.zombies[index] as ZombieState;
    assert.equal(decoded.id, zombie.id);
    assert.ok(Math.abs(decoded.x - zombie.x) <= HALF_POSITION_STEP + 1e-9, 'zombie x drift');
    assert.ok(Math.abs(decoded.z - zombie.z) <= HALF_POSITION_STEP + 1e-9, 'zombie z drift');
    assert.equal(decoded.dir, zombie.dir);
    assert.equal(decoded.state, zombie.state);
  });
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

test('input message round-trips in exactly 17 bytes', () => {
  const msg: InputMsg = {
    seq: 12345,
    tickAck: 678,
    moveX: -1,
    moveZ: 1,
    aimX: 3.5,
    aimZ: -2.25,
    buttons: 1,
    weapon: 2,
  };

  const bytes = encodeInput(msg);
  assert.equal(bytes.byteLength, INPUT_BYTE_LENGTH);
  assert.equal(bytes[0], MsgType.Input);

  const decoded = decodeInput(bytes);
  assert.equal(decoded.seq, 12345);
  assert.equal(decoded.tickAck, 678);
  assert.equal(decoded.moveX, -1);
  assert.equal(decoded.moveZ, 1);
  assert.equal(decoded.buttons, 1);
  assert.equal(decoded.weapon, 2);

  // aim is normalized then quantized: direction preserved, length ≈ 1
  const length = Math.hypot(3.5, -2.25);
  assert.ok(Math.abs(decoded.aimX - 3.5 / length) < 1e-4, 'aimX drift');
  assert.ok(Math.abs(decoded.aimZ - -2.25 / length) < 1e-4, 'aimZ drift');
  assert.ok(Math.abs(Math.hypot(decoded.aimX, decoded.aimZ) - 1) < 1e-4, 'aim not unit length');
});

test('zero aim vector round-trips to zero', () => {
  const decoded = decodeInput(
    encodeInput({ seq: 1, tickAck: 0, moveX: 0, moveZ: 0, aimX: 0, aimZ: 0, buttons: 0, weapon: 0 })
  );
  assert.equal(decoded.aimX, 0);
  assert.equal(decoded.aimZ, 0);
});

test('decode rejects a wrong message type', () => {
  const bytes = encodeInput({
    seq: 1,
    tickAck: 0,
    moveX: 0,
    moveZ: 0,
    aimX: 1,
    aimZ: 0,
    buttons: 0,
    weapon: 0,
  });
  bytes[0] = MsgType.Snapshot;
  assert.throws(() => decodeInput(bytes), /wrong message type/);
});

test('decode rejects a truncated input packet', () => {
  const bytes = encodeInput({
    seq: 1,
    tickAck: 0,
    moveX: 0,
    moveZ: 0,
    aimX: 1,
    aimZ: 0,
    buttons: 0,
    weapon: 0,
  });
  assert.throws(() => decodeInput(bytes.subarray(0, 10)), RangeError);
});

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

test('keyframe snapshot round-trips 3 players and 250 zombies', () => {
  const random = mulberry32(0xc0ffee);
  const players: PlayerState[] = [
    { id: 0, x: 1.25, z: -4.5, dir: 64, hp: 100, weapon: 1, flags: 0 },
    { id: 7, x: -19.75, z: 12.13, dir: 200, hp: 55, weapon: 3, flags: 2 },
    { id: 255, x: 0, z: 0, dir: 0, hp: 0, weapon: 0, flags: 1 },
  ];
  const zombies: ZombieState[] = [];
  for (let id = 0; id < 250; id++) zombies.push(makeZombie(id, random));

  const snapshot: SnapshotMsg = {
    tick: 1200,
    ackSeq: 3456,
    baselineTick: 0,
    players,
    zombieTotal: 250,
    zombieMask: null,
    zombies,
  };

  const bytes = encodeSnapshot(snapshot);
  const expectedSize =
    SNAPSHOT_HEADER_BYTES +
    players.length * PLAYER_ENTRY_BYTES +
    2 +
    zombies.length * ZOMBIE_ENTRY_BYTES;
  assert.equal(expectedSize, 2045); // 16 + 27 + 2 + 2000 → ~8.18 bytes per zombie
  assert.equal(bytes.byteLength, expectedSize);
  assert.equal(bytes[0], MsgType.Snapshot);

  assertSnapshotEqual(decodeSnapshot(bytes), snapshot);
});

test('delta snapshot round-trips only the dirty zombies', () => {
  const random = mulberry32(0xbadc0de);
  const zombieTotal = 250;
  const mask = new Uint8Array(Math.ceil(zombieTotal / 8));
  const dirtyIds = [0, 3, 7, 31, 64, 100, 101, 249];
  for (const id of dirtyIds) mask[id >> 3] |= 1 << (id & 7);

  const snapshot: SnapshotMsg = {
    tick: 903,
    ackSeq: 42,
    baselineTick: 901,
    players: [{ id: 1, x: -2.5, z: 7.75, dir: 128, hp: 80, weapon: 0, flags: 0 }],
    zombieTotal,
    zombieMask: mask,
    zombies: dirtyIds.map((id) => makeZombie(id, random)),
  };

  const bytes = encodeSnapshot(snapshot);
  const expectedSize =
    SNAPSHOT_HEADER_BYTES +
    PLAYER_ENTRY_BYTES +
    mask.length + // 32-byte mask
    2 +
    dirtyIds.length * ZOMBIE_ENTRY_BYTES;
  assert.equal(expectedSize, 123); // 16 + 9 + 32 + 2 + 64
  assert.equal(bytes.byteLength, expectedSize);

  assertSnapshotEqual(decodeSnapshot(bytes), snapshot);
});

test('encode rejects a keyframe with the wrong zombie count', () => {
  assert.throws(
    () =>
      encodeSnapshot({
        tick: 1,
        ackSeq: 0,
        baselineTick: 0,
        players: [],
        zombieTotal: 5,
        zombieMask: null,
        zombies: new Array<ZombieState>(4),
      }),
    /keyframe must carry all 5 zombies/
  );
});

test('encode rejects a delta mask of the wrong length', () => {
  assert.throws(
    () =>
      encodeSnapshot({
        tick: 1,
        ackSeq: 0,
        baselineTick: 10,
        players: [],
        zombieTotal: 10, // needs ceil(10/8) = 2 bytes
        zombieMask: new Uint8Array(3),
        zombies: [],
      }),
    /zombie mask must be 2 bytes/
  );
});

test('encode rejects a delta entry whose mask bit is clear', () => {
  const mask = new Uint8Array(2); // zombieTotal 10 → 10 bits, none set
  assert.throws(
    () =>
      encodeSnapshot({
        tick: 1,
        ackSeq: 0,
        baselineTick: 10,
        players: [],
        zombieTotal: 10,
        zombieMask: mask,
        zombies: [{ id: 4, x: 0, z: 0, dir: 0, state: 0 }],
      }),
    /mask bit is clear/
  );
});

test('encode rejects a player id outside u8 range', () => {
  assert.throws(
    () =>
      encodeSnapshot({
        tick: 1,
        ackSeq: 0,
        baselineTick: 0,
        players: [{ id: 256, x: 0, z: 0, dir: 0, hp: 100, weapon: 0, flags: 0 }],
        zombieTotal: 0,
        zombieMask: null,
        zombies: [],
      }),
    /player id out of u8 range/
  );
});

test('decode rejects a mask whose bit count disagrees with the entries', () => {
  const mask = new Uint8Array(1);
  mask[0] = 0b0000_1100; // two dirty bits declared…
  const snapshot: SnapshotMsg = {
    tick: 5,
    ackSeq: 0,
    baselineTick: 4,
    players: [],
    zombieTotal: 8,
    zombieMask: mask,
    zombies: [{ id: 2, x: 0, z: 0, dir: 0, state: 0 }], // …but only one entry
  };
  const bytes = encodeSnapshot(snapshot); // encoding itself is consistent per-entry
  assert.throws(() => decodeSnapshot(bytes), /mask declares 2 dirty entities/);
});

test('decode rejects a truncated snapshot', () => {
  const bytes = encodeSnapshot({
    tick: 5,
    ackSeq: 0,
    baselineTick: 0,
    players: [],
    zombieTotal: 0,
    zombieMask: null,
    zombies: [],
  });
  assert.equal(bytes.byteLength, SNAPSHOT_HEADER_BYTES + 2); // header + u16 count
  assert.throws(() => decodeSnapshot(bytes.subarray(0, 10)), RangeError);
});

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------

const EVENT_CASES: { tick: number; event: GameEvent; size: number }[] = [
  { tick: 10, event: { kind: EventKind.Shot, shooterId: 1, weapon: 2, x: 12.75, z: -3.5, dir: 200 }, size: 17 },
  { tick: 11, event: { kind: EventKind.Hit, attackerId: 1, targetId: 5, weapon: 2, damage: 25 }, size: 10 },
  { tick: 12, event: { kind: EventKind.Death, victimKind: 1, id: 77 }, size: 9 },
  { tick: 13, event: { kind: EventKind.Spawn, zombieType: 2, id: 99, x: 1.25, z: 2.5, wave: 4 }, size: 19 },
  { tick: 14, event: { kind: EventKind.Wave, wave: 5, count: 30 }, size: 10 },
  { tick: 15, event: { kind: EventKind.Explosion, x: -8.5, z: 16.25, radius: 5, damage: 120 }, size: 16 },
  { tick: 16, event: { kind: EventKind.Combo, playerId: 0, tier: 3, combo: 24 }, size: 10 },
];

test('every event kind round-trips at its documented size', () => {
  for (const { tick, event, size } of EVENT_CASES) {
    const bytes = encodeEvent({ tick, event });
    assert.equal(bytes.byteLength, size, `event kind ${event.kind} size`);
    assert.equal(bytes[0], MsgType.Event);
    const decoded = decodeEvent(bytes);
    assert.equal(decoded.tick, tick);
    assert.deepEqual(decoded.event, event);
  }
});

test('decode rejects an unknown event kind', () => {
  const bytes = encodeEvent({ tick: 1, event: { kind: EventKind.Wave, wave: 1, count: 1 } });
  bytes[5] = 200; // kind byte (after u8 type + u32 tick)
  assert.throws(() => decodeEvent(bytes), /unknown event kind: 200/);
});

test('decode rejects a truncated event', () => {
  const bytes = encodeEvent({ tick: 1, event: { kind: EventKind.Shot, shooterId: 0, weapon: 0, x: 0, z: 0, dir: 0 } });
  assert.throws(() => decodeEvent(bytes.subarray(0, 8)), RangeError);
});
