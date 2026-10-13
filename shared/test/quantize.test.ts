import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AIM_SCALE, DIRECTION_STEPS, POSITION_SCALE } from '../src/constants.ts';
import {
  dequantizeAim,
  dequantizeDirection,
  dequantizePosition,
  quantizeAim,
  quantizeDirection,
  quantizePosition,
} from '../src/quantize.ts';
import { packZombieState, unpackZombieState } from '../src/protocol/messages.ts';

const HALF_POSITION_STEP = 0.5 / POSITION_SCALE;
const HALF_AIM_STEP = 0.5 / AIM_SCALE;

test('position quantization round-trips within half a step', () => {
  for (let value = -300; value <= 300; value += 0.137) {
    const quantized = quantizePosition(value);
    assert.ok(Number.isInteger(quantized), `not an integer for ${value}`);
    assert.ok(
      Math.abs(dequantizePosition(quantized) - value) <= HALF_POSITION_STEP + 1e-12,
      `round-trip drift for ${value}`
    );
  }
});

test('position quantization clamps to the i16 range', () => {
  assert.equal(quantizePosition(1e9), 32767);
  assert.equal(quantizePosition(-1e9), -32768);
  assert.equal(quantizePosition(327.67), 32767);
});

test('aim quantization round-trips within half a step', () => {
  for (const value of [-1, -0.7071, -0.5, 0, 0.25, 0.7071, 1]) {
    const quantized = quantizeAim(value);
    assert.ok(Number.isInteger(quantized));
    assert.ok(quantized >= -AIM_SCALE && quantized <= AIM_SCALE);
    assert.ok(Math.abs(dequantizeAim(quantized) - value) <= HALF_AIM_STEP + 1e-12);
  }
});

function angleDifference(a: number, b: number): number {
  let difference = a - b;
  while (difference > Math.PI) difference -= Math.PI * 2;
  while (difference < -Math.PI) difference += Math.PI * 2;
  return Math.abs(difference);
}

test('direction quantization stays within half a step', () => {
  const step = (Math.PI * 2) / DIRECTION_STEPS;
  for (let degrees = -180; degrees < 180; degrees += 7) {
    const angle = (degrees * Math.PI) / 180;
    const quantized = quantizeDirection(Math.cos(angle), Math.sin(angle));
    assert.ok(quantized >= 0 && quantized <= 255, `out of u8 range for ${degrees}°`);
    const restored = dequantizeDirection(quantized);
    assert.ok(
      angleDifference(restored, angle) <= step / 2 + 1e-9,
      `heading drift for ${degrees}°`
    );
  }
});

test('zero direction vector quantizes to 0', () => {
  assert.equal(quantizeDirection(0, 0), 0);
});

test('zombie state byte round-trips all field combinations', () => {
  for (let anim = 0; anim < 8; anim++) {
    for (let flags = 0; flags < 4; flags++) {
      for (let hpTier = 0; hpTier < 8; hpTier++) {
        const packed = packZombieState(anim, flags, hpTier);
        assert.ok(Number.isInteger(packed) && packed >= 0 && packed <= 255);
        assert.deepEqual(unpackZombieState(packed), { anim, flags, hpTier });
      }
    }
  }
});
