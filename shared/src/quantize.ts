import { AIM_SCALE, DIRECTION_STEPS, POSITION_SCALE } from './constants.ts';

/** Clamps `value` into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** World coordinate → i16 wire value (centi-unit precision, clamped). */
export function quantizePosition(value: number): number {
  return clamp(Math.round(value * POSITION_SCALE), -32768, 32767);
}

/** i16 wire value → world coordinate. */
export function dequantizePosition(quantized: number): number {
  return quantized / POSITION_SCALE;
}

/** [-1, 1] component → i16 wire value. */
export function quantizeAim(value: number): number {
  return clamp(Math.round(value * AIM_SCALE), -AIM_SCALE, AIM_SCALE);
}

/** i16 wire value → [-1, 1] component. */
export function dequantizeAim(quantized: number): number {
  return quantized / AIM_SCALE;
}

/**
 * Direction vector (x, z) → u8 wire value (0..255).
 * Returns 0 for a zero-length vector (aim not yet known).
 */
export function quantizeDirection(dx: number, dz: number): number {
  if (dx === 0 && dz === 0) return 0;
  const angle = Math.atan2(dz, dx); // (-π, π]
  const steps = Math.round((angle / (Math.PI * 2)) * DIRECTION_STEPS);
  return ((steps % DIRECTION_STEPS) + DIRECTION_STEPS) % DIRECTION_STEPS;
}

/** u8 wire value → heading in radians, in (-π, π]. */
export function dequantizeDirection(quantized: number): number {
  return (quantized / DIRECTION_STEPS) * Math.PI * 2;
}
