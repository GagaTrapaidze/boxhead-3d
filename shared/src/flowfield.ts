/**
 * Flow-field pathfinding for the horde — ARCHITECTURE.md §1.5.
 *
 * One Dijkstra wave from all goal cells at once produces a distance field and
 * a per-cell steering direction. Hundreds of zombies then cost only a nearest-
 * cell lookup + local steering; no per-zombie A*.
 *
 * Movement is 8-connected with √2 diagonals and no corner cutting (a diagonal
 * step requires both orthogonal neighbours to be free).
 */
import { GridMap } from './grid.ts';
import type { CellCoord } from './grid.ts';

export interface FlowField {
  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  /** World-unit distance to the nearest goal; Infinity = unreachable. */
  readonly distance: Float32Array;
  /** Normalized desired direction per cell (0,0 for goals/unreachable). */
  readonly dirX: Float32Array;
  readonly dirZ: Float32Array;
}

const SQRT2 = Math.SQRT2;
const NEIGHBOR_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const NEIGHBOR_DZ = [0, 0, 1, -1, 1, -1, 1, -1];
const NEIGHBOR_COST = [1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2];

/** Binary min-heap over cell indices keyed by Float64 priorities. */
class MinHeap {
  private readonly cells: number[] = [];
  private readonly priorities: number[] = [];

  get size(): number {
    return this.cells.length;
  }

  push(cell: number, priority: number): void {
    this.cells.push(cell);
    this.priorities.push(priority);
    let i = this.cells.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.priorities[parent] <= this.priorities[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.cells[0];
    const lastCell = this.cells.pop() as number;
    const lastPriority = this.priorities.pop() as number;
    if (this.cells.length > 0) {
      this.cells[0] = lastCell;
      this.priorities[0] = lastPriority;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.cells.length && this.priorities[left] < this.priorities[smallest]) {
          smallest = left;
        }
        if (right < this.cells.length && this.priorities[right] < this.priorities[smallest]) {
          smallest = right;
        }
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const cell = this.cells[a];
    this.cells[a] = this.cells[b];
    this.cells[b] = cell;
    const priority = this.priorities[a];
    this.priorities[a] = this.priorities[b];
    this.priorities[b] = priority;
  }
}

/**
 * Computes the flow field toward every goal cell simultaneously.
 * Blocked and out-of-bounds cells get Infinity distance and zero direction.
 * Throws if there is no valid goal.
 */
export function computeFlowField(grid: GridMap, goals: readonly CellCoord[]): FlowField {
  if (goals.length === 0) throw new Error('computeFlowField requires at least one goal');

  const { width, height, cellSize } = grid;
  const size = width * height;
  const distance = new Float64Array(size).fill(Infinity);
  const heap = new MinHeap();

  for (const goal of goals) {
    if (!grid.inBounds(goal.cx, goal.cz)) {
      throw new Error(`goal out of bounds: ${goal.cx},${goal.cz}`);
    }
    if (grid.isBlockedCell(goal.cx, goal.cz)) {
      throw new Error(`goal cell is blocked: ${goal.cx},${goal.cz}`);
    }
    const index = grid.cellIndex(goal.cx, goal.cz);
    if (distance[index] > 0) {
      distance[index] = 0;
      heap.push(index, 0);
    }
  }

  while (heap.size > 0) {
    const index = heap.pop();
    const cx = index % width;
    const cz = (index - cx) / width;
    const current = distance[index];

    for (let n = 0; n < 8; n++) {
      const nx = cx + NEIGHBOR_DX[n];
      const nz = cz + NEIGHBOR_DZ[n];
      if (!grid.inBounds(nx, nz) || grid.isBlockedCell(nx, nz)) continue;

      // no corner cutting: diagonals need both orthogonal cells free
      if (n >= 4) {
        if (grid.isBlockedCell(cx + NEIGHBOR_DX[n], cz) || grid.isBlockedCell(cx, cz + NEIGHBOR_DZ[n])) {
          continue;
        }
      }

      const tentative = current + NEIGHBOR_COST[n] * cellSize;
      const neighborIndex = grid.cellIndex(nx, nz);
      if (tentative < distance[neighborIndex]) {
        distance[neighborIndex] = tentative;
        heap.push(neighborIndex, tentative);
      }
    }
  }

  // derive per-cell steering directions toward the lowest-distance neighbor
  const dirX = new Float32Array(size);
  const dirZ = new Float32Array(size);
  for (let cz = 0; cz < height; cz++) {
    for (let cx = 0; cx < width; cx++) {
      const index = grid.cellIndex(cx, cz);
      const here = distance[index];
      if (!Number.isFinite(here) || here === 0 || grid.isBlockedCell(cx, cz)) continue;

      let bestIndex = -1;
      let bestDistance = here;
      for (let n = 0; n < 8; n++) {
        const nx = cx + NEIGHBOR_DX[n];
        const nz = cz + NEIGHBOR_DZ[n];
        if (!grid.inBounds(nx, nz)) continue;
        const candidate = distance[grid.cellIndex(nx, nz)];
        if (candidate < bestDistance) {
          bestDistance = candidate;
          bestIndex = grid.cellIndex(nx, nz);
        }
      }
      if (bestIndex < 0) continue;

      const bestCx = bestIndex % width;
      const bestCz = (bestIndex - bestCx) / width;
      let vx = bestCx - cx;
      let vz = bestCz - cz;
      const length = Math.hypot(vx, vz);
      dirX[index] = vx / length;
      dirZ[index] = vz / length;
    }
  }

  const distance32 = new Float32Array(size);
  for (let i = 0; i < size; i++) distance32[i] = distance[i];

  return { width, height, cellSize, distance: distance32, dirX, dirZ };
}

/**
 * Nearest-cell sampling at a world position: desired direction + distance.
 * Positions outside the grid or in unreachable cells return (0, 0, Infinity).
 */
export function sampleFlow(
  grid: GridMap,
  field: FlowField,
  x: number,
  z: number
): { x: number; z: number; distance: number } {
  const cx = grid.cellX(x);
  const cz = grid.cellZ(z);
  if (!grid.inBounds(cx, cz)) return { x: 0, z: 0, distance: Infinity };
  const index = grid.cellIndex(cx, cz);
  return { x: field.dirX[index], z: field.dirZ[index], distance: field.distance[index] };
}
