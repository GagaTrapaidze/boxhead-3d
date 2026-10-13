// ---------------------------------------------------------------------------
// Combo / multiplier rules — shared so client and (later) server agree.
// Classic Boxhead kill-chain: each kill adds +1 and refreshes a single hold
// window (COMBO_CONFIG.windowSeconds, 1.8 s). If the window lapses before the
// next kill the whole chain resets to ×1. The weapon unlock ladder itself lives
// in `balance.config.ts`.
// ---------------------------------------------------------------------------

import { COMBO_CONFIG, WEAPON_MULTIPLIER_REQUIREMENT } from './balance.config.ts';

// Re-exported so the combo ladder keeps a single source of truth.
export { WEAPON_MULTIPLIER_REQUIREMENT };

export const BASE_MULTIPLIER = 1;

/** Multiplier granted by a single kill. */
export function multiplierAfterKill(multiplier: number): number {
  return multiplier + 1;
}

/** Losing the chain (timeout or taking damage) drops straight back to ×1. */
export function resetMultiplier(): number {
  return BASE_MULTIPLIER;
}

/**
 * Seconds the combo is held after the most recent kill before it resets to ×1.
 * Flat by design — every kill refreshes the same short window.
 */
export function comboWindowSeconds(): number {
  return COMBO_CONFIG.windowSeconds;
}

/** The milestone multipliers that fire a spree banner + reward. */
export function comboMilestones(): readonly number[] {
  return COMBO_CONFIG.milestones;
}

/** True when `multiplier` is exactly a configured milestone. */
export function isComboMilestone(multiplier: number): boolean {
  return COMBO_CONFIG.milestones.includes(multiplier);
}

/** Banner text for a milestone (e.g. "×10 SPREE!"), or null when not one. */
export function comboMilestoneLabel(multiplier: number): string | null {
  const label = COMBO_CONFIG.labels[multiplier];
  return label ? `×${multiplier} ${label}` : null;
}

/** Looks up the unlock gate for a weapon id; throws on unknown ids. */
export function requiredMultiplierFor(weaponId: number): number {
  const required = WEAPON_MULTIPLIER_REQUIREMENT[weaponId];
  if (required === undefined) throw new Error(`unknown weapon id: ${weaponId}`);
  return required;
}

export function isUnlockedByMultiplier(weaponId: number, multiplier: number): boolean {
  return multiplier >= requiredMultiplierFor(weaponId);
}
