/**
 * Player: boxhead actor, grid-collided movement, facing, combo multiplier and
 * hitscan resolution. Movement runs through the shared GridMap so the future
 * server authority replays identical collision.
 */
import * as THREE from 'three';

import { GridMap } from '../../../shared/src/grid.ts';
import { WEAPONS, WeaponId, getWeapon } from '../../../shared/src/weapons.ts';
import type { WeaponDef } from '../../../shared/src/weapons.ts';
import {
  BASE_MULTIPLIER,
  comboWindowSeconds,
  isUnlockedByMultiplier,
  multiplierAfterKill,
  resetMultiplier,
} from '../../../shared/src/combo.ts';
import { PLAYER_CONFIG } from '../../../shared/src/balance.config.ts';
import type { CurseState } from '../../../shared/src/curse.ts';
import { CHARACTERS, buildBoxhead } from './actors.ts';
import type { CharacterId } from './actors.ts';

// Tuning lives in `shared/src/balance.config.ts` (PLAYER_CONFIG).
export const PLAYER_RADIUS = PLAYER_CONFIG.radius;
export const PLAYER_MAX_HP = PLAYER_CONFIG.maxHp;
export const PLAYER_SPEED = PLAYER_CONFIG.speed;
export const POWER_DURATION = PLAYER_CONFIG.powerDuration; // seconds of POWER ×2
/** Units/second the weapon kick recovers at (snappy but smooth). */
export const RECOIL_RECOVERY = PLAYER_CONFIG.recoilRecovery;

/**
 * Spawn points — placed at the centres of OPEN grid cells.
 *
 * They must never sit flush against (or inside) a wall block: a shooter whose
 * body overlaps a wall immediately clips every pellet that spreads a hair
 * toward that wall, silently throwing away half the shots. Cell centres keep a
 * full radius of clearance on every side.
 */
export const SINGLE_START = { x: 20.5, z: 20.5 };
export const DUO_STARTS = [
  { x: 18.5, z: 20.5 },
  { x: 22.5, z: 20.5 },
];

export interface Player {
  index: number;
  character: CharacterId;
  x: number;
  z: number;
  hp: number;
  alive: boolean;
  weapon: number;
  _lastWeaponId: number; // track weapon changes for mesh updates
  /** Limited magazines keyed by weapon id (pistol is infinite: no entry). */
  ammo: Map<number, number>;
  /** Weapons unlocked by pickups rather than by the combo multiplier. */
  granted: Set<number>;
  lastFireMs: number;
  /** Movement/aim direction as a unit vector. */
  aimX: number;
  aimZ: number;
  /** Mesh rotation.y — kept in sync with aim: dir = (sin(facing), cos(facing)). */
  facing: number;
  /** Combo multiplier (weapon tier gate); decays over time. */
  mult: number;
  comboTimer: number;
  /** Remaining seconds of POWER ×2 pickup. */
  powerTimer: number;
  /** Kill count this match (end-game summary). */
  kills: number;
  /** Shots fired this match (end-game accuracy + summary). */
  shotsFired: number;
  /** Shots that connected with at least one victim. */
  shotsHit: number;
  /** Highest multiplier reached this match. */
  bestCombo: number;
  /** Move-speed multiplier granted by a combo spree (1 = normal). */
  speedMult: number;
  /** Seconds left on the spree speed boost. */
  spreeTimer: number;
  /** Current weapon kickback in world units, applied opposite to facing. */
  recoil: number;
  /** Co-op downed state: ghost at the death spot, waiting for the revive. */
  downed: boolean;
  /** Seconds left on the passive co-op revive countdown (only while `downed`). */
  reviveTimer: number;
  /** Continuous seconds a partner has held inside the active revive circle. */
  reviveHold: number;
  /** Seconds of post-revive invulnerability left (fast flashing). */
  invulnTimer: number;
  /** Blink accumulator driving the downed / invulnerable flashing. */
  blinkTimer: number;
  /**
   * Black Devil "Curse" (co-op): true while a shockwave-inflicted curse is
   * active. Set from the server mirror online, from the offline AI locally.
   * A cursed player bleeds ticking damage until a teammate stands in their
   * cleansing circle for 3 s.
   */
  cursed: boolean;
  /** Cleanse hold progress (0..1) — drives the ground-circle indicator. */
  cleanseProgress: number;
  /**
   * Offline-only curse runtime (tick clock + cleanse hold). Null when not
   * cursed; the server owns this state entirely in an online match.
   */
  curse: CurseState | null;
  mesh: THREE.Group;
}

