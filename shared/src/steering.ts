/**
 * 2D heading (x/z plane) steering helpers.
 *
 * The offline client AI and the server authority both call these, so a homing
 * turn resolves identically in every mode — the Red Devil's phase-2 dash uses
 * them to curve toward its target's live position instead of flying down a
 * frozen line.
 *
 * Headings use the project's `atan2(x, z)` convention (0 = +z, π/2 = +x): the
 * same angle actors write onto `mesh.rotation.y`.
 */

/** Wraps `angle` into (-π, π]. */
export function wrapAngle(angle: number): number {
  let wrapped = angle;
  while (wrapped > Math.PI) wrapped -= Math.PI * 2;
  while (wrapped <= -Math.PI) wrapped += Math.PI * 2;
  return wrapped;
}

/**
 * Rotates `current` toward `desired` by at most `maxTurn` radians, always the
 * shortest way around the circle. Never overshoots: once the remaining gap fits
 * inside `maxTurn`, `desired` is returned exactly.
 */
export function stepAngleToward(current: number, desired: number, maxTurn: number): number {
  const delta = wrapAngle(desired - current);
  if (Math.abs(delta) <= maxTurn) return wrapAngle(desired);
  return wrapAngle(current + Math.sign(delta) * maxTurn);
}
