/**
 * Horde: boxhead zombies steered by the shared flow field toward *all* living
 * players, plus the ranged Devil boss (homing fireballs, suppressible by
 * rapid fire) and the wave director.
 *
 * AI runs client-side in Phase 1; Phase 5 moves this same code to the server.
 */
import * as THREE from 'three';

import { GridMap } from '../../../shared/src/grid.ts';
import { computeFlowField, sampleFlow } from '../../../shared/src/flowfield.ts';
import type { FlowField } from '../../../shared/src/flowfield.ts';
import { BLACK_DEVIL_SCALE, DEVIL_SCALE, buildBlackDevil, buildDevil, buildZombie } from './actors.ts';
import type { Player } from './player.ts';
import {
  BARRICADE_MELEE_DAMAGE,
  barricadeAt,
  cellInFront,
  damageBarricade,
} from './barricades.ts';
import type { Barricade } from './barricades.ts';
import { spawnFireball, spawnSpinner } from './projectiles.ts';
import type { Projectile } from './projectiles.ts';
import {
  BLACK_DEVIL_MIN_WAVE,
  DIRECTOR_CONFIG,
  ENEMY_CONFIG,
  PLAYER_CONFIG,
  WAVE_EVENT_CONFIG,
} from '../../../shared/src/balance.config.ts';
import { waveEventFor } from '../../../shared/src/waveEvents.ts';
import type { WaveEventKind } from '../../../shared/src/waveEvents.ts';
import {
  advanceShockwaveRing,
  createShockwaveRing,
  ringSweepHitsCircle,
} from '../../../shared/src/shockwave.ts';
import type { ShockwaveRing } from '../../../shared/src/shockwave.ts';
import { stepAngleToward } from '../../../shared/src/steering.ts';
import { canApplyCurse, createCurseState } from '../../../shared/src/curse.ts';
import { SpatialHash } from './spatialHash.ts';

export type ZombieKind = 'walker' | 'runner' | 'devil' | 'blackDevil';

export interface ZombieStats {
  hp: number;
  speed: number;
  damage: number;
  radius: number;
  score: number;
}

// Enemy tuning lives in `shared/src/balance.config.ts` (ENEMY_CONFIG).
export const ZOMBIE_STATS: Record<ZombieKind, ZombieStats> = ENEMY_CONFIG;

export const ATTACK_RANGE = ENEMY_CONFIG.attackRange;
export const ATTACK_COOLDOWN_MS = ENEMY_CONFIG.attackCooldown * 1000;
export const WALL_ATTACK_INTERVAL = ENEMY_CONFIG.wallAttackInterval;
export const DEVIL_FIRE_INTERVAL = ENEMY_CONFIG.devilFireInterval;
export const DEVIL_FIRE_RANGE_MIN = ENEMY_CONFIG.devilFireRangeMin;
export const DEVIL_FIRE_RANGE_MAX = ENEMY_CONFIG.devilFireRangeMax;
/** Hits from weapons at or below this rate-of-fire suppress devil attacks. */
export const RAPID_FIRE_INTERVAL_MS = ENEMY_CONFIG.rapidFireIntervalMs;
export const SUPPRESS_DURATION = ENEMY_CONFIG.suppressDuration;
/** Wave-7 boss tuning (single source: shared/src/balance.config.ts). */
export const BLACK_DEVIL = ENEMY_CONFIG.blackDevil;

export interface Zombie {
  kind: ZombieKind;
  hp: number;
  maxHp: number;
  x: number;
  z: number;
  radius: number;
  speed: number;
  damage: number;
  score: number;
  attackCooldown: number;
  wallTimer: number;
  fireCooldown: number;
  suppressTimer: number;
  mesh: THREE.Group;
  alive: boolean;
  /** True while the end-of-wave enrage is active (1.75× speed, direct chase). */
  enraged: boolean;
  /** Devil only: true once the phase-2 enrage (≤50% HP) has triggered. */
  phase2: boolean;
  /** Devil dash state machine. */
  dashState: 'idle' | 'windup' | 'dash';
  /** Cooldown (idle) or phase countdown (windup / dash). */
  dashTimer: number;
  /** Heading locked in at the end of the wind-up. */
  dashDirX: number;
  dashDirZ: number;
  /** Countdown to the next trail patch while dashing. */
  hazTimer: number;
  /** Pulse clock driving the rage light / flame animation. */
  ragePulse: number;
  /**
   * Black Devil attack state: 'idle' | 'charge' (1 s laser telegraph) |
   * 'fire' (3.5 s beam channel). While charge/fire the boss stands still and
   * every other attack is disabled. Mirrored from the server when online.
   */
  attackState: 'idle' | 'charge' | 'fire';
  /** Countdown within the active laser phase (telegraph or channel). */
  attackTimer: number;
  /** Seconds until the next laser telegraph. */
  laserCooldown: number;
  /** Beam aim direction (unit vector), ramped with rotational inertia. */
  laserDirX: number;
  laserDirZ: number;
  /** Player the current beam is locked onto (null when idle). */
  laserTarget: Player | null;
  /** Countdown to the next beam damage tick. */
  laserTick: number;
  /**
   * Beam reach (world units) after the continuous raycast clamps it at the
   * first wall / crate. The render stops here and beam damage only applies to
   * victims in front of that hit point. Mirrored from the server when online.
   */
  laserLength: number;
  /** Seconds until the next radial shockwave is allowed (strict 4.5 s). */
  shockCooldown: number;
  /**
   * Online mode only: the server-reported facing the mesh eases toward. Unset
   * in local play, where the AI writes the mesh rotation directly.
   */
  dirTarget?: number;
}

