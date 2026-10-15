import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stepAngleToward, wrapAngle } from '../src/steering.ts';

test('wrapAngle folds any angle into (-π, π]', () => {
  assert.ok(Math.abs(wrapAngle(0)) < 1e-12);
  assert.ok(Math.abs(wrapAngle(Math.PI * 2)) < 1e-12, 'a full turn is zero');
  assert.ok(Math.abs(wrapAngle(-Math.PI * 2)) < 1e-12, 'a full turn back is zero');
  assert.ok(Math.abs(wrapAngle(Math.PI * 3) - Math.PI) < 1e-9);
  assert.ok(Math.abs(wrapAngle(-Math.PI * 3) - Math.PI) < 1e-9);
  assert.ok(Math.abs(wrapAngle(Math.PI) - Math.PI) < 1e-9, '+π is kept');
});

test('stepAngleToward caps the turn and never overshoots', () => {
  // Budget cap: a big gap turns by exactly maxTurn in the right direction.
  assert.ok(Math.abs(stepAngleToward(0, 1.0, 0.25) - 0.25) < 1e-9);
  assert.ok(Math.abs(stepAngleToward(0, -1.0, 0.25) + 0.25) < 1e-9);
  // Within budget: it snaps exactly to the desired angle.
  assert.ok(Math.abs(stepAngleToward(0.2, 0.3, 0.5) - 0.3) < 1e-9);
  assert.ok(Math.abs(stepAngleToward(0, 0, 0.5)) < 1e-12, 'a zero gap stays put');
});

test('stepAngleToward takes the shortest way around the seam', () => {
  // current just under +π, desired just over -π: the short path is forward
  // across the seam (positive delta), not the long way back.
  const current = 3.0;
  const desired = -3.0;
  const stepped = stepAngleToward(current, desired, 0.1);
  assert.ok(stepped > current, `should advance across the seam, got ${stepped}`);
  assert.ok(Math.abs(stepped - 3.1) < 1e-9);

  // Exactly opposite (±π): any direction is a tie — it must still move a full
  // budget without jittering back and forth.
  const half = stepAngleToward(0, Math.PI, 0.5);
  assert.ok(Math.abs(Math.abs(half) - 0.5) < 1e-9);
});

test('stepAngleToward converges onto a target in a bounded number of steps', () => {
  const target = 1.2;
  let angle = -2.5;
  const maxTurn = 0.3;
  let steps = 0;
  while (Math.abs(wrapAngle(target - angle)) > 1e-9 && steps < 1000) {
    angle = stepAngleToward(angle, target, maxTurn);
    steps += 1;
  }
  assert.ok(steps < 100, `converged in ${steps} steps`);
  assert.ok(Math.abs(wrapAngle(target - angle)) < 1e-9, 'lands exactly on the target');
});