export function createPlayer(
  scene: THREE.Scene,
  index: number,
  character: CharacterId,
  start: { x: number; z: number }
): Player {
  const mesh = buildBoxhead(CHARACTERS[character]);
  mesh.position.set(start.x, 0, start.z);
  scene.add(mesh);
  return {
    index,
    character,
    x: start.x,
    z: start.z,
    hp: PLAYER_MAX_HP,
    alive: true,
    weapon: WeaponId.Pistol,
    ammo: new Map(),
    granted: new Set(),
    lastFireMs: Number.NEGATIVE_INFINITY,
    _lastWeaponId: WeaponId.Pistol,
    aimX: 1,
    aimZ: 0,
    facing: 0,
    mult: BASE_MULTIPLIER,
    comboTimer: comboWindowSeconds(),
    powerTimer: 0,
    kills: 0,
    shotsFired: 0,
    shotsHit: 0,
    bestCombo: BASE_MULTIPLIER,
    speedMult: 1,
    spreeTimer: 0,
    recoil: 0,
    downed: false,
    reviveTimer: 0,
    reviveHold: 0,
    invulnTimer: 0,
    blinkTimer: 0,
    cursed: false,
    cleanseProgress: 0,
    curse: null,
    mesh,
  };
}

export function removePlayerMesh(scene: THREE.Scene, player: Player): void {
  scene.remove(player.mesh);
}

/** Moves the player by a normalized (dx, dz) intent, resolving wall contact. */
export function movePlayer(
  player: Player,
  dx: number,
  dz: number,
  grid: GridMap,
  dt: number
): boolean {
  if (dx === 0 && dz === 0) return false;
  const length = Math.hypot(dx, dz);
  const speed = PLAYER_SPEED * player.speedMult; // spree boost scales this
  const nx = player.x + (dx / length) * speed * dt;
  const nz = player.z + (dz / length) * speed * dt;
  const resolved = grid.resolveCircle(nx, nz, PLAYER_RADIUS);
  player.x = resolved.x;
  player.z = resolved.z;
  return true;
}

/** Sets aim/facing from a movement vector (keyboard-only 8-way modes).
 * Preserves last facing when stationary.
 */
export function setAimDirection(player: Player, dx: number, dz: number): void {
  const length = Math.hypot(dx, dz);
  if (length < 1e-6) return; // stationary: preserve last facing
  player.aimX = dx / length;
  player.aimZ = dz / length;
  player.facing = Math.atan2(player.aimX, player.aimZ);
}

/** Records a recoil kick (world units); larger values win so rapid fire stacks up. */
export function applyRecoil(player: Player, amount: number): void {
  player.recoil = Math.max(player.recoil, amount);
}

/** Eases the recoil kick back to rest. */
export function decayRecoil(player: Player, dt: number): void {
  if (player.recoil <= 0) return;
  player.recoil = Math.max(0, player.recoil - RECOIL_RECOVERY * dt);
}

/**
 * Keeps the mesh in sync with simulation state, translating the whole actor
 * backwards along its facing by the lingering recoil kick.
 */
export function syncActor(player: Player): void {
  player.mesh.position.set(
    player.x - player.aimX * player.recoil,
    0,
    player.z - player.aimZ * player.recoil
  );
  player.mesh.rotation.y = player.facing;
}

// ---------------------------------------------------------------------------
// Combo multiplier
// ---------------------------------------------------------------------------

export function registerKill(player: Player): void {
  player.mult = multiplierAfterKill(player.mult);
  player.comboTimer = comboWindowSeconds(); // every kill refreshes the hold window
  if (player.mult > player.bestCombo) player.bestCombo = player.mult;
}

/**
 * Advances the hold window. Unlike a per-tier decay, the classic Boxhead rule
 * is all-or-nothing: if `comboWindowSeconds` lapses with no kill, the whole
 * chain drops straight back to ×1.
 */
export function comboTick(player: Player, dt: number): void {
  if (player.mult <= BASE_MULTIPLIER) return;
  player.comboTimer -= dt;
  if (player.comboTimer <= 0) {
    player.mult = resetMultiplier();
    player.comboTimer = comboWindowSeconds();
  }
}

/** Taking damage resets the streak. */
export function comboReset(player: Player): void {
  player.mult = resetMultiplier();
  player.comboTimer = comboWindowSeconds();
}

// ---------------------------------------------------------------------------
// Weapon selection (gated by multiplier)
// ---------------------------------------------------------------------------

/** A weapon is usable when the multiplier unlocks it OR a pickup granted it. */
export function isWeaponAvailable(player: Player, weaponId: number): boolean {
  return player.granted.has(weaponId) || isUnlockedByMultiplier(weaponId, player.mult);
}

/** Unlocks a weapon via pickup (survives a multiplier drop). */
export function grantWeapon(player: Player, weaponId: number): void {
  player.granted.add(weaponId);
}

/** Restores a living player to full health (wave-completion refill). */
export function healToFull(player: Player): void {
  if (!player.alive) return;
  player.hp = PLAYER_MAX_HP;
}

export function unlockedWeaponIds(player: Player): number[] {
  return WEAPONS.filter((def) => isWeaponAvailable(player, def.id)).map((def) => def.id);
}

