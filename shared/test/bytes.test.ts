import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ByteReader, ByteWriter } from '../src/binary/bytes.ts';

test('round-trips mixed primitives', () => {
  const writer = new ByteWriter();
  writer.u8(200).i8(-100).u16(65535).i16(-32768).u32(4294967295).f32(1.5);

  const bytes = writer.toBytes();
  assert.equal(bytes.byteLength, 1 + 1 + 2 + 2 + 4 + 4);
  assert.equal(writer.length, 14);

  const reader = new ByteReader(bytes);
  assert.equal(reader.u8(), 200);
  assert.equal(reader.i8(), -100);
  assert.equal(reader.u16(), 65535);
  assert.equal(reader.i16(), -32768);
  assert.equal(reader.u32(), 4294967295);
  assert.equal(reader.f32(), 1.5);
  assert.equal(reader.remaining, 0);
});

test('writer grows beyond its initial capacity', () => {
  const writer = new ByteWriter(8);
  const count = 10_000;
  for (let i = 0; i < count; i++) writer.u32(i * 7);

  assert.equal(writer.length, count * 4);

  const reader = new ByteReader(writer.toBytes());
  for (let i = 0; i < count; i++) assert.equal(reader.u32(), i * 7);
  assert.equal(reader.remaining, 0);
});

test('writer with zero initial capacity still works', () => {
  const writer = new ByteWriter(0);
  writer.u8(1).u8(2).u8(3);
  const reader = new ByteReader(writer.toBytes());
  assert.equal(reader.u8(), 1);
  assert.equal(reader.u8(), 2);
  assert.equal(reader.u8(), 3);
});

test('reader throws RangeError on underflow', () => {
  const reader = new ByteReader(new Uint8Array([1]));
  assert.throws(() => reader.u16(), RangeError);
  assert.throws(() => new ByteReader(new Uint8Array([])).u8(), RangeError);
});

test('bytes() round-trips', () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const writer = new ByteWriter();
  writer.u8(9).bytes(payload).u8(7);

  const reader = new ByteReader(writer.toBytes());
  assert.equal(reader.u8(), 9);
  assert.deepEqual(Array.from(reader.bytes(5)), [1, 2, 3, 4, 5]);
  assert.equal(reader.u8(), 7);
  assert.equal(reader.remaining, 0);
});

test('reader honors a Uint8Array subview offset', () => {
  const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
  const view = backing.subarray(2, 5); // [1, 2, 3]
  const reader = new ByteReader(view);
  assert.equal(reader.u8(), 1);
  assert.equal(reader.u8(), 2);
  assert.equal(reader.u8(), 3);
  assert.equal(reader.remaining, 0);
});
