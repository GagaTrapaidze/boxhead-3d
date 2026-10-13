import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INTERP_DELAY_MS,
  INTERP_DELAY_TICKS,
  LAG_COMPENSATION_MS,
  LAG_COMPENSATION_TICKS,
  MAX_PLAYERS,
  MAX_ZOMBIES,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  SNAPSHOT_RATE,
  TICK_MS,
  TICK_RATE,
  isSnapshotTick,
} from '../src/constants.ts';

test('tick rates match the architecture (30 Hz sim / 20 Hz snapshots)', () => {
  assert.equal(TICK_RATE, 30);
  assert.equal(SNAPSHOT_RATE, 20);
  assert.ok(Math.abs(TICK_MS - 1000 / 30) < 1e-9);
});

test('isSnapshotTick fires exactly SNAPSHOT_RATE times per second', () => {
  let count = 0;
  for (let tick = 0; tick < TICK_RATE; tick++) {
    if (isSnapshotTick(tick)) count++;
  }
  assert.equal(count, SNAPSHOT_RATE);
  assert.ok(isSnapshotTick(0), 'tick 0 is always a snapshot');
});

test('snapshot spacing alternates 2, 1 ticks (1.5-tick interval)', () => {
  const gaps = new Set<number>();
  let previous = 0; // tick 0 is a snapshot
  for (let tick = 1; tick < TICK_RATE; tick++) {
    if (isSnapshotTick(tick)) {
      gaps.add(tick - previous);
      previous = tick;
    }
  }
  assert.deepEqual([...gaps].sort((a, b) => a - b), [1, 2]);
});

test('interpolation delay is 100 ms behind the server', () => {
  assert.ok(LAG_COMPENSATION_TICKS >= 1);
  assert.ok(Math.abs(INTERP_DELAY_MS - 100) < 1e-9);
  assert.equal(INTERP_DELAY_MS, INTERP_DELAY_TICKS * TICK_MS);
});

test('lag compensation window covers 250 ms with whole ticks', () => {
  assert.equal(LAG_COMPENSATION_MS, 250);
  assert.equal(LAG_COMPENSATION_TICKS, 8);
  assert.ok((LAG_COMPENSATION_TICKS - 1) * TICK_MS < LAG_COMPENSATION_MS);
  assert.ok(LAG_COMPENSATION_TICKS * TICK_MS >= LAG_COMPENSATION_MS);
});

test('room settings are sane', () => {
  assert.equal(MAX_PLAYERS, 4);
  assert.equal(MAX_ZOMBIES, 512);
  assert.equal(ROOM_CODE_LENGTH, 6);
  assert.equal(ROOM_CODE_ALPHABET.length, 31); // 23 letters (no I/L/O) + 8 digits (no 0/1)
  // no visually ambiguous characters
  for (const ambiguous of ['0', 'O', '1', 'I', 'L']) {
    assert.ok(!ROOM_CODE_ALPHABET.includes(ambiguous), `alphabet contains ${ambiguous}`);
  }
  assert.equal(new Set(ROOM_CODE_ALPHABET).size, ROOM_CODE_ALPHABET.length, 'alphabet has duplicates');
});