/**
 * A live offline shockwave ring: the same expanding annulus the server runs,
 * plus the set of player indices it has already resolved (each body is hit — or
 * spared by cover — at most once per wave).
 */
export interface ActiveShockwave extends ShockwaveRing {
  resolved: Set<number>;
}

/** A lingering fiery floor patch left behind by a phase-2 Devil dash. */
export interface Hazard {
  x: number;
  z: number;
  radius: number;
  /** Damage dealt to a player per tick while standing inside. */
  damage: number;
  life: number;
  maxLife: number;
  /** Countdown to the next damage tick. */
  tick: number;
  mesh: THREE.Mesh;
}

export interface Horde {
  zombies: Zombie[];
  field: FlowField | null;
  fieldTimer: number;
  /** Fiery floor patches left by phase-2 Devil dashes. */
  hazards: Hazard[];
  /** Live expanding Black Devil shockwave rings. */
  shockwaves: ActiveShockwave[];
}

export interface HordeUpdateContext {
  dt: number;
  players: readonly Player[];
  grid: GridMap;
  barricades: Barricade[];
  scene: THREE.Scene;
  projectiles: Projectile[];
}

export function createHorde(): Horde {
  return { zombies: [], field: null, fieldTimer: 0, hazards: [], shockwaves: [] };
}

/** Shared floor-plane geometry for hazard patches (never disposed). */
const HAZARD_GEOMETRY = new THREE.PlaneGeometry(1, 1);

/** Drops a fiery hazard patch at a world position (safety-capped). */
function dropHazard(horde: Horde, scene: THREE.Scene, x: number, z: number): void {
  if (horde.hazards.length >= 64) return;
  const radius = ENEMY_CONFIG.devilTrailRadius;
  const mesh = new THREE.Mesh(
    HAZARD_GEOMETRY,
    new THREE.MeshBasicMaterial({ color: 0xff5a12, transparent: true, opacity: 0.5, depthWrite: false })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, 0.04, z);
  mesh.scale.setScalar(radius * 2);
  scene.add(mesh);
  horde.hazards.push({
    x,
    z,
    radius,
    damage: ENEMY_CONFIG.devilTrailDamage,
    life: ENEMY_CONFIG.devilTrailLife,
    maxLife: ENEMY_CONFIG.devilTrailLife,
    tick: ENEMY_CONFIG.devilTrailTick,
    mesh,
  });
}

/** Ages hazard patches, ticks their damage, and removes expired ones. */
function updateHazards(
  horde: Horde,
  scene: THREE.Scene,
  dt: number,
  players: readonly Player[],
  damage: number[]
): void {
  for (let i = horde.hazards.length - 1; i >= 0; i--) {
    const hazard = horde.hazards[i];
    hazard.life -= dt;
    if (hazard.life <= 0) {
      scene.remove(hazard.mesh);
      (hazard.mesh.material as THREE.Material).dispose(); // per-instance tint material
      horde.hazards.splice(i, 1);
      continue;
    }
    (hazard.mesh.material as THREE.MeshBasicMaterial).opacity =
      0.5 * Math.min(1, (hazard.life / hazard.maxLife) * 2);
    hazard.tick -= dt;
    if (hazard.tick > 0) continue;
    hazard.tick = ENEMY_CONFIG.devilTrailTick;
    for (let p = 0; p < players.length; p++) {
      const player = players[p];
      if (!player.alive) continue;
      if (Math.hypot(player.x - hazard.x, player.z - hazard.z) <= hazard.radius + 0.2) {
        damage[p] += hazard.damage;
      }
    }
  }
}

/** Drives the phase-2 rage visuals (pulsing light + burning flame crown). */
function updateDevilRage(zombie: Zombie, dt: number): void {
  const light = zombie.mesh.userData.rageLight as THREE.PointLight | undefined;
  const flames = zombie.mesh.userData.rageFlames as THREE.Group | undefined;
  if (!zombie.phase2) {
    if (light) light.intensity = 0;
    if (flames) flames.visible = false;
    return;
  }
  zombie.ragePulse += dt;
  if (light) light.intensity = 2.0 + Math.sin(zombie.ragePulse * 9) * 0.8;
  if (flames) {
    flames.visible = true;
    flames.rotation.y += dt * 3.5;
    flames.scale.setScalar(0.9 + Math.sin(zombie.ragePulse * 14) * 0.25);
  }
  zombie.mesh.scale.setScalar(1.25); // visibly swollen while enraged
}

/**
 * Broadphase scratch state for the separation pass. The hash is rebuilt every
 * frame and the neighbour array is reused, so the flocking term allocates
 * nothing — only the O(n·neighbours) checks run.
 */
const SEPARATION_HASH = new SpatialHash<Zombie>();
const SEPARATION_NEIGHBORS: Zombie[] = [];
/** Largest possible separation radius: two Devil bodies just touching. */
const MAX_SEPARATION_RADIUS = ENEMY_CONFIG.devil.radius * 2;

