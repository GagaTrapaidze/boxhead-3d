/**
 * ────────────────────────────────────────────────────────────────────────────
 *  MAP REGISTRY — the four tactical arenas, defined as plain data.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Every arena is a `MapDefinition`: a W×H tile grid plus spawn points. The
 * client (`game/world.ts`) turns the grid into both the collision `GridMap` and
 * the extruded 3D geometry, so the visuals and the physics can never disagree.
 *
 * Coordinate convention
 *  - `grid[z][x]` is one row per z (depth) and one column per x — the same
 *    (x → right, z → down-screen) convention as `grid.ts` and `world.ts`.
 *  - `0` = walkable floor, `1` = solid wall / obstacle.
 *  - Spawn entries are **world-unit** positions using `{ x, y }`, where `y` is
 *    the ground-plane depth axis (i.e. it maps to the engine's `z`). Cell
 *    centres are therefore `(cx + 0.5, cz + 0.5)`.
 *
 * All four maps are 40×40 so the fixed camera framing and flow field stay the
 * same size across layouts.
 *
 * ── Perimeter spawn gates ───────────────────────────────────────────────────
 * Zombies no longer materialise out of thin air along random edges. Each arena
 * declares four `SpawnGate`s at the cardinal wall midpoints (north/south/east/
 * west); the horde emerges from these alcoves and walks inward. The gate cell
 * itself stays walkable (the solid border is never carved out), so the sealed
 * border invariant in `test/maps.test.ts` still holds.
 */

export interface SpawnGate {
  /** Cardinal side of the perimeter this gate sits on. */
  id: 'north' | 'south' | 'east' | 'west';
  /** World-unit position of the floor cell mobs emerge onto (`y` = z). */
  x: number;
  y: number;
  /** Outward unit normal, pointing at the perimeter wall. */
  nx: number;
  nz: number;
}

export interface MapDefinition {
  /** Stable slug used in the URL/menu (`classic-bunker`, …). */
  id: string;
  /** Human-readable arena name shown on the map-select card. */
  name: string;
  /** One-line gameplay pitch shown under the name. */
  description: string;
  /** Grid width in cells (also the world-unit width at cellSize 1). */
  width: number;
  /** Grid height in cells (also the world-unit depth). */
  height: number;
  /** Row-major tile grid: `grid[z][x]`, 0 = walkable, 1 = solid. */
  grid: number[][];
  /** Where players start, in world units `{ x, y: z }`. */
  playerSpawns: { x: number; y: number }[];
  /** Preferred horde spawn points, in world units `{ x, y: z }`. */
  zombieSpawns: { x: number; y: number }[];
  /** Thematic perimeter gates the horde emerges from (north/south/east/west). */
  spawnGates: SpawnGate[];
}

/** Every arena is a fixed 40×40 board. */
export const MAP_WIDTH = 40;
export const MAP_HEIGHT = 40;

// ─────────────────────────────────────────────────────────────────────────────
// Grid construction helpers (kept private — callers only see MapDefinition)
// ─────────────────────────────────────────────────────────────────────────────

/** Empty (all walkable) grid of the given size. */
function emptyGrid(width: number, height: number): number[][] {
  return Array.from({ length: height }, () => new Array<number>(width).fill(0));
}

/** Fills one solid rectangle of cells, clipped to the grid. */
function wall(grid: number[][], x: number, z: number, w: number, h: number): void {
  const height = grid.length;
  const width = grid[0].length;
  for (let cz = Math.max(0, z); cz < Math.min(height, z + h); cz++) {
    for (let cx = Math.max(0, x); cx < Math.min(width, x + w); cx++) {
      grid[cz][cx] = 1;
    }
  }
}

/** Draws a solid one-cell frame around the playfield. */
function border(grid: number[][], width: number, height: number): void {
  for (let x = 0; x < width; x++) {
    grid[0][x] = 1;
    grid[height - 1][x] = 1;
  }
  for (let z = 0; z < height; z++) {
    grid[z][0] = 1;
    grid[z][width - 1] = 1;
  }
}

/** World-unit spawn helper: converts a cell centre into a `{ x, y: z }` point. */
function spawn(cx: number, cz: number): { x: number; y: number } {
  return { x: cx + 0.5, y: cz + 0.5 };
}

/**
 * Builds one cardinal gate: the interior cell closest to the wall midpoint that
 * is actually walkable. Scanning outward from the midpoint keeps each gate on
 * its intended side even when a map's own geometry blocks the exact centre
 * (e.g. the Choke Point's central divider).
 */
