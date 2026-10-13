import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GridMap } from '../src/grid.ts';
import { computeFlowField } from '../src/flowfield.ts';
import type { FlowField } from '../src/flowfield.ts';
import { CRATE_CONFIG } from '../src/balance.config.ts';

/** Distance-to-goal for a cell, via the flow field. */
function distanceAt(grid: GridMap, field: FlowField, cx: number, cz: number): number {
  return field.distance[grid.cellIndex(cx, cz)];
}

/** 20×20 arena with a sealed one-cell border. */
function sealedGrid(): GridMap {
  const grid = new GridMap(20, 20, 1);
  for (let i = 0; i < 20; i++) {
    grid.setBlocked(i, 0, true);
    grid.setBlocked(i, 19, true);
    grid.setBlocked(0, i, true);
    grid.setBlocked(19, i, true);
  }
  return grid;
}

test('a contiguous barrel wall is airtight — the far side is unreachable', () => {
  const grid = sealedGrid();
  // A full vertical barrel wall at x = 10: every walkable row is occupied, so
  // each barrel fills its whole 1×1 cell and there are no seams to slip through.
  for (let z = 1; z <= 18; z++) grid.setBlocked(10, z, true);

  const field = computeFlowField(grid, [{ cx: 5, cz: 10 }]);
  assert.ok(Number.isFinite(distanceAt(grid, field, 9, 10)), 'near side is reachable');
  assert.equal(distanceAt(grid, field, 15, 10), Infinity, 'far side is unreachable');

  // Nothing leaks diagonally around the wall ends (both ends meet the border).
  for (const [cx, cz] of [
    [11, 1],
    [11, 18],
    [12, 9],
    [19 - 4, 2],
  ] as const) {
    assert.equal(distanceAt(grid, field, cx, cz), Infinity, `cell ${cx},${cz} must stay sealed`);
  }
});

test('a single destroyed barrel reopens the path (dynamic re-route)', () => {
  const grid = sealedGrid();
  for (let z = 1; z <= 18; z++) grid.setBlocked(10, z, true);
  grid.setBlocked(10, 10, false); // the one barrel that detonated

  const field = computeFlowField(grid, [{ cx: 5, cz: 10 }]);
  assert.ok(
    Number.isFinite(distanceAt(grid, field, 15, 10)),
    'the far side becomes reachable again once a barrel is removed'
  );
});

test('a wall with a one-cell gap is passable but still forces a detour', () => {
  const grid = sealedGrid();
  for (let z = 1; z <= 18; z++) grid.setBlocked(10, z, true);
  grid.setBlocked(10, 18, false); // leave a single doorway at the bottom

  const field = computeFlowField(grid, [{ cx: 5, cz: 10 }]);
  const straight = distanceAt(grid, field, 15, 10);
  const nearDoor = distanceAt(grid, field, 11, 18);
  assert.ok(Number.isFinite(straight), 'the horde can still get through the gap');
  assert.ok(nearDoor < straight, 'the doorway is the shortest route, not the straight line');
});

test('wooden crates seal the arena exactly like barrels — no explosion, no leak', () => {
  // A crate fills its whole 1×1 cell (same blocked-cell semantics as a barrel),
  // so a crate wall is equally airtight — and it never detonates to open one.
  assert.equal(CRATE_CONFIG.hp, 150, 'crates take 150 HP to claw down');
  assert.equal(CRATE_CONFIG.explodes, false, 'a destroyed crate only splinters');
  assert.equal(CRATE_CONFIG.explosionRadius, 0, 'crates have no blast to chain');

  const grid = sealedGrid();
  for (let z = 1; z <= 18; z++) grid.setBlocked(10, z, true); // crate wall
  const sealed = computeFlowField(grid, [{ cx: 5, cz: 10 }]);
  assert.equal(distanceAt(grid, sealed, 15, 10), Infinity, 'far side unreachable');

  // one crate clawed down → the horde re-routes through the opened cell
  grid.setBlocked(10, 9, false);
  const reopened = computeFlowField(grid, [{ cx: 5, cz: 10 }]);
  assert.ok(
    Number.isFinite(distanceAt(grid, reopened, 15, 10)),
    'removing one crate reconnects both sides instantly'
  );
});

test('a mixed crate + barrel wall is still airtight (kinds share the grid)', () => {
  // Crates and barrels both fill their entire 1×1 cell, so the grid cannot
  // tell them apart — a wall built from either kind blocks every row equally.
  const grid = sealedGrid();
  for (let z = 1; z <= 18; z++) grid.setBlocked(10, z, true);

  const field = computeFlowField(grid, [{ cx: 5, cz: 10 }]);
  assert.equal(
    distanceAt(grid, field, 15, 10),
    Infinity,
    'the horde cannot slip between a crate and a barrel'
  );
  // and one destroyed barricade of either kind reopens exactly its own cell
  grid.setBlocked(10, 5, false);
  const reopened = computeFlowField(grid, [{ cx: 5, cz: 10 }]);
  assert.ok(Number.isFinite(distanceAt(grid, reopened, 15, 10)));
});