/**
 * Pushes a zombie out of a player's body so the player is a rigid, impenetrable
 * collider (ARCHITECTURE.md §1.2). When the two overlap, the enemy is pushed
 * along `(enemyPos - playerPos).normalize()` by the full overlap amount, then
 * re-resolved against the walls so it can never be shoved through one.
 * Returns the corrected position (or the input when there is no overlap).
 */
function separateFromPlayer(
  zombie: Zombie,
  player: Player,
  grid: GridMap
): { x: number; z: number; separated: boolean } {
  if (!player.alive) return { x: zombie.x, z: zombie.z, separated: false };
  const offsetX = zombie.x - player.x;
  const offsetZ = zombie.z - player.z;
  const minDistance = PLAYER_CONFIG.radius + zombie.radius;
  const distanceSq = offsetX * offsetX + offsetZ * offsetZ;
  if (distanceSq >= minDistance * minDistance) {
    return { x: zombie.x, z: zombie.z, separated: false };
  }

  let normalX: number;
  let normalZ: number;
  let distance: number;
  if (distanceSq > 1e-9) {
    distance = Math.sqrt(distanceSq);
    normalX = offsetX / distance;
    normalZ = offsetZ / distance;
  } else {
    // Exactly concentric (a teleport/spawn on top of the player): pick a stable
    // escape axis so the pair always resolves instead of dividing by zero.
    distance = 0;
    normalX = 1;
    normalZ = 0;
  }
  const overlap = minDistance - distance;
  const resolved = grid.resolveCircle(
    zombie.x + normalX * overlap,
    zombie.z + normalZ * overlap,
    zombie.radius
  );
  return { x: resolved.x, z: resolved.z, separated: true };
}

export function spawnZombie(
  horde: Horde,
  scene: THREE.Scene,
  kind: ZombieKind,
  x: number,
  z: number
): Zombie {
  const stats = ZOMBIE_STATS[kind];
  const mesh =
    kind === 'devil' ? buildDevil() : kind === 'blackDevil' ? buildBlackDevil() : buildZombie();
  if (kind === 'devil') mesh.scale.setScalar(DEVIL_SCALE);
  else if (kind === 'blackDevil') mesh.scale.setScalar(BLACK_DEVIL_SCALE);
  mesh.position.set(x, 0, z);
  scene.add(mesh);

  const zombie: Zombie = {
    kind,
    hp: stats.hp,
    maxHp: stats.hp,
    x,
    z,
    radius: stats.radius,
    speed: stats.speed,
    damage: stats.damage,
    score: stats.score,
    attackCooldown: 0,
    wallTimer: 0,
    fireCooldown: DEVIL_FIRE_INTERVAL * (0.4 + Math.random() * 0.6),
    suppressTimer: 0,
    mesh,
    alive: true,
    enraged: false,
    phase2: false,
    dashState: 'idle',
    dashTimer: ENEMY_CONFIG.devilDashInterval,
    dashDirX: 0,
    dashDirZ: -1,
    hazTimer: 0,
    ragePulse: 0,
    attackState: 'idle',
    attackTimer: 0,
    laserCooldown: BLACK_DEVIL.laserCooldown * (0.5 + Math.random() * 0.5),
    laserDirX: 0,
    laserDirZ: -1,
    laserTarget: null,
    laserTick: 0,
    laserLength: BLACK_DEVIL.laserRange,
    shockCooldown: 0,
  };
  horde.zombies.push(zombie);
  return zombie;
}

export function removeZombie(horde: Horde, scene: THREE.Scene, zombie: Zombie): void {
  zombie.alive = false;
  // Mesh parts use shared cached geometry/material (see actors.ts) — a plain
  // remove releases the JS objects; the GPU resources live on for the next spawn.
  scene.remove(zombie.mesh);
  const index = horde.zombies.indexOf(zombie);
  if (index !== -1) horde.zombies.splice(index, 1);
}

/** Rapid-fire hits interrupt/suppress a devil's fireball attack. */
export function applySuppression(zombie: Zombie, seconds: number): void {
  if (zombie.kind !== 'devil') return;
  zombie.suppressTimer = Math.max(zombie.suppressTimer, seconds);
}

function nearestAlivePlayer(
  players: readonly Player[],
  x: number,
  z: number
): Player | null {
  let best: Player | null = null;
  let bestDistance = Infinity;
  for (const player of players) {
    if (!player.alive) continue;
    const distance = Math.hypot(player.x - x, player.z - z);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = player;
    }
  }
  return best;
}

function refreshField(horde: Horde, ctx: HordeUpdateContext): void {
  horde.fieldTimer -= ctx.dt;
  if (horde.fieldTimer > 0) return;

  const goals: { cx: number; cz: number }[] = [];
  for (const player of ctx.players) {
    if (!player.alive) continue;
    const cx = ctx.grid.cellX(player.x);
    const cz = ctx.grid.cellZ(player.z);
    if (!ctx.grid.inBounds(cx, cz) || ctx.grid.isBlockedCell(cx, cz)) continue;
    if (!goals.some((goal) => goal.cx === cx && goal.cz === cz)) goals.push({ cx, cz });
  }
  if (goals.length > 0) {
    horde.field = computeFlowField(ctx.grid, goals);
    horde.fieldTimer = 0.25;
  }
}

