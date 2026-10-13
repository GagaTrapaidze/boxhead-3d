// ---------------------------------------------------------------------------
// Weapon table — single source of truth for the client HUD and server checks.
//
// Every number here comes from `balance.config.ts`; edit tuning in that file,
// never in engine logic. This module only adds the wire-stable slot ids and the
// small pure helpers the client/server call on every shot.
// ---------------------------------------------------------------------------

import {
  WEAPON_BALANCE,
  WEAPON_MULTIPLIER_REQUIREMENT,
  type WeaponBalance,
} from './balance.config.ts';

/** Weapon slot ids — stable, used on the wire in InputMsg.weapon. */
export const WeaponId = {
  Pistol: 0,
  Shotgun: 1,
  Uzi: 2,
  Grenade: 3,
  Barrel: 4,
  Mine: 5,
  Rocket: 6,
  Railgun: 7,
  Crate: 8,
} as const;

export type WeaponKind = WeaponBalance['kind'];

/** A tuned weapon: one `WEAPON_BALANCE` row plus its slot id. */
export interface WeaponDef extends WeaponBalance {
  id: number;
}

/**
 * The ordered weapon table. `WEAPON_BALANCE` is declared in `WeaponId` order,
 * so the array index is the wire id — the weapons test asserts this.
 */
export const WEAPONS: readonly WeaponDef[] = WEAPON_BALANCE.map((balance, id) => ({
  ...balance,
  id,
}));

// ---------------------------------------------------------------------------
// Combo-tier / multiplier gating
// ---------------------------------------------------------------------------

/** Minimum kill multiplier required to fire each weapon (index = weapon id). */
export { WEAPON_MULTIPLIER_REQUIREMENT };

/** Minimum combo tier (kill multiplier) required before a weapon is usable. */
export function isUnlocked(def: WeaponDef, comboTier: number): boolean {
  return comboTier >= def.comboTier;
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

// ---------------------------------------------------------------------------
// Firing gates
// ---------------------------------------------------------------------------

/** Rate-of-fire gate — the server calls this on every fire input. */
export function isReadyToFire(def: WeaponDef, nowMs: number, lastFireMs: number): boolean {
  return nowMs - lastFireMs >= def.fireIntervalMs;
}

/** Ammo is ignored for infinite weapons (magSize === 0). */
export function hasAmmo(def: WeaponDef, ammo: number): boolean {
  return def.magSize === 0 || ammo > 0;
}

/** Look up a weapon by id; throws on unknown ids (server-side guard). */
export function getWeapon(id: number): WeaponDef {
  const def = WEAPONS[id];
  if (!def || def.id !== id) throw new Error(`unknown weapon id: ${id}`);
  return def;
}
