import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_MAP_ID, MAP_DEFINITIONS, getMap } from '../src/maps.ts';

/** Converts a world-unit spawn `{ x, y }` to its integer grid cell. */
function cell(x: number, y: number): { cx: number; cz: number } {
  return { cx: Math.floor(x), cz: Math.floor(y) };
}

test('the registry exposes exactly four distinct arenas', () => {
  assert.equal(MAP_DEFINITIONS.length, 4);
  const ids = new Set(MAP_DEFINITIONS.map((m) => m.id));
  assert.equal(ids.size, 4, 'map ids must be unique');
  assert.ok(ids.has(DEFAULT_MAP_ID), 'the default id must exist in the registry');
});

test('every arena declares four cardinal perimeter spawn gates', () => {
  for (const map of MAP_DEFINITIONS) {
    assert.equal(map.spawnGates.length, 4, `${map.id} needs four gates`);
    const sides = new Set(map.spawnGates.map((g) => g.id));
    for (const side of ['north', 'south', 'east', 'west'] as const) {
      assert.ok(sides.has(side), `${map.id} is missing the ${side} gate`);
    }
    for (const gate of map.spawnGates) {
      const { cx, cz } = cell(gate.x, gate.y);
      assert.ok(
        cx > 0 && cz > 0 && cx < map.width - 1 && cz < map.height - 1,
        `${map.id} ${gate.id} gate (${gate.x},${gate.y}) must be inside the border`
      );
      assert.equal(map.grid[cz][cx], 0, `${map.id} ${gate.id} gate must emerge on floor`);
      assert.equal(Math.abs(gate.nx) + Math.abs(gate.nz), 1, `${gate.id} normal must be axial`);
    }
  }
});

test('every arena is a well-formed grid', () => {
  for (const map of MAP_DEFINITIONS) {
    assert.ok(map.name.length > 0, `${map.id} needs a name`);
    assert.ok(map.description.length > 0, `${map.id} needs a description`);
    assert.ok(map.width > 2 && map.height > 2, `${map.id} is too small`);
    assert.equal(map.grid.length, map.height, `${map.id} row count must equal height`);
    for (const row of map.grid) {
      assert.equal(row.length, map.width, `${map.id} column count must equal width`);
      for (const value of row) {
        assert.ok(value === 0 || value === 1, `${map.id} tiles must be 0 or 1`);
      }
    }
  }
});

test('every arena is sealed by a solid border', () => {
  for (const map of MAP_DEFINITIONS) {
    for (let x = 0; x < map.width; x++) {
      assert.equal(map.grid[0][x], 1, `${map.id} top border must be solid`);
      assert.equal(map.grid[map.height - 1][x], 1, `${map.id} bottom border must be solid`);
    }
    for (let z = 0; z < map.height; z++) {
      assert.equal(map.grid[z][0], 1, `${map.id} left border must be solid`);
      assert.equal(map.grid[z][map.width - 1], 1, `${map.id} right border must be solid`);
    }
  }
});

test('every spawn point sits on a walkable interior cell', () => {
  for (const map of MAP_DEFINITIONS) {
    assert.ok(map.playerSpawns.length >= 2, `${map.id} needs two player spawns`);
    assert.ok(map.zombieSpawns.length >= 4, `${map.id} needs several mob spawns`);
    for (const [label, spawns] of [
      ['player', map.playerSpawns],
      ['zombie', map.zombieSpawns],
    ] as const) {
      for (const spawn of spawns) {
        const { cx, cz } = cell(spawn.x, spawn.y);
        assert.ok(
          cx > 0 && cz > 0 && cx < map.width - 1 && cz < map.height - 1,
          `${map.id} ${label} spawn (${spawn.x},${spawn.y}) must be inside the border`
        );
        assert.equal(
          map.grid[cz][cx],
          0,
          `${map.id} ${label} spawn (${spawn.x},${spawn.y}) must be walkable`
        );
      }
    }
  }
});

test('getMap resolves known ids and falls back to the first arena', () => {
  for (const map of MAP_DEFINITIONS) {
    assert.equal(getMap(map.id).id, map.id);
  }
  assert.equal(getMap('does-not-exist').id, MAP_DEFINITIONS[0].id);
});