export interface HordeEvents {
  /** Damage dealt to each player, index-aligned with ctx.players. */
  playerDamage: number[];
  /** Barrels chewed to destruction this frame — main.ts detonates these. */
  destroyedBarrels: { x: number; z: number }[];
  /** Radial shockwaves fired this frame — main.ts plays the ring + shake. */
  shockwaves: { x: number; z: number; radius: number; speed: number }[];
}

/**
 * One frame of horde AI. Returns damage dealt to each player plus any barrels
 * the horde destroyed (index-aligned with ctx.players).
 */
export function updateHorde(horde: Horde, ctx: HordeUpdateContext): HordeEvents {
  const damage = ctx.players.map(() => 0);
  const destroyedBarrels: { x: number; z: number }[] = [];
  const shockwaves: { x: number; z: number; radius: number; speed: number }[] = [];
  const { dt, grid, players, barricades, scene, projectiles } = ctx;
  refreshField(horde, ctx);
  const field = horde.field;
  const zombies = horde.zombies;

  // End-of-wave ENRAGE: once the wave is nearly cleared the survivors sprint
  // (1.75× speed) straight at the nearest player, so there is no downtime.
  let aliveCount = 0;
  for (const zombie of zombies) if (zombie.alive) aliveCount++;
  const enraged = aliveCount > 0 && aliveCount <= DIRECTOR_CONFIG.enrageThreshold;

  // Rebuild the spatial hash broadphase used by the separation term below.
  SEPARATION_HASH.clear();
  for (const zombie of zombies) if (zombie.alive) SEPARATION_HASH.insert(zombie);

  for (let i = 0; i < zombies.length; i++) {
    const zombie = zombies[i];
    if (!zombie.alive) continue;
    zombie.enraged = enraged;
    if (zombie.attackCooldown > 0) zombie.attackCooldown -= dt;
    if (zombie.wallTimer > 0) zombie.wallTimer -= dt;

    const target = nearestAlivePlayer(players, zombie.x, zombie.z);
    if (!target) continue;

    const toTargetX = target.x - zombie.x;
    const toTargetZ = target.z - zombie.z;
    const distanceToTarget = Math.hypot(toTargetX, toTargetZ);

    let dirX = 0;
    let dirZ = 0;
    /** Wind-up freezes the boss in place; dash scales its speed up. */
    let frozen = false;
    let speedScale = 1;

    if (zombie.kind === 'blackDevil') {
      zombie.mesh.rotation.y = Math.atan2(toTargetX, toTargetZ);

      if (zombie.attackState === 'charge') {
        // Attack 3, telegraph: hold still and paint an aim line on the target.
        frozen = true;
        zombie.attackTimer -= dt;
        const locked = zombie.laserTarget && zombie.laserTarget.alive ? zombie.laserTarget : target;
        const ldx = locked.x - zombie.x;
        const ldz = locked.z - zombie.z;
        const len = Math.hypot(ldx, ldz) || 1;
        zombie.laserDirX = ldx / len;
        zombie.laserDirZ = ldz / len;
        // Continuous raycast: the telegraph stops at the first wall / crate.
        zombie.laserLength = grid.raycastDistance(
          zombie.x,
          zombie.z,
          zombie.laserDirX,
          zombie.laserDirZ,
          BLACK_DEVIL.laserRange
        );
        if (zombie.attackTimer <= 0) {
          zombie.attackState = 'fire';
          zombie.attackTimer = BLACK_DEVIL.laserDuration;
          zombie.laserTick = 0;
        }
      } else if (zombie.attackState === 'fire') {
        // Attack 3, beam: hold still, track with rotational inertia and tick.
        frozen = true;
        zombie.attackTimer -= dt;
        const locked = zombie.laserTarget && zombie.laserTarget.alive ? zombie.laserTarget : target;
        const desired = Math.atan2(locked.z - zombie.z, locked.x - zombie.x);
        let delta = desired - Math.atan2(zombie.laserDirZ, zombie.laserDirX);
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        const maxTurn = BLACK_DEVIL.laserTurnRate * dt;
        const angle =
          Math.atan2(zombie.laserDirZ, zombie.laserDirX) +
          Math.max(-maxTurn, Math.min(maxTurn, delta));
        zombie.laserDirX = Math.cos(angle);
        zombie.laserDirZ = Math.sin(angle);
        // Re-clamp the beam each tick so it stops at whatever now blocks it.
        zombie.laserLength = grid.raycastDistance(
          zombie.x,
          zombie.z,
          zombie.laserDirX,
          zombie.laserDirZ,
          BLACK_DEVIL.laserRange
        );
        zombie.laserTick -= dt;
        if (zombie.laserTick <= 0) {
          zombie.laserTick = BLACK_DEVIL.laserTickInterval;
          for (const player of players) {
            if (!player.alive) continue;
            const ox = player.x - zombie.x;
            const oz = player.z - zombie.z;
            const along = ox * zombie.laserDirX + oz * zombie.laserDirZ;
            if (along < 0 || along > zombie.laserLength) continue;
            const perpendicular = Math.abs(ox * zombie.laserDirZ - oz * zombie.laserDirX);
            if (perpendicular > BLACK_DEVIL.laserHalfWidth + PLAYER_CONFIG.radius) continue;
            if (!grid.lineOfSight(zombie.x, zombie.z, player.x, player.z)) continue;
            damage[player.index] += BLACK_DEVIL.laserDamage;
          }
        }
        if (zombie.attackTimer <= 0) {
          zombie.attackState = 'idle';
          zombie.attackTimer = 0;
          zombie.laserCooldown = BLACK_DEVIL.laserCooldown;
          zombie.laserDirX = 0;
          zombie.laserDirZ = 0;
          zombie.laserTarget = null;
        }
      } else {
        // Idle: hold the ranged band, defend with the shockwave, then pick
        // between the laser wind-up and a spinner volley.
        if (distanceToTarget > BLACK_DEVIL.spinnerRangeMax) {
          dirX = toTargetX / Math.max(distanceToTarget, 1e-6);
          dirZ = toTargetZ / Math.max(distanceToTarget, 1e-6);
        } else if (distanceToTarget < BLACK_DEVIL.spinnerRangeMin) {
          dirX = -toTargetX / Math.max(distanceToTarget, 1e-6);
          dirZ = -toTargetZ / Math.max(distanceToTarget, 1e-6);
        }
        if (zombie.shockCooldown > 0) zombie.shockCooldown -= dt;
        if (zombie.laserCooldown > 0) zombie.laserCooldown -= dt;
        zombie.fireCooldown -= dt;

        const crowded = players.some(
          (player) =>
            player.alive &&
            Math.hypot(player.x - zombie.x, player.z - zombie.z) <=
              BLACK_DEVIL.shockwaveTriggerRange
        );
        if (crowded && zombie.shockCooldown <= 0) {
          // Spawn a physical expanding ring (not instant radius damage): its
          // perimeter sweeps the players' bodies over the next few frames.
          horde.shockwaves.push({
            ...createShockwaveRing(
              zombie.x,
              zombie.z,
              BLACK_DEVIL.shockwaveRadius,
              BLACK_DEVIL.shockwaveRingThickness,
              BLACK_DEVIL.shockwaveExpansionSpeed
            ),
            resolved: new Set<number>(),
          });
          shockwaves.push({
            x: zombie.x,
            z: zombie.z,
            radius: BLACK_DEVIL.shockwaveRadius,
            speed: BLACK_DEVIL.shockwaveExpansionSpeed,
          });
          zombie.shockCooldown = BLACK_DEVIL.shockwaveCooldown;
        }

        const hasSight = grid.lineOfSight(zombie.x, zombie.z, target.x, target.z);
        if (zombie.laserCooldown <= 0 && distanceToTarget <= BLACK_DEVIL.laserRange && hasSight) {
          zombie.attackState = 'charge';
          zombie.attackTimer = BLACK_DEVIL.laserTelegraph;
          zombie.laserTarget = target;
          zombie.laserDirX = toTargetX / Math.max(distanceToTarget, 1e-6);
          zombie.laserDirZ = toTargetZ / Math.max(distanceToTarget, 1e-6);
          zombie.laserLength = grid.raycastDistance(
            zombie.x,
            zombie.z,
            zombie.laserDirX,
            zombie.laserDirZ,
            BLACK_DEVIL.laserRange
          );
        } else if (
          zombie.fireCooldown <= 0 &&
          distanceToTarget <= BLACK_DEVIL.spinnerRangeMax &&
          hasSight
        ) {
          const angle = Math.atan2(target.z - zombie.z, target.x - zombie.x);
          spawnSpinner(scene, projectiles, zombie.x, zombie.z, angle); // Attack 1
          zombie.fireCooldown = BLACK_DEVIL.spinnerInterval;
        }
      }
    } else if (zombie.kind === 'devil') {
      // Phase 2 triggers once HP drops to the configured fraction (~one grenade).
      if (!zombie.phase2 && zombie.hp <= zombie.maxHp * ENEMY_CONFIG.devilPhase2HpFraction) {
        zombie.phase2 = true;
      }
      updateDevilRage(zombie, dt);

      zombie.suppressTimer -= dt;
      zombie.fireCooldown -= dt;
      zombie.mesh.rotation.y = Math.atan2(toTargetX, toTargetZ);

      if (zombie.phase2 && zombie.dashState === 'windup') {
        // Telegraph: stand still for the wind-up, then commit to the charge
        // (whose heading then homes after the player's live position).
        frozen = true;
        zombie.dashTimer -= dt;
        if (zombie.dashTimer <= 0) {
          zombie.dashState = 'dash';
          zombie.dashTimer = ENEMY_CONFIG.devilDashDuration;
          zombie.hazTimer = 0;
        }
      } else if (zombie.phase2 && zombie.dashState === 'dash') {
        // Homing charge: steer the committed heading toward the target's LIVE
        // position with a bounded turn rate, so the Devil curves after its
        // prey and drips fire along that real path instead of flying straight
        // past a frozen aim point. `target` is already the nearest living
        // player, so in co-op it hunts whoever is closest right now.
        const current = Math.atan2(zombie.dashDirX, zombie.dashDirZ);
        const desired = Math.atan2(toTargetX, toTargetZ);
        const steered = stepAngleToward(current, desired, ENEMY_CONFIG.devilDashTurnRate * dt);
        zombie.dashDirX = Math.sin(steered);
        zombie.dashDirZ = Math.cos(steered);
        dirX = zombie.dashDirX;
        dirZ = zombie.dashDirZ;
        speedScale = ENEMY_CONFIG.devilDashSpeedMultiplier;
        zombie.dashTimer -= dt;
        zombie.hazTimer -= dt;
        if (zombie.hazTimer <= 0) {
          dropHazard(horde, scene, zombie.x, zombie.z);
          zombie.hazTimer = ENEMY_CONFIG.devilTrailDropInterval;
        }
        if (zombie.dashTimer <= 0) {
          zombie.dashState = 'idle';
          zombie.dashTimer = ENEMY_CONFIG.devilDashInterval;
        }
      } else {
        // ranged stance: close in beyond ~11, back off inside ~7, otherwise hold
        if (distanceToTarget > DEVIL_FIRE_RANGE_MAX) {
          dirX = toTargetX / Math.max(distanceToTarget, 1e-6);
          dirZ = toTargetZ / Math.max(distanceToTarget, 1e-6);
        } else if (distanceToTarget < DEVIL_FIRE_RANGE_MIN) {
          dirX = -toTargetX / Math.max(distanceToTarget, 1e-6);
          dirZ = -toTargetZ / Math.max(distanceToTarget, 1e-6);
        }
        if (
          zombie.suppressTimer <= 0 &&
          zombie.fireCooldown <= 0 &&
          grid.lineOfSight(zombie.x, zombie.z, target.x, target.z)
        ) {
          const angle = Math.atan2(target.z - zombie.z, target.x - zombie.x);
          spawnFireball(scene, projectiles, zombie.x, zombie.z, angle);
          zombie.fireCooldown = DEVIL_FIRE_INTERVAL;
        }
        // Phase-2 charge cadence: wind up toward the player's current position.
        if (zombie.phase2) {
          zombie.dashTimer -= dt;
          if (zombie.dashTimer <= 0) {
            zombie.dashState = 'windup';
            zombie.dashTimer = ENEMY_CONFIG.devilDashWindup;
            const length = Math.max(distanceToTarget, 1e-6);
            zombie.dashDirX = toTargetX / length;
            zombie.dashDirZ = toTargetZ / length;
          }
        }
      }
    } else if (enraged) {
      // Enraged mobs ignore the flow field and beeline for the nearest player.
      const length = Math.max(distanceToTarget, 1e-6);
      dirX = toTargetX / length;
      dirZ = toTargetZ / length;
    } else if (field) {
      const flow = sampleFlow(grid, field, zombie.x, zombie.z);
      dirX = flow.x;
      dirZ = flow.z;
    }
    if (dirX === 0 && dirZ === 0) {
      // at the goal / unreachable / no field: go straight at the target
      const length = Math.max(distanceToTarget, 1e-6);
      dirX = toTargetX / length;
      dirZ = toTargetZ / length;
    }

    // local separation over nearby neighbours only — the spatial hash narrows
    // the old O(N²) sweep to a handful of candidates per zombie.
    let sepX = 0;
    let sepZ = 0;
    SEPARATION_HASH.query(zombie.x, zombie.z, MAX_SEPARATION_RADIUS, SEPARATION_NEIGHBORS);
    for (const other of SEPARATION_NEIGHBORS) {
      if (other === zombie || !other.alive) continue;
      const offsetX = zombie.x - other.x;
      const offsetZ = zombie.z - other.z;
      const distanceSq = offsetX * offsetX + offsetZ * offsetZ;
      const minDistance = zombie.radius + other.radius;
      if (distanceSq > 1e-9 && distanceSq < minDistance * minDistance) {
        const distance = Math.sqrt(distanceSq);
        sepX += offsetX / distance;
        sepZ += offsetZ / distance;
      }
    }
    dirX += sepX * 0.6;
    dirZ += sepZ * 0.6;

    const totalLength = Math.hypot(dirX, dirZ);
    if (!frozen && totalLength > 1e-6) {
      dirX /= totalLength;
      dirZ /= totalLength;
      const baseSpeed = enraged
        ? zombie.speed * DIRECTOR_CONFIG.enrageSpeedMultiplier
        : zombie.speed;
      const speed = baseSpeed * speedScale;
      const intended = speed * dt;
      const nextX = zombie.x + dirX * intended;
      const nextZ = zombie.z + dirZ * intended;
      const resolved = grid.resolveCircle(nextX, nextZ, zombie.radius);
      const moved = Math.hypot(resolved.x - zombie.x, resolved.z - zombie.z);
      zombie.x = resolved.x;
      zombie.z = resolved.z;
      zombie.mesh.rotation.y = Math.atan2(dirX, dirZ);
      zombie.mesh.position.set(zombie.x, 0, zombie.z);

      // pushed into a wall → chew the barricade in front, if any
      if (moved < intended * 0.5 && intended > 0) {
        const front = cellInFront(grid, zombie.x, zombie.z, dirX, dirZ);
        const barricade = barricadeAt(barricades, front.cx, front.cz);
        if (barricade && zombie.wallTimer <= 0) {
          zombie.wallTimer = WALL_ATTACK_INTERVAL;
          if (damageBarricade(grid, scene, barricades, barricade, BARRICADE_MELEE_DAMAGE)) {
            // Only an explosive barrel's destruction detonates — a wooden crate
            // just splinters away and reopens its cell.
            if (barricade.kind === 'barrel') {
              destroyedBarrels.push({ x: barricade.cx + 0.5, z: barricade.cz + 0.5 });
            }
          }
        }
      }
    }

    // rigid player collider: push this mob out of the player's body (and out of
    // any wall it was shoved into). The player is never moved.
    for (const player of players) {
      const separated = separateFromPlayer(zombie, player, grid);
      if (!separated.separated) continue;
      zombie.x = separated.x;
      zombie.z = separated.z;
      zombie.mesh.position.set(zombie.x, 0, zombie.z);
    }

    // melee contact (measured after separation so a pushed-out mob must still
    // close to biting range)
    const meleeDistance = Math.hypot(target.x - zombie.x, target.z - zombie.z);
    if (meleeDistance <= ATTACK_RANGE + zombie.radius * 0.5 && zombie.attackCooldown <= 0) {
      damage[target.index] += zombie.damage;
      zombie.attackCooldown = ATTACK_COOLDOWN_MS / 1000;
      // A charging Devil ends its rush the instant it lands the hit, then
      // falls back to its cooldown / normal chase speed (see balance.config).
      if (zombie.kind === 'devil' && zombie.dashState === 'dash') {
        zombie.dashState = 'idle';
        zombie.dashTimer = ENEMY_CONFIG.devilDashInterval;
      }
    }
  }

  // Fiery trail damage from phase-2 dashes.
  updateHazards(horde, scene, dt, players, damage);

  // Expand the Black Devil's shockwave rings and resolve their swept contacts.
  stepShockwaves(horde, grid, players, damage, dt);

  return { playerDamage: damage, destroyedBarrels, shockwaves };
}

