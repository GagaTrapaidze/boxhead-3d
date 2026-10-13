import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GridMap } from '../src/grid.ts';
import { computeFlowField, sampleFlow } from '../src/flowfield.ts';

function distanceAt(grid: GridMap, field: { distance: Float32Array }, cx: number, cz: number): number {
  return field.distance[grid.cellIndex(cx, cz)];
}

test('throws on missing, out-of-bounds or blocked goals', () => {
  const grid = new GridMap(3, 3, 1);
  assert.throws(() => computeFlowField(grid, []), /at least one goal/);
  assert.throws(() => computeFlowField(grid, [{ cx: 3, cz: 0 }]), /out of bounds/);
  grid.setBlocked(0, 0, true);
  assert.throws(() => computeFlowField(grid, [{ cx: 0, cz: 0 }]), /blocked/);
});

test('distances match orthogonal and diagonal path lengths', () => {
  const grid = new GridMap(5, 5, 1);
  const field = computeFlowField(grid, [{ cx: 0, cz: 0 }]);

  assert.equal(distanceAt(grid, field, 0, 0), 0);
  assert.ok(Math.abs(distanceAt(grid, field, 4, 0) - 4) < 1e-4, 'orthogonal distance');
  assert.ok(
    Math.abs(distanceAt(grid, field, 4, 4) - 4 * Math.SQRT2) < 1e-4,
    'diagonal distance'
  );
  assert.ok(
    Math.abs(distanceAt(grid, field, 1, 1) - Math.SQRT2) < 1e-4,
    'one diagonal step from the goal'
  );
});

test('goal cells and unreachable cells have zero steering direction', () => {
  const grid = new GridMap(5, 5, 1);
  const field = computeFlowField(grid, [{ cx: 0, cz: 0 }]);

  const goal = sampleFlow(grid, field, 0.5, 0.5);
  assert.equal(goal.distance, 0);
  assert.equal(goal.x, 0);
  assert.equal(goal.z, 0);
});

test('sampling returns the direction toward the nearest lower-distance cell', () => {
  const grid = new GridMap(5, 5, 1);
  const field = computeFlowField(grid, [{ cx: 0, cz: 0 }]);

  const sample = sampleFlow(grid, field, 3.5, 0.5); // cell (3,0)
  assert.ok(Math.abs(sample.x - -1) < 1e-6, `dirX = ${sample.x}`);
  assert.ok(Math.abs(sample.z - 0) < 1e-6, `dirZ = ${sample.z}`);
  assert.ok(Math.abs(sample.distance - 3) < 1e-4, `distance = ${sample.distance}`);
});

test('a fully blocked column makes the far side unreachable', () => {
  const grid = new GridMap(3, 3, 1);
  grid.setBlocked(1, 0, true);
  grid.setBlocked(1, 1, true);
  grid.setBlocked(1, 2, true);
  const field = computeFlowField(grid, [{ cx: 0, cz: 0 }]);

  assert.equal(distanceAt(grid, field, 2, 0), Infinity);
  const sample = sampleFlow(grid, field, 2.5, 0.5);
  assert.equal(sample.distance, Infinity);
  assert.equal(sample.x, 0);
  assert.equal(sample.z, 0);

  // blocked cells themselves stay at Infinity with no direction
  const onWall = sampleFlow(grid, field, 1.5, 0.5);
  assert.equal(onWall.distance, Infinity);
  assert.equal(onWall.x, 0);
  assert.equal(onWall.z, 0);
});

test('diagonal steps never cut corners past a blocked cell', () => {
  const grid = new GridMap(3, 3, 1);
  grid.setBlocked(1, 0, true);
  const field = computeFlowField(grid, [{ cx: 0, cz: 0 }]);

  // (1,1) may not take the diagonal to the goal — that corner is cut by (1,0)
  assert.ok(Math.abs(distanceAt(grid, field, 1, 1) - 2) < 1e-4, 'must go around, not diagonal');
  // (2,0) must wrap around through (2,1) → (1,1) → (0,1) → goal = 4
  assert.ok(Math.abs(distanceAt(grid, field, 2, 0) - 4) < 1e-4, 'path around the wall');
});

test('multiple goals merge into one field', () => {
  const grid = new GridMap(5, 5, 1);
  const field = computeFlowField(grid, [
    { cx: 0, cz: 0 },
    { cx: 4, cz: 4 },
  ]);
  assert.equal(distanceAt(grid, field, 0, 0), 0);
  assert.equal(distanceAt(grid, field, 4, 4), 0);
  assert.ok(
    Math.abs(distanceAt(grid, field, 2, 2) - 2 * Math.SQRT2) < 1e-4,
    'middle is 2 diagonals from either goal'
  );
});
