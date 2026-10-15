/**
 * Expanding shockwave ring geometry — shared by the server authority
 * (`server/src/rooms/world.ts`) and the offline client AI
 * (`client/src/game/enemies.ts`) so the Black Devil's Attack 2 resolves
 * identically in every mode.
 *
 * A shockwave is an *annulus* (a ring band, not a filled disc) that races
 * outward from the boss origin at a fixed world-units/second. Damage lands only
 * when the ring's perimeter physically sweeps across a victim's bounding
 * circle — never from a plain "is the victim inside the final radius" test.
 * Because the test sweeps the whole band travelled this tick (previous radius →
 * new radius), a fast wave can never tunnel past a body between ticks.
 *
 * Cover works because the caller gates each contact on a grid line-of-sight
 * ray from the origin: a body behind a wooden crate / wall has no clear ray, so
 * the ring passes it by with no damage.
 */

/** Half-open annulus that grows from `x, z` out to `maxRadius`. */
export interface ShockwaveRing {
  /** Boss origin the ring expands from (fixed for the ring's whole life). */
  x: number;
  z: number;
  /** Current outer radius, in world units. */
  radius: number;
  /** Outer radius at which the ring expires. */
  maxRadius: number;
  /** Half-thickness of the damage band around the perimeter. */
  halfThickness: number;
  /** Expansion speed, in world units/second. */
  speed: number;
}

/** A fresh ring sitting on its origin, ready to expand. */
export function createShockwaveRing(
  x: number,
  z: number,
  maxRadius: number,
  halfThickness: number,
  speed: number
): ShockwaveRing {
  return { x, z, radius: 0, maxRadius, halfThickness, speed };
}

/**
 * True when the ring's perimeter *swept* across the circle (cx, cz, radius)
 * between the previous and the new radius.
 *
 * The swept band spans `[prev - t, next + t]` (t = half-thickness); the body is
 * a circle of `radius`. They touch when the body is not entirely inside the
 * band's inner hole and not entirely outside its outer edge.
 */
export function ringSweepHitsCircle(
  originX: number,
  originZ: number,
  prevRadius: number,
  nextRadius: number,
  halfThickness: number,
  cx: number,
  cz: number,
  radius: number
): boolean {
  const distance = Math.hypot(cx - originX, cz - originZ);
  const inner = Math.min(prevRadius, nextRadius) - halfThickness;
  const outer = Math.max(prevRadius, nextRadius) + halfThickness;
  return distance + radius >= inner && distance - radius <= outer;
}

/** Seconds a ring needs to grow from its origin to `maxRadius`. */
export function shockwaveRingDuration(ring: ShockwaveRing): number {
  return ring.speed > 0 ? ring.maxRadius / ring.speed : 0;
}

/**
 * Advances one ring by `dt`. Returns the radius before the step (for the swept
 * collision test) and whether the ring is still alive (below `maxRadius`).
 */
export function advanceShockwaveRing(
  ring: ShockwaveRing,
  dt: number
): { prevRadius: number; alive: boolean } {
  const prevRadius = ring.radius;
  ring.radius = Math.min(ring.maxRadius, ring.radius + ring.speed * dt);
  return { prevRadius, alive: ring.radius < ring.maxRadius };
}