/**
 * One frame of every live shockwave ring: grow the perimeter, then resolve each
 * living player the swept band touches — exactly once per ring.
 *
 * A victim takes the flat shockwave damage and is cursed *only* when the boss
 * has a clear line-of-sight ray to them: behind a wooden crate or wall the ray
 * is blocked, so the wave is occluded and the player is spared. Cover works.
 *
 * The impact damage always lands; the curse is additionally gated by the shared
 * strict guards (solo immunity, one curse at a time, respawn / revive window).
 */
function stepShockwaves(
  horde: Horde,
  grid: GridMap,
  players: readonly Player[],
  damage: number[],
  dt: number
): void {
  // Guards that hold for the whole frame: solo runs never curse, and while any
  // player is down (respawn timer or active revive) nobody may be cursed.
  const anyPlayerDowned = players.some((player) => !player.alive || player.reviveHold > 0);
  const holder = players.find((player) => player.cursed && player.alive);
  let activeCursedId = holder ? String(holder.index) : '';

  for (let i = horde.shockwaves.length - 1; i >= 0; i--) {
    const ring = horde.shockwaves[i];
    const { prevRadius } = advanceShockwaveRing(ring, dt);
    for (const player of players) {
      if (!player.alive || ring.resolved.has(player.index)) continue;
      if (
        !ringSweepHitsCircle(
          ring.x,
          ring.z,
          prevRadius,
          ring.radius,
          ring.halfThickness,
          player.x,
          player.z,
          PLAYER_CONFIG.radius
        )
      ) {
        continue;
      }
      ring.resolved.add(player.index);
      if (!grid.lineOfSight(ring.x, ring.z, player.x, player.z)) continue;
      damage[player.index] += BLACK_DEVIL.shockwaveDamage;
      // The wave landed: curse the victim only when the strict guards allow it.
      if (!player.curse && !player.cursed) {
        if (
          canApplyCurse({
            playerCount: players.length,
            activeCursedId,
            targetId: String(player.index),
            targetAlive: player.alive,
            anyPlayerDowned,
          })
        ) {
          player.curse = createCurseState();
          player.cursed = true;
          activeCursedId = String(player.index);
        }
      }
    }
    if (ring.radius >= ring.maxRadius) horde.shockwaves.splice(i, 1);
  }
}

