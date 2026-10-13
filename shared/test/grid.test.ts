import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GridMap } from '../src/grid.ts';

test('constructor validates dimensions', () => {
  assert.throws(() => new GridMap(0, 10, 1), /invalid grid dimensions/);
  assert.throws(() => new GridMap(10, -1, 1), /invalid grid dimensions/);
  assert.throws(() => new GridMap(10, 10, 0), /invalid cell size/);
});

test('cell math round-trips and out-of-bounds is blocked', () => {
  const grid = new GridMap(10, 10, 1);
  assert.equal(grid.cellX(0.5), 0);
  assert.equal(grid.cellX(5.999), 5);
  assert.equal(grid.cellX(-0.1), -1);
  assert.equal(grid.cellZ(9.999), 9);

  const center = grid.centerOf(0, 0);
  assert.equal(center.x, 0.5);
  assert.equal(center.z, 0.5);

  assert.equal(grid.isBlockedCell(-1, 0), true);
  assert.equal(grid.isBlockedCell(10, 0), true);
  assert.equal(grid.isBlockedWorld(99, 99), true);
  assert.equal(grid.isBlockedCell(0, 0), false);

  grid.setBlocked(3, 4, true);
  assert.equal(grid.isBlockedCell(3, 4), true);
  assert.equal(grid.isBlockedWorld(3.5, 4.5), true);
  assert.throws(() => grid.setBlocked(10, 0, true), /out of bounds/);
});

test('resolveCircle leaves free space untouched', () => {
  const grid = new GridMap(10, 10, 1);
  const result = grid.resolveCircle(4.4, 4.4, 0.4);
  assert.equal(result.x, 4.4);
  assert.equal(result.z, 4.4);
});

test('resolveCircle pushes a circle out of an overlapping wall', () => {
  const grid = new GridMap(10, 10, 1);
  grid.setBlocked(5, 5, true);

  // center below the cell, overlapping its bottom edge by 0.2
  const result = grid.resolveCircle(5.5, 4.7, 0.5);
  assert.ok(Math.abs(result.x - 5.5) < 1e-9, `x drifted to ${result.x}`);
  assert.ok(Math.abs(result.z - 4.5) < 1e-9, `z pushed to ${result.z}`);
  // no overlap remains: circle bottom edge sits exactly radius away
  assert.ok(result.z + 0.5 <= 5 + 1e-9);
});

test('resolveCircle escapes when the center is inside a wall cell', () => {
  const grid = new GridMap(10, 10, 1);
  grid.setBlocked(5, 5, true);

  const result = grid.resolveCircle(5.5, 5.4, 0.5);
  // nearest edge of cell [5,6)×[5,6) is the top (z = 5)
  assert.ok(Math.abs(result.z - 4.5) < 1e-9, `z pushed to ${result.z}`);
  assert.ok(Math.abs(result.x - 5.5) < 1e-9, `x drifted to ${result.x}`);
});

test('resolveCircle clears a multi-cell wall instead of wedging inside it', () => {
  const grid = new GridMap(10, 10, 1);
  for (const [cx, cz] of [[4, 4], [5, 4], [4, 5], [5, 5]]) grid.setBlocked(cx, cz, true);

  // centre exactly on the shared corner of four blocked cells
  const corner = grid.resolveCircle(5, 5, 0.4);
  const clear =
    corner.x <= 4 - 0.4 + 1e-9 || corner.x >= 6 + 0.4 - 1e-9 ||
    corner.z <= 4 - 0.4 + 1e-9 || corner.z >= 6 + 0.4 - 1e-9;
  assert.ok(clear, `circle wedged inside the wall at ${corner.x},${corner.z}`);

  // a step straight into the block must be pushed back out, never through it
  const stepIn = grid.resolveCircle(4.55, 5, 0.4);
  assert.ok(stepIn.x <= 4 - 0.4 + 1e-9, `move penetrated to x=${stepIn.x}`);
});

test('resolveCircle treats out-of-bounds as solid', () => {
  const grid = new GridMap(5, 5, 1);
  const result = grid.resolveCircle(0.2, 2.5, 0.5);
  assert.ok(Math.abs(result.x - 0.5) < 1e-9, `x pushed to ${result.x}`);
  assert.ok(Math.abs(result.z - 2.5) < 1e-9, `z drifted to ${result.z}`);
});

test('line of sight across open ground is clear', () => {
  const grid = new GridMap(10, 10, 1);
  assert.equal(grid.lineOfSight(0.5, 0.5, 9.4, 9.4), true);
  assert.equal(grid.lineOfSight(2.5, 2.5, 2.5, 2.5), true);
});

test('line of sight is blocked by a full wall row', () => {
  const grid = new GridMap(10, 10, 1);
  for (let cx = 0; cx < 10; cx++) grid.setBlocked(cx, 5, true);

  assert.equal(grid.lineOfSight(0.5, 2.5, 0.5, 8.5), false, 'crosses the wall');
  assert.equal(grid.lineOfSight(0.5, 2.5, 4.5, 4.5), true, 'stops before the wall');
  assert.equal(grid.lineOfSight(0.5, 4.5, 9.5, 4.5), true, 'parallel to the wall');
});

test('line of sight is blocked by a single wall cell', () => {
  const grid = new GridMap(10, 10, 1);
  grid.setBlocked(5, 0, true);
  assert.equal(grid.lineOfSight(4.5, 0.5, 6.5, 0.5), false);
  assert.equal(grid.lineOfSight(4.5, 1.5, 6.5, 1.5), true);
});

test('line of sight fails when an endpoint is blocked or out of bounds', () => {
  const grid = new GridMap(10, 10, 1);
  assert.equal(grid.lineOfSight(0.5, 0.5, -2, 0.5), false, 'end outside the grid');
  grid.setBlocked(0, 0, true);
  assert.equal(grid.lineOfSight(0.5, 0.5, 9, 9), false, 'start inside a wall');
});

test('raycastDistance stops a bullet at the first wall it meets', () => {
  const grid = new GridMap(10, 10, 1);
  // open ground all the way to the out-of-bounds east face
  assert.equal(grid.raycastDistance(0.5, 5.5, 1, 0, 100), 9.5);

  // a wall at cell (5, 5) stops the ray on its near face (x = 5)
  grid.setBlocked(5, 5, true);
  assert.equal(grid.raycastDistance(0.5, 5.5, 1, 0, 100), 4.5);

  // ...but a wall one row over does not
  assert.equal(grid.raycastDistance(0.5, 6.5, 1, 0, 100), 9.5);

  // shorter reach than the wall distance: the bullet dies at max distance
  assert.equal(grid.raycastDistance(0.5, 5.5, 1, 0, 2), 2);

  // the same ray fired diagonally (unnormalized input) crosses the wall at (5,5)
  // after travelling 4.5 cells' worth of the diagonal
  assert.ok(
    Math.abs(grid.raycastDistance(0.5, 0.5, 1, 1, 100) - 4.5 * Math.SQRT2) < 1e-9
  );

  // on an open grid the diagonal reaches the far corner
  const openGrid = new GridMap(10, 10, 1);
  const diagonal = openGrid.raycastDistance(0.5, 0.5, 3, 3, 100); // unnormalized (3,3)
  assert.ok(Math.abs(diagonal - Math.SQRT2 * 9.5) < 1e-9, `diagonal = ${diagonal}`);

  // a ray starting inside a wall has zero travel
  openGrid.setBlocked(0, 0, true);
  assert.equal(openGrid.raycastDistance(0.5, 0.5, 1, 0, 100), 0);
});
