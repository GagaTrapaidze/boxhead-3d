/**
 * Shared entity/wire vocabulary for the authoritative world — the enums and
 * loot rolls that the server simulation and the client renderer must agree on.
 *
 * (Weapon ids live in `weapons.ts`; this module only covers world entities:
 * enemy kinds, barricade/prop kinds and drop kinds.)
 */
import { ENEMY_CONFIG, WAVE_CONFIG } from './balance.config.ts';

// ---------------------------------------------------------------------------
// Enemy kinds
// ---------------------------------------------------------------------------

export type EnemyKind = 'walker' | 'runner' | 'devil' | 'blackDevil';

/** Wire codes — index into this array (stable, never reorder). */
export const ENEMY_KINDS: readonly EnemyKind[] = ['walker', 'runner', 'devil', 'blackDevil'];

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

export type DropKind = 'shotgun' | 'uzi' | 'grenade' | 'barrel' | 'power' | 'health';

/** Wire codes — index into this array (stable, never reorder). */
export const DROP_KINDS: readonly DropKind[] = ['shotgun', 'uzi', 'grenade', 'barrel', 'power', 'health'];

export function dropKindCode(kind: DropKind): number {
  return DROP_KINDS.indexOf(kind);
}

export function dropKindFromCode(code: number): DropKind {
  return DROP_KINDS[code] ?? 'shotgun';
}

/**
 * The *standard* mob-drop table. Health packs are deliberately excluded — they
 * are the Black Devil's boss loot only (see `BOSS_LOOT_WEIGHTED`), so the
 * ordinary horde drop distribution is unchanged by the boss update.
 */
const STANDARD_DROP_KINDS = ['shotgun', 'uzi', 'grenade', 'barrel', 'power'] as const;

/** Drop weights in `DROP_KINDS` order, resolved once from the balance table. */
const DROP_WEIGHTED: readonly [DropKind, number][] = STANDARD_DROP_KINDS.map((kind) => [
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

// ---------------------------------------------------------------------------
// Boss loot — the Black Devil's death "loot explosion"
// ---------------------------------------------------------------------------

/**
 * Boss reward table: health packs, special ammo and barrels, with a rare extra
 * power-up. Weighted rather than uniform so a kill reliably hands out the
 * survival tools a boss fight consumes.
 */
const BOSS_LOOT_WEIGHTED: readonly [DropKind, number][] = [
  ['health', 3],
  ['grenade', 2],
  ['uzi', 3],
  ['shotgun', 2],
  ['barrel', 2],
  ['power', 1],
];
const BOSS_LOOT_TOTAL = BOSS_LOOT_WEIGHTED.reduce((sum, [, weight]) => sum + weight, 0);

/** Picks one reward kind from the boss-loot table (never returns null). */
export function pickBossLoot(random: () => number = Math.random): DropKind {
  let roll = random() * BOSS_LOOT_TOTAL;
  for (const [kind, weight] of BOSS_LOOT_WEIGHTED) {
    roll -= weight;
    if (roll < 0) return kind;
  }
  return BOSS_LOOT_WEIGHTED[BOSS_LOOT_WEIGHTED.length - 1][0];
}

/** Number of reward cubes a boss drops: `lootDropMin`..`lootDropMax` inclusive. */
export function bossLootCount(random: () => number = Math.random): number {
  const { lootDropMin: min, lootDropMax: max } = ENEMY_CONFIG.blackDevil;
  return min + Math.floor(random() * (max - min + 1));
}