// ---------------------------------------------------------------------------
// Wave director
// ---------------------------------------------------------------------------

export type DirectorPhase = 'intermission' | 'spawning' | 'active';

export interface Director {
  wave: number;
  phase: DirectorPhase;
  timer: number;
  queue: ZombieKind[];
  spawnTimer: number;
  /** Themed event hosting the current wave ('none' for a standard wave). */
  event: WaveEventKind;
}

export interface DirectorEvents {
  waveStarted: number | null;
  waveCleared: number | null;
}

/**
 * Randomised between-wave grace period drawn from the configured window
 * (DIRECTOR_CONFIG.waveIntermissionMinSec..MaxSec, nominally 7–10 s).
 */
function pickIntermissionSeconds(): number {
  const { waveIntermissionMinSec: min, waveIntermissionMaxSec: max } = DIRECTOR_CONFIG;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.random() * (hi - lo);
}

export function createDirector(): Director {
  return {
    wave: 0,
    phase: 'intermission',
    timer: DIRECTOR_CONFIG.openingIntermission,
    queue: [],
    spawnTimer: 0,
    event: 'none',
  };
}

function buildQueue(wave: number, event: WaveEventKind): ZombieKind[] {
  // Wave-7 boss encounter: the standard horde is halved (−50% small mobs) so
  // players can focus the Black Devil, and no extra red Devils join it.
  //
  // Strict spawn gate: the encounter wave is clamped to a hard floor so the
  // boss can NEVER leak into waves 1–6, even if the balance table drifts.
  const bossWaveIndex = Math.max(DIRECTOR_CONFIG.blackDevilWave, BLACK_DEVIL_MIN_WAVE);
  const bossWave = wave === bossWaveIndex;
  const mobMultiplier = bossWave ? DIRECTOR_CONFIG.blackDevilMobCountMultiplier : 1;
  const count = Math.round(
    Math.min(
      DIRECTOR_CONFIG.maxCount,
      DIRECTOR_CONFIG.baseCount + DIRECTOR_CONFIG.perWaveCount * wave
    ) * mobMultiplier
  );
  const queue: ZombieKind[] = [];

  // Speed Horde: exclusively lightweight runners (spawn applies the +80% bonus).
  if (event === 'speedHorde') {
    for (let i = 0; i < count; i++) queue.push('runner');
    return queue;
  }

  for (let i = 0; i < count; i++) {
    const runner = wave >= DIRECTOR_CONFIG.runnerFromWave && i % 3 === 2;
    queue.push(runner ? 'runner' : 'walker');
  }
  if (bossWave) {
    // The boss spawns first, at the very start of the wave.
    queue.unshift('blackDevil');
    return queue;
  }
  // devils join from their configured wave, growing slowly
  if (wave >= DIRECTOR_CONFIG.devilFromWave) {
    const devils = Math.min(DIRECTOR_CONFIG.maxDevils, 1 + Math.floor(wave / 4));
    for (let i = 0; i < devils; i++) queue.push('devil');
  }
  return queue;
}

