/**
 * Weapon & utility drops from dead enemies.
 *
 * Drops are frequent (see DROP_CHANCE) and hand out real inventory, not just
 * ammo: walking over a pickup unlocks/equips the weapon and tops up its ammo.
 * Each kind has a distinct indicator colour so it reads at a glance.
 *
 *   shotgun — red       unlocks the Shotgun, or +30 shells
 *   uzi     — yellow    unlocks the Uzi, or +150 rounds
 *   grenade — dark green +5 throwing grenades
 *   barrel  — orange    +3 explosive barrels
 *   power   — purple    temporary POWER ×2 damage
 */
import * as THREE from 'three';

import { buildPickup } from './actors.ts';
import type { PickupKind } from './actors.ts';
import { WeaponId, getWeapon } from '../../../shared/src/weapons.ts';
import { WAVE_CONFIG } from '../../../shared/src/balance.config.ts';
import { bossLootCount, pickBossLoot } from '../../../shared/src/loot.ts';
import { POWER_DURATION, grantWeapon, isWeaponAvailable } from './player.ts';
import type { Player } from './player.ts';

export interface Pickup {
  kind: PickupKind;
  x: number;
  z: number;
  ttl: number;
  /** Countdown to the next despawn-warning visibility toggle. */
  blinkTimer: number;
  mesh: THREE.Group;
}

// Drop tuning lives in `shared/src/balance.config.ts` (WAVE_CONFIG).
export const PICKUP_LIFE = WAVE_CONFIG.pickupLifeSeconds;
/** Seconds of flashing before a ground cube is removed (memory cleanliness). */
export const PICKUP_WARNING_SECONDS = WAVE_CONFIG.pickupWarningSeconds;
/** Toggle period of the despawn-warning blink. */
export const PICKUP_BLINK_INTERVAL = WAVE_CONFIG.pickupBlinkInterval;
export const PICKUP_RADIUS = WAVE_CONFIG.pickupRadius;
/** Chance that a killed zombie leaves a drop — deliberately generous. */
export const DROP_CHANCE = WAVE_CONFIG.mobDropRate;

export interface PickupAward {
  weaponId: number;
  /** Ammo granted when the weapon is already available. */
  amount: number;
  label: string;
}

export const PICKUP_AWARD: Record<Exclude<PickupKind, 'power' | 'health'>, PickupAward> = {
  shotgun: { weaponId: WeaponId.Shotgun, amount: WAVE_CONFIG.pickupAwards.shotgun, label: 'SHOTGUN' },
  uzi: { weaponId: WeaponId.Uzi, amount: WAVE_CONFIG.pickupAwards.uzi, label: 'UZI' },
  grenade: { weaponId: WeaponId.Grenade, amount: WAVE_CONFIG.pickupAwards.grenade, label: 'GRENADES' },
  barrel: { weaponId: WeaponId.Barrel, amount: WAVE_CONFIG.pickupAwards.barrel, label: 'EXPLOSIVE BARRELS' },
};

/** Weighted drop table (relative weights, so it does not need to sum to 100). */
const DROP_WEIGHTS = Object.entries(WAVE_CONFIG.dropWeights) as readonly [PickupKind, number][];

let bobClock = 0;

/** Rolls a random drop kind — or null when this zombie drops nothing. */
export function rollDropKind(): PickupKind | null {
  if (Math.random() >= DROP_CHANCE) return null;
  return pickKind();
}

/** Picks a kind from the weighted table. */
export function pickKind(random: () => number = Math.random): PickupKind {
  const total = DROP_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [kind, weight] of DROP_WEIGHTS) {
    roll -= weight;
    if (roll < 0) return kind;
  }
  return DROP_WEIGHTS[DROP_WEIGHTS.length - 1][0];
}

/**
 * The Black Devil's death "loot explosion": 3–4 reward cubes scattered around
 * its footprint (the offline twin of the room's server-side kill reward).
 * Returns how many cubes were dropped.
 */
