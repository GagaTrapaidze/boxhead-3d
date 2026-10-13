/**
 * Uniform grid collision map + grid line-of-sight.
 *
 * Shared by client (prediction/movement) and server (authority) so both sides
 * resolve movement identically — see ARCHITECTURE.md §1.2.
 *
 * World → cell: cx = floor(x / cellSize), cz = floor(z / cellSize).
 * Out-of-bounds cells count as blocked (LOS and collision).
 */

export interface CellCoord {
  cx: number;
  cz: number;
}

export interface CircleResult {
  x: number;
  z: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Contact tolerance: a circle resting exactly against a wall is *not* an
 * overlap. Needed because radius² is not exact in binary (0.4 × 0.4 =
 * 0.16000000000000003), so a naive `<` comparison would see a touching circle
 * as penetrating and try to push it out with a zero-length vector.
 */
const CONTACT_EPS = 1e-9;

export class GridMap {
  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  private readonly blocked: Uint8Array;

  constructor(width: number, height: number, cellSize: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error(`invalid grid dimensions ${width}×${height}`);
    }
    if (!(cellSize > 0)) throw new Error(`invalid cell size ${cellSize}`);
    this.width = width;
    this.height = height;
    this.cellSize = cellSize;
    this.blocked = new Uint8Array(width * height);
  }

  cellIndex(cx: number, cz: number): number {
    return cz * this.width + cx;
  }

  inBounds(cx: number, cz: number): boolean {
    return cx >= 0 && cz >= 0 && cx < this.width && cz < this.height;
  }

  cellX(x: number): number {
    return Math.floor(x / this.cellSize);
  }

  cellZ(z: number): number {
    return Math.floor(z / this.cellSize);
  }

  /** World coordinates of a cell's center. */
  centerOf(cx: number, cz: number): { x: number; z: number } {
    return { x: (cx + 0.5) * this.cellSize, z: (cz + 0.5) * this.cellSize };
  }

  /** Out-of-bounds counts as blocked. */
  isBlockedCell(cx: number, cz: number): boolean {
    if (!this.inBounds(cx, cz)) return true;
    return this.blocked[this.cellIndex(cx, cz)] === 1;
  }

  isBlockedWorld(x: number, z: number): boolean {
    return this.isBlockedCell(this.cellX(x), this.cellZ(z));
  }

  setBlocked(cx: number, cz: number, blocked: boolean): void {
    if (!this.inBounds(cx, cz)) throw new Error(`cell out of bounds: ${cx},${cz}`);
    this.blocked[this.cellIndex(cx, cz)] = blocked ? 1 : 0;
  }