/**
 * Chooses a spawn point. Prefers the map's authored `spawnPoints` (keeping a
 * fair distance from the players), then falls back to a random open cell ring.
 */
function pickSpawnCell(
  grid: GridMap,
  playerX: number,
  playerZ: number,
  spawnPoints: readonly { x: number; z: number }[] = []
): { x: number; z: number } {
  for (let attempt = 0; attempt < 12 && spawnPoints.length > 0; attempt++) {
    const candidate = spawnPoints[Math.floor(Math.random() * spawnPoints.length)];
    if (grid.isBlockedWorld(candidate.x, candidate.z)) continue;
    if (Math.hypot(candidate.x - playerX, candidate.z - playerZ) < 8) continue;
    return { x: candidate.x, z: candidate.z };
  }

  let fallback: { x: number; z: number } | null = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    const cx = 1 + Math.floor(Math.random() * (grid.width - 2));
    const cz = 1 + Math.floor(Math.random() * (grid.height - 2));
    if (grid.isBlockedCell(cx, cz)) continue;
    const center = grid.centerOf(cx, cz);
    if (!fallback) fallback = center;
    const distance = Math.hypot(center.x - playerX, center.z - playerZ);
    if (distance >= 9 && distance <= 28) return center;
  }
  return fallback ?? { x: playerX + 6, z: playerZ };
}