/** Cycles through currently unavailable weapons (wraps around). */
export function cycleWeapon(player: Player, delta: number): void {
  if (delta === 0) return;
  const available = unlockedWeaponIds(player);
  const current = available.indexOf(player.weapon);
  if (current === -1) {
    player.weapon = WeaponId.Pistol;
    return;
  }
  const next = (((current + delta) % available.length) + available.length) % available.length;
  player.weapon = available[next];
}

/** Direct digit-slot pick; silently ignored when still locked. */
export function selectSlot(player: Player, slot: number): void {
  if (slot < 0 || slot >= WEAPONS.length) return;
  if (isWeaponAvailable(player, slot)) player.weapon = slot;
}

/** Drops to the pistol when the weapon is neither unlocked nor granted. */
export function ensureWeaponUnlocked(player: Player): number {
  if (!isWeaponAvailable(player, player.weapon)) {
    player.weapon = WeaponId.Pistol;
  }
  return player.weapon;
}

// ---------------------------------------------------------------------------
// Hitscan
// ---------------------------------------------------------------------------

export interface TargetBody {
  x: number;
  z: number;
  radius: number;
}

export interface HitscanHit {
  /** Index into the targets array the shooter passed in. */
  index: number;
  damage: number;
}

export interface PelletEnd {
  x: number;
  z: number;
  /** The pellet died on a wall face (blocks the shot) rather than on a victim. */
  hitWall: boolean;
}

export interface HitscanResult {
  hits: HitscanHit[];
  /** Endpoint of the first pellet (tracer visuals). */
  endX: number;
  endZ: number;
  /** One endpoint per pellet, for multi-ray weapon visuals (shotgun). */
  pellets: PelletEnd[];
}

interface Candidate {
  index: number;
  distance: number;
}

/**
 * Resolves `def.pelletCount` rays with spread against `targets`.
 *
 * A pellet stops at the first blocked grid cell it meets — walls are opaque and
 * bullets never pass through them — so only victims in front of that wall are
 * hittable. Each pellet hits at most one victim unless the weapon pierces
 * (railgun). `aimX/aimZ` must be normalized.
 *
 * Inside `closeRangeThreshold` a pellet deals its flat `closeRangeDamage` with
 * no falloff, which is what makes a point-blank shotgun blast a one-shot kill.
 */
export function fireHitscan(
  originX: number,
  originZ: number,
  aimX: number,
  aimZ: number,
  def: WeaponDef,
  targets: readonly TargetBody[],
  grid: GridMap,
  random: () => number = Math.random
): HitscanResult {
  const hits: HitscanHit[] = [];
  const pellets: PelletEnd[] = [];
  let endX = originX + aimX * def.maxRange;
  let endZ = originZ + aimZ * def.maxRange;

  for (let pellet = 0; pellet < def.pelletCount; pellet++) {
    const angle = (random() * 2 - 1) * def.spread;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = aimX * cos - aimZ * sin;
    const dz = aimX * sin + aimZ * cos;

    // the wall this pellet meets caps its reach: no shooting through walls
    const wallDistance = grid.raycastDistance(originX, originZ, dx, dz, def.maxRange);
    const reach = Math.min(def.maxRange, wallDistance);

    const candidates: Candidate[] = [];
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const offsetX = target.x - originX;
      const offsetZ = target.z - originZ;
      const distance = dx * offsetX + dz * offsetZ;
      if (distance <= 0 || distance > reach) continue; // behind the wall / out of range
      const distanceSq = offsetX * offsetX + offsetZ * offsetZ;
      const perpendicularSq = distanceSq - distance * distance;
      if (perpendicularSq > target.radius * target.radius) continue;
      candidates.push({ index: i, distance });
    }
    candidates.sort((a, b) => a.distance - b.distance);

    let pelletEndX = originX + dx * reach;
    let pelletEndZ = originZ + dz * reach;
    let firstHit = true;

    for (const candidate of candidates) {
      const close = def.closeRangeDamage > 0 && candidate.distance <= def.closeRangeThreshold;
      // point blank: flat close-range damage. Otherwise damage falls off with
      // distance travelled (aggressive on the shotgun).
      const falloff =
        !close && def.maxRange > 0 ? Math.min(1, candidate.distance / def.maxRange) : 0;
      const base = close ? def.closeRangeDamage : def.damage;
      hits.push({ index: candidate.index, damage: base * (1 - def.damageFalloff * falloff) });
      if (firstHit) {
        pelletEndX = targets[candidate.index].x;
        pelletEndZ = targets[candidate.index].z;
        firstHit = false;
      }
      if (!def.pierce) break;
    }

    pellets.push({ x: pelletEndX, z: pelletEndZ, hitWall: wallDistance < def.maxRange });
    if (pellet === 0) {
      endX = pelletEndX;
      endZ = pelletEndZ;
    }
  }

  return { hits, endX, endZ, pellets };
}