function midGate(
  grid: number[][],
  width: number,
  height: number,
  id: SpawnGate['id']
): SpawnGate {
  const midX = Math.floor(width / 2);
  const midZ = Math.floor(height / 2);
  const maxOffset = Math.floor(Math.max(width, height) / 2) - 1;

  for (let offset = 0; offset <= maxOffset; offset++) {
    const offsets = offset === 0 ? [0] : [offset, -offset];
    for (const o of offsets) {
      let cx: number;
      let cz: number;
      let nx: number;
      let nz: number;
      if (id === 'north') {
        cx = midX + o;
        cz = 1;
        nx = 0;
        nz = -1;
      } else if (id === 'south') {
        cx = midX + o;
        cz = height - 2;
        nx = 0;
        nz = 1;
      } else if (id === 'west') {
        cx = 1;
        cz = midZ + o;
        nx = -1;
        nz = 0;
      } else {
        cx = width - 2;
        cz = midZ + o;
        nx = 1;
        nz = 0;
      }
      if (cx < 1 || cx > width - 2 || cz < 1 || cz > height - 2) continue;
      if (grid[cz][cx] !== 0) continue;
      return { id, x: cx + 0.5, y: cz + 0.5, nx, nz };
    }
  }
  throw new Error(`no walkable gate cell for the ${id} perimeter`);
}