/** Advances the wave state machine; spawns configured batches per tick. */
export function updateDirector(
  director: Director,
  dt: number,
  horde: Horde,
  scene: THREE.Scene,
  grid: GridMap,
  playerX: number,
  playerZ: number,
  spawnPoints: readonly { x: number; z: number }[] = []
): DirectorEvents {
  const events: DirectorEvents = { waveStarted: null, waveCleared: null };

  if (director.phase === 'intermission') {
    director.timer -= dt;
    if (director.timer <= 0) {
      director.wave += 1;
      director.event = waveEventFor(director.wave);
      director.queue = buildQueue(director.wave, director.event);
      director.phase = 'spawning';
      director.spawnTimer = 0;
      events.waveStarted = director.wave;
    }
  } else if (director.phase === 'spawning') {
    director.spawnTimer -= dt;
    if (director.spawnTimer <= 0) {
      for (let i = 0; i < DIRECTOR_CONFIG.spawnBatchSize && director.queue.length > 0; i++) {
        const kind = director.queue.shift() as ZombieKind;
        const spawn = pickSpawnCell(grid, playerX, playerZ, spawnPoints);
        const zombie = spawnZombie(horde, scene, kind, spawn.x, spawn.z);
        // Speed Horde: every runner gets its +80% movement bonus on top of
        // the base stats (HP stays at the lightweight 40).
        if (director.event === 'speedHorde' && zombie.kind === 'runner') {
          zombie.speed *= 1 + WAVE_EVENT_CONFIG.runnerSpeedBonus;
        }
      }
      director.spawnTimer = DIRECTOR_CONFIG.spawnInterval;
      if (director.queue.length === 0) director.phase = 'active';
    }
  } else if (horde.zombies.length === 0) {
    events.waveCleared = director.wave;
    director.phase = 'intermission';
    director.timer = pickIntermissionSeconds();
    director.event = 'none'; // lights come back / speed boost ends with the wave
  }

  return events;
}
