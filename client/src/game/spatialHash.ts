/**
 * 2D spatial hash grid — the broadphase that replaces the brute-force O(N²)
 * enemy-to-enemy separation pass.
 *
 * Active mobs are binned into fixed-size buckets by world cell; a query only
 * walks the buckets overlapping its search radius, so each zombie tests a
 * handful of neighbours instead of every other zombie on the map. Buckets are
 * reused between frames (arrays are emptied, not reallocated) to keep the
 * per-tick allocation at zero.
 */
import { SPATIAL_CONFIG } from '../../../shared/src/balance.config.ts';

/** Anything that can be binned by its ground position. */
export interface SpatialItem {
  x: number;
  z: number;
}

/** Packs signed cell coordinates into one numeric Map key. */
function cellKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768);
}

export class SpatialHash<T extends SpatialItem> {
  private readonly cellSize: number;
  private readonly buckets = new Map<number, T[]>();

  constructor(cellSize = SPATIAL_CONFIG.cellSize) {
    this.cellSize = cellSize;
  }

  private cellCoord(value: number): number {
    return Math.floor(value / this.cellSize);
  }

  /** Drops every item but keeps the bucket arrays for reuse next frame. */
  clear(): void {
    for (const bucket of this.buckets.values()) bucket.length = 0;
  }

  insert(item: T): void {
    const key = cellKey(this.cellCoord(item.x), this.cellCoord(item.z));
    const bucket = this.buckets.get(key);
    if (bucket) bucket.push(item);
    else this.buckets.set(key, [item]);
  }

  /** Fills `out` with every item whose centre lies within `radius` of (x, z). */
  query(x: number, z: number, radius: number, out: T[]): T[] {
    out.length = 0;
    const minCx = this.cellCoord(x - radius);
    const maxCx = this.cellCoord(x + radius);
    const minCz = this.cellCoord(z - radius);
    const maxCz = this.cellCoord(z + radius);
    const radiusSq = radius * radius;
    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bucket = this.buckets.get(cellKey(cx, cz));
        if (!bucket) continue;
        for (const item of bucket) {
          const dx = item.x - x;
          const dz = item.z - z;
          if (dx * dx + dz * dz <= radiusSq) out.push(item);
        }
      }
    }
    return out;
  }
}