/** The four cardinal gates for an arena, discovered from its tile grid. */
function cardinalGates(grid: number[][], width: number, height: number): SpawnGate[] {
  return [
    midGate(grid, width, height, 'north'),
    midGate(grid, width, height, 'east'),
    midGate(grid, width, height, 'south'),
    midGate(grid, width, height, 'west'),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// MAP 1 — The Classic Bunker: open arena, four symmetric cover pillars.
// ─────────────────────────────────────────────────────────────────────────────
function buildClassicBunker(): MapDefinition {
  const grid = emptyGrid(MAP_WIDTH, MAP_HEIGHT);
  border(grid, MAP_WIDTH, MAP_HEIGHT);

  // Four symmetric 5×5 barrier pillars framing a wide central arena.
  wall(grid, 8, 8, 5, 5);
  wall(grid, 27, 8, 5, 5);
  wall(grid, 8, 27, 5, 5);
  wall(grid, 27, 27, 5, 5);

  const gates = cardinalGates(grid, MAP_WIDTH, MAP_HEIGHT);

  return {
    id: 'classic-bunker',
    name: 'The Classic Bunker',
    description:
      'Wide central arena with four symmetric cover pillars. Open sight lines — shotgun point-blanks and barrel kiting shine here.',
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    grid,
    playerSpawns: [spawn(17, 20), spawn(22, 20)],
    zombieSpawns: gates.map((gate) => ({ x: gate.x, y: gate.y })),
    spawnGates: gates,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAP 2 — The Choke Point: two chambers joined by a narrow central corridor.
// ─────────────────────────────────────────────────────────────────────────────
function buildChokePoint(): MapDefinition {
  const grid = emptyGrid(MAP_WIDTH, MAP_HEIGHT);
  border(grid, MAP_WIDTH, MAP_HEIGHT);

  // Central divider (2 cells thick) with a 4-cell doorway at z = 18..21.
  wall(grid, 19, 1, 2, 17); // z 1..17
  wall(grid, 19, 22, 2, 17); // z 22..38

  // Cheek walls that funnel attackers through the bottleneck.
  wall(grid, 15, 18, 4, 1); // top-left lip of the doorway
  wall(grid, 21, 21, 4, 1); // bottom-right lip of the doorway

  // Cover clumps in each wing (west = entry side, east = horde side).
  wall(grid, 5, 6, 5, 3);
  wall(grid, 5, 31, 5, 3);
  wall(grid, 30, 6, 5, 3);
  wall(grid, 30, 31, 5, 3);

  const gates = cardinalGates(grid, MAP_WIDTH, MAP_HEIGHT);

  return {
    id: 'choke-point',
    name: 'The Choke Point',
    description:
      'Two wings split by a narrow central corridor. Tactical defence — grenade traps and barrel chains dominate the bottleneck.',
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    grid,
    playerSpawns: [spawn(10, 18), spawn(10, 21)],
    zombieSpawns: gates.map((gate) => ({ x: gate.x, y: gate.y })),
    spawnGates: gates,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAP 3 — The Labyrinth: dense grid-like maze of spines, walls and crates.
// ─────────────────────────────────────────────────────────────────────────────
function buildLabyrinth(): MapDefinition {
  const grid = emptyGrid(MAP_WIDTH, MAP_HEIGHT);
  border(grid, MAP_WIDTH, MAP_HEIGHT);

  // Vertical spines with staggered openings to force weaving movement.
  wall(grid, 7, 2, 2, 11);
  wall(grid, 7, 20, 2, 11);
  wall(grid, 13, 6, 2, 11);
  wall(grid, 13, 24, 2, 10);
  wall(grid, 19, 2, 2, 9);
  wall(grid, 19, 24, 2, 10);
  wall(grid, 25, 6, 2, 11);
  wall(grid, 25, 24, 2, 10);
  wall(grid, 31, 2, 2, 11);
  wall(grid, 31, 20, 2, 11);

  // Horizontal connectors closing off tight corners.
  wall(grid, 10, 16, 6, 2);
  wall(grid, 22, 12, 6, 2);
  wall(grid, 10, 22, 6, 2);
  wall(grid, 22, 26, 6, 2);

  // Scattered crates and one central block.
  wall(grid, 3, 3, 3, 3);
  wall(grid, 34, 3, 3, 3);
  wall(grid, 3, 34, 3, 3);
  wall(grid, 34, 34, 3, 3);
  wall(grid, 17, 20, 2, 2);

  const gates = cardinalGates(grid, MAP_WIDTH, MAP_HEIGHT);

  return {
    id: 'labyrinth',
    name: 'The Labyrinth',
    description:
      'Dense warehouse maze of spines, walls and crates. Blind corners and close-quarters brawls — no infinite straight-line kiting.',
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    grid,
    playerSpawns: [spawn(18, 16), spawn(21, 16)],
    zombieSpawns: gates.map((gate) => ({ x: gate.x, y: gate.y })),
    spawnGates: gates,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAP 4 — The Symmetrical Fortress: four mirrored quadrants around a plaza.
//
//  - Central 10×10 plaza with four 2×2 pillar clusters framing its corners.
//  - A cross-shaped partition at the centre of each quadrant (deliberate choke
//    points to fortify with crates/barrels).
//  - Kept-open central lanes from every cardinal gate straight into the plaza,
//    plus a perimeter ring corridor for kiting — clean, geometric sight lines.
//  - Perfectly mirrored across both axes (every feature sits at x ↔ 39-x and
//    z ↔ 39-z), so no quadrant has a defensive advantage.
// ─────────────────────────────────────────────────────────────────────────────
function buildSymmetricalFortress(): MapDefinition {
  const grid = emptyGrid(MAP_WIDTH, MAP_HEIGHT);
  border(grid, MAP_WIDTH, MAP_HEIGHT);

  // Four plaza-corner pillar clusters framing the open centre.
  wall(grid, 13, 13, 2, 2);
  wall(grid, 25, 13, 2, 2);
  wall(grid, 13, 25, 2, 2);
  wall(grid, 25, 25, 2, 2);

  // Four outer corner pillar clusters (perimeter ring stays open around them).
  wall(grid, 3, 3, 2, 2);
  wall(grid, 35, 3, 2, 2);
  wall(grid, 3, 35, 2, 2);
  wall(grid, 35, 35, 2, 2);

  // A low cross-shaped partition at the centre of each quadrant.
  for (const [qx, qz] of [
    [7, 7],
    [32, 7],
    [7, 32],
    [32, 32],
  ] as const) {
    wall(grid, qx - 2, qz, 5, 1); // horizontal bar
    wall(grid, qx, qz - 2, 1, 5); // vertical bar
  }

  const gates = cardinalGates(grid, MAP_WIDTH, MAP_HEIGHT);

  return {
    id: 'symmetrical-fortress',
    name: 'The Symmetrical Fortress',
    description:
      'Four mirrored quadrants around a central plaza. Pillar clusters and cross partitions create clean choke points — fortify a quadrant and hold the lanes.',
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    grid,
    // Players spawn either side of the plaza, facing opposite directions.
    playerSpawns: [spawn(17, 20), spawn(22, 20)],
    zombieSpawns: gates.map((gate) => ({ x: gate.x, y: gate.y })),
    spawnGates: gates,
  };
}

/** The playable arena registry, in menu order. */
export const MAP_DEFINITIONS: readonly MapDefinition[] = [
  buildClassicBunker(),
  buildChokePoint(),
  buildLabyrinth(),
  buildSymmetricalFortress(),
];

/** Literal union of the registry's ids. */
export type MapId = string;

/** The map shown/highlighted by default. */
export const DEFAULT_MAP_ID: MapId = MAP_DEFINITIONS[0].id;

/** Looks up a map by id, falling back to the first arena (never throws). */
export function getMap(id: string): MapDefinition {
  return MAP_DEFINITIONS.find((map) => map.id === id) ?? MAP_DEFINITIONS[0];
}