export function spawnBossLoot(
  scene: THREE.Scene,
  list: Pickup[],
  x: number,
  z: number
): number {
  const count = bossLootCount();
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = 0.4 + Math.random() * 1.1;
    spawnPickup(
      scene,
      list,
      x + Math.cos(angle) * distance,
      z + Math.sin(angle) * distance,
      pickBossLoot()
    );
  }
  return count;
}

export function spawnPickup(
  scene: THREE.Scene,
  list: Pickup[],
  x: number,
  z: number,
  kind?: PickupKind
): Pickup {
  const resolved = kind ?? pickKind();
  const mesh = buildPickup(resolved);
  mesh.position.set(x, 0, z);
  scene.add(mesh);
  const pickup: Pickup = {
    kind: resolved,
    x,
    z,
    ttl: PICKUP_LIFE,
    blinkTimer: PICKUP_BLINK_INTERVAL,
    mesh,
  };
  list.push(pickup);
  return pickup;
}

function removePickup(scene: THREE.Scene, list: Pickup[], index: number): void {
  const pickup = list[index];
  // crate mesh parts are shared cached resources (actors.ts) — never disposed
  scene.remove(pickup.mesh);
  list.splice(index, 1);
}

/**
 * Applies a pickup: unlocks+equips the weapon and adds its ammo, or refreshes
 * POWER ×2. Returns the HUD banner text.
 */
export function applyPickup(player: Player, kind: PickupKind): string {
  if (kind === 'power') {
    player.powerTimer = POWER_DURATION;
    return 'POWER ×2!';
  }

  // Health pack (Black Devil boss loot): restore HP, capped at the max.
  if (kind === 'health') {
    const before = player.hp;
    player.hp = Math.min(player.maxHp, player.hp + WAVE_CONFIG.healthRestore);
    return `HEALTH +${Math.round(player.hp - before)}`;
  }

  const award = PICKUP_AWARD[kind];
  const alreadyAvailable = isWeaponAvailable(player, award.weaponId);
  grantWeapon(player, award.weaponId);
  player.ammo.set(award.weaponId, (player.ammo.get(award.weaponId) ?? 0) + award.amount);
  player.weapon = award.weaponId; // equip what you just walked over

  const def = getWeapon(award.weaponId);
  return alreadyAvailable
    ? `${def.name} +${award.amount}`
    : `${def.name} UNLOCKED · +${award.amount}`;
}

/**
 * Bobs, expires and collects pickups.
 * Returns banner messages for the players that picked something up.
 */
export function updatePickups(
  scene: THREE.Scene,
  list: Pickup[],
  dt: number,
  players: readonly Player[]
): { playerIndex: number; message: string }[] {
  bobClock += dt;
  const collected: { playerIndex: number; message: string }[] = [];

  for (let i = list.length - 1; i >= 0; i--) {
    const pickup = list[i];
    pickup.ttl -= dt;
    const crate = pickup.mesh.children[0] as THREE.Mesh | undefined;
    if (crate) {
      crate.rotation.y += dt * 2;
      crate.position.y = 0.35 + Math.sin(bobClock * 3 + pickup.x) * 0.12;
    }

    // Despawn timer: the final seconds flicker the cube before it is removed.
    if (pickup.ttl <= PICKUP_WARNING_SECONDS) {
      pickup.blinkTimer -= dt;
      if (pickup.blinkTimer <= 0) {
        pickup.mesh.visible = !pickup.mesh.visible;
        pickup.blinkTimer = PICKUP_BLINK_INTERVAL;
      }
    } else if (!pickup.mesh.visible) {
      pickup.mesh.visible = true;
    }

    if (pickup.ttl <= 0) {
      removePickup(scene, list, i);
      continue;
    }

    for (const player of players) {
      if (!player.alive) continue;
      if (Math.hypot(player.x - pickup.x, player.z - pickup.z) > PICKUP_RADIUS) continue;
      collected.push({ playerIndex: player.index, message: applyPickup(player, pickup.kind) });
      removePickup(scene, list, i);
      break;
    }
  }

  return collected;
}