  /** True when a circle at (x, z) overlaps any blocked cell (OOB counts as solid). */
  private overlapsBlocked(x: number, z: number, radius: number): boolean {
    const cs = this.cellSize;
    const radiusSq = radius * radius;
    const minCx = this.cellX(x - radius);
    const maxCx = this.cellX(x + radius);
    const minCz = this.cellZ(z - radius);
    const maxCz = this.cellZ(z + radius);

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        if (this.inBounds(cx, cz) && !this.blocked[this.cellIndex(cx, cz)]) continue;
        const cellMinX = cx * cs;
        const cellMinZ = cz * cs;
        const dx = x - clamp(x, cellMinX, cellMinX + cs);
        const dz = z - clamp(z, cellMinZ, cellMinZ + cs);
        if (dx * dx + dz * dz < radiusSq - CONTACT_EPS) return true;
      }
    }
    return false;
  }

  /**
   * Pushes a circle (x, z, radius) out of every blocked cell it overlaps.
   * Several relaxation passes handle corners; OOB cells are solid walls.
   *
   * When the center sits inside (or exactly on the boundary/corner of) a
   * blocked cell the shallowest escape axis is chosen *only if it actually
   * clears every neighbouring wall* — otherwise the next-shallowest axis is
   * used. Resolving each cell blindly could otherwise shove the circle from
   * one wall straight into the adjacent one (and leave it wedged inside).
   * Returns the corrected position (input is not mutated).
   */
  resolveCircle(x: number, z: number, radius: number): CircleResult {
    let px = x;
    let pz = z;
    const cs = this.cellSize;

    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      const minCx = this.cellX(px - radius);
      const maxCx = this.cellX(px + radius);
      const minCz = this.cellZ(pz - radius);
      const maxCz = this.cellZ(pz + radius);

      for (let cz = minCz; cz <= maxCz; cz++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          if (this.inBounds(cx, cz) && !this.blocked[this.cellIndex(cx, cz)]) continue;

          const cellMinX = cx * cs;
          const cellMaxX = cellMinX + cs;
          const cellMinZ = cz * cs;
          const cellMaxZ = cellMinZ + cs;

          const closestX = clamp(px, cellMinX, cellMaxX);
          const closestZ = clamp(pz, cellMinZ, cellMaxZ);
          const dx = px - closestX;
          const dz = pz - closestZ;
          const distanceSq = dx * dx + dz * dz;
          if (distanceSq >= radius * radius - CONTACT_EPS) continue;
          moved = true;

          if (distanceSq > 1e-12) {
            const distance = Math.sqrt(distanceSq);
            const push = radius - distance;
            px += (dx / distance) * push;
            pz += (dz / distance) * push;
            continue;
          }

          // center is inside the cell: try the shallowest exits in order and
          // take the first that leaves the circle clear of every wall
          const exits: [number, number, number][] = [
            [cellMinX - radius, pz, px - cellMinX + radius], // left
            [cellMaxX + radius, pz, cellMaxX - px + radius], // right
            [px, cellMinZ - radius, pz - cellMinZ + radius], // top
            [px, cellMaxZ + radius, cellMaxZ - pz + radius], // bottom
          ];
          exits.sort((a, b) => a[2] - b[2]);
          let resolved = false;
          for (const [exitX, exitZ] of exits) {
            if (!this.overlapsBlocked(exitX, exitZ, radius)) {
              px = exitX;
              pz = exitZ;
              resolved = true;
              break;
            }
          }
          if (!resolved) {
            px = exits[0][0];
            pz = exits[0][1];
          }
        }
      }

      if (!moved) break;
    }

    return { x: px, z: pz };
  }

  /**
   * Grid line-of-sight (Amanatides–Woo DDA). Returns false if either endpoint
   * is blocked/out of bounds or the ray crosses any blocked cell.
   */
  lineOfSight(x0: number, z0: number, x1: number, z1: number): boolean {
    let cx = this.cellX(x0);
    let cz = this.cellZ(z0);
    const endCx = this.cellX(x1);
    const endCz = this.cellZ(z1);

    if (this.isBlockedCell(cx, cz) || this.isBlockedCell(endCx, endCz)) return false;

    const dx = x1 - x0;
    const dz = z1 - z0;
    if (dx === 0 && dz === 0) return true;

    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? this.cellSize / Math.abs(dx) : Infinity;
    const tDeltaZ = dz !== 0 ? this.cellSize / Math.abs(dz) : Infinity;
    const nextBoundaryX = dx > 0 ? (cx + 1) * this.cellSize : cx * this.cellSize;
    const nextBoundaryZ = dz > 0 ? (cz + 1) * this.cellSize : cz * this.cellSize;
    let tMaxX = dx !== 0 ? (nextBoundaryX - x0) / dx : Infinity;
    let tMaxZ = dz !== 0 ? (nextBoundaryZ - z0) / dz : Infinity;

    const maxSteps = this.width + this.height + 8;
    let steps = 0;
    while (steps++ < maxSteps) {
      if (tMaxX < tMaxZ) {
        if (tMaxX > 1) break;
        cx += stepX;
        tMaxX += tDeltaX;
      } else {
        if (tMaxZ > 1) break;
        cz += stepZ;
        tMaxZ += tDeltaZ;
      }
      if (this.isBlockedCell(cx, cz)) return false;
    }
    return true;
  }

  /**
   * Distance along a ray (x0, z0) + (dirX, dirZ) to the first blocked cell,
   * clamped to `maxDistance`.
   *
   * Bullets use this to stop at the wall they hit instead of passing through it.
   * Returns `maxDistance` when the ray reaches no wall, and 0 when it starts
   * inside one (or out of bounds). `dir` need not be normalized.
   */
  raycastDistance(
    x0: number,
    z0: number,
    dirX: number,
    dirZ: number,
    maxDistance: number
  ): number {
    const length = Math.hypot(dirX, dirZ);
    if (length < 1e-9) return maxDistance;
    const dx = dirX / length;
    const dz = dirZ / length;

    let cx = this.cellX(x0);
    let cz = this.cellZ(z0);
    if (this.isBlockedCell(cx, cz)) return 0;

    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const tDeltaX = dx !== 0 ? this.cellSize / Math.abs(dx) : Infinity;
    const tDeltaZ = dz !== 0 ? this.cellSize / Math.abs(dz) : Infinity;
    const nextBoundaryX = dx > 0 ? (cx + 1) * this.cellSize : cx * this.cellSize;
    const nextBoundaryZ = dz > 0 ? (cz + 1) * this.cellSize : cz * this.cellSize;
    let tMaxX = dx !== 0 ? (nextBoundaryX - x0) / dx : Infinity;
    let tMaxZ = dz !== 0 ? (nextBoundaryZ - z0) / dz : Infinity;

    const maxSteps = this.width + this.height + 8;
    for (let step = 0; step < maxSteps; step++) {
      const t = Math.min(tMaxX, tMaxZ);
      if (t > maxDistance) return maxDistance; // ran out of range first
      if (tMaxX < tMaxZ) {
        cx += stepX;
        tMaxX += tDeltaX;
      } else {
        cz += stepZ;
        tMaxZ += tDeltaZ;
      }
      if (this.isBlockedCell(cx, cz)) return t; // wall face at distance t
    }
    return maxDistance;
  }
}
