/**
 * Shared entity/wire vocabulary for the authoritative world — the enums and
 * loot rolls that the server simulation and the client renderer must agree on.
 *
 * (Weapon ids live in `weapons.ts`; this module only covers world entities:
 * enemy kinds, barricade/prop kinds and drop kinds.)
 */
import { WAVE_CONFIG } from './balance.config.ts';

// ---------------------------------------------------------------------------
// Enemy kinds
// ---------------------------------------------------------------------------

export type EnemyKind = 'walker' | 'runner' | 'devil';

/** Wire codes — index into this array (stable, never reorder). */
export const ENEMY_KINDS: readonly EnemyKind[] = ['walker', 'runner', 'devil'];

export function enemyKindCode(kind: EnemyKind): number {
  return ENEMY_KINDS.indexOf(kind);
}

export function enemyKindFromCode(code: number): EnemyKind {
  return ENEMY_KINDS[code] ?? 'walker';
}

// ---------------------------------------------------------------------------
// Prop (barricade) kinds
// ---------------------------------------------------------------------------

export type PropKind = 'barrel' | 'crate';

export const PROP_KINDS: readonly PropKind[] = ['barrel', 'crate'];

export function propKindCode(kind: PropKind): number {
  return PROP_KINDS.indexOf(kind);
}

export function propKindFromCode(code: number): PropKind {
  return PROP_KINDS[code] ?? 'barrel';
}

// ---------------------------------------------------------------------------
// Drop kinds
// ---------------------------------------------------------------------------

export type DropKind = 'shotgun' | 'uzi' | 'grenade' | 'barrel' | 'power';

/** Wire codes — index into this array (stable, never reorder). */
export const DROP_KINDS: readonly DropKind[] = ['shotgun', 'uzi', 'grenade', 'barrel', 'power'];

export function dropKindCode(kind: DropKind): number {
  return DROP_KINDS.indexOf(kind);
}

export function dropKindFromCode(code: number): DropKind {
  return DROP_KINDS[code] ?? 'shotgun';
}

/** Drop weights in `DROP_KINDS` order, resolved once from the balance table. */
const DROP_WEIGHTED: readonly [DropKind, number][] = DROP_KINDS.map((kind) => [
  kind,
  WAVE_CONFIG.dropWeights[kind],
]);
const DROP_WEIGHT_TOTAL = DROP_WEIGHTED.reduce((sum, [, weight]) => sum + weight, 0);

/** Picks a kind from the weighted table (ignores the base drop chance). */
export function pickDropKind(random: () => number = Math.random): DropKind {
  let roll = random() * DROP_WEIGHT_TOTAL;
  for (const [kind, weight] of DROP_WEIGHTED) {
    roll -= weight;
    if (roll < 0) return kind;
  }
  return DROP_WEIGHTED[DROP_WEIGHTED.length - 1][0];
}

/** Rolls whether a defeated mob/box drops anything, and which kind. */
export function rollDropKind(random: () => number = Math.random): DropKind | null {
  if (random() >= WAVE_CONFIG.mobDropRate) return null;
  return pickDropKind(random);
}
