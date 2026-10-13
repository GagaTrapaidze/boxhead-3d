/**
 * Projectiles & explosions: player grenades/rockets and devil fireballs.
 *
 * The module owns entity movement and collision detection; it *reports*
 * damage back to main.ts (which owns score/combo/HUD) as structured events,
 * so game rules stay in one place.
 */
import * as THREE from 'three';

import { GridMap } from '../../../shared/src/grid.ts';
import { buildFireballMesh, buildGrenadeMesh, buildRocketMesh } from './actors.ts';
import type { WeaponDef } from '../../../shared/src/weapons.ts';
import { GRENADE_CONFIG, ENEMY_CONFIG, FX_CONFIG, PHYSICS_CONFIG } from '../../../shared/src/balance.config.ts';

export type ProjectileKind = 'grenade' | 'rocket' | 'fireball';

export interface Projectile {
  kind: ProjectileKind;
  /** Player that fired it (−1 for devil fireballs). */
  ownerIndex: number;
  /** Flat player damage on detonation (grenade: 55). Undefined = scaled. */
  playerDamage?: number;
  x: number;
  z: number;
  /** Height above the arena floor (grenades arc and bounce). */
  y: number;
  /** Vertical velocity; only grenades use it. */
  vy: number;
  /** Heading in radians (fireballs steer; grenades/rockets fly straight). */
  angle: number;
  speed: number;
  life: number;
  damage: number;
  radius: number;
  mesh: THREE.Mesh;
}

export interface ExplosionEvent {
  ownerIndex: number;
  x: number;
  z: number;
  radius: number;
  damage: number;
  /** victim index → accumulated damage (zombies use the horde array index). */
  zombieDamage: Map<number, number>;
  /** player index → accumulated damage (self-friendly fire included). */
  playerDamage: Map<number, number>;
}

export interface ProjectileEvents {
  explosions: ExplosionEvent[];
  /** Direct fireball impacts (no area damage). */
  playerDamage: Map<number, number>;
}

export interface ProjectileWorld {
  grid: GridMap;
  /** Indexed exactly like the horde array at call time. */
  zombies: readonly { x: number; z: number; radius: number; alive: boolean }[];
  players: readonly { x: number; z: number; alive: boolean; aimX: number; aimZ: number }[];
}

export interface Flash {
  mesh: THREE.Mesh;
  /** Blast light — reveals nearby zombies for the flash's lifetime (crucial on blackout waves). */
  light: THREE.PointLight;
  life: number;
  maxLife: number;
  maxScale: number;
}

// Projectile lifetimes are `WeaponBalance.lifeSeconds` (grenade fuse, rocket
// dud timeout, mine fuse) — see balance.config.ts.
const FIREBALL_LIFE = ENEMY_CONFIG.fireballLife;
const FIREBALL_TURN = ENEMY_CONFIG.fireballTurnRate; // rad/s homing capability
const FLASH_LIFE = FX_CONFIG.explosionFlashLife;

// Grenade arc physics: an upward launch, gravity, and a damped ground bounce.
const GRENADE_LAUNCH_VY = GRENADE_CONFIG.launchLift;
const GRENADE_GRAVITY = PHYSICS_CONFIG.grenadeGravity;
const GRENADE_BOUNCE = PHYSICS_CONFIG.grenadeBounce;
const GROUND_Y = PHYSICS_CONFIG.groundY;
/** Shared sphere used by every explosion flash (never disposed). */
const FLASH_GEOMETRY = new THREE.SphereGeometry(1, 12, 10);

export function spawnPlayerProjectile(
  scene: THREE.Scene,
  list: Projectile[],
  def: WeaponDef,
  kind: 'grenade' | 'rocket',
  x: number,
  z: number,
  dirX: number,
  dirZ: number,
  ownerIndex: number
): void {
  // distinct models: a bouncing canister for grenades, a streamlined rocket otherwise
  const mesh = kind === 'grenade' ? buildGrenadeMesh() : buildRocketMesh();
  const y = kind === 'grenade' ? 0.6 : 0.7;
  mesh.position.set(x, y, z);
  scene.add(mesh);
  list.push({
    kind,
    ownerIndex,
    // grenade blast vs players: a flat number so the 2-blast kill rule is exact
    playerDamage: def.damageToPlayers,
    x,
    z,
    y,
    // mines reuse the grenade path but are dropped, not thrown (speed 0)
    vy: kind === 'grenade' && def.projectileSpeed > 0 ? GRENADE_LAUNCH_VY : 0,
    angle: Math.atan2(dirZ, dirX),
    speed: def.projectileSpeed,
    life: def.lifeSeconds,
    damage: def.damage,
    radius: def.explosionRadius,
    mesh,
  });
}

export function spawnFireball(
  scene: THREE.Scene,
  list: Projectile[],
  x: number,
  z: number,
  angle: number
): void {
  const mesh = buildFireballMesh();
  mesh.position.set(x, 1.0, z);
  scene.add(mesh);
  list.push({
    kind: 'fireball',
    ownerIndex: -1,
    x,
    z,
    y: 1.0,
    vy: 0,
    angle,
    speed: ENEMY_CONFIG.fireballSpeed,
    life: FIREBALL_LIFE,
    damage: ENEMY_CONFIG.fireballDamage,
    radius: 0,
    mesh,
  });
}

function removeProjectile(scene: THREE.Scene, list: Projectile[], index: number): void {
  const projectile = list[index];
  // projectile parts use shared cached geometry/material (actors.ts) — the mesh
  // is a plain JS object; nothing here owns GPU resources, so nothing is disposed.
  scene.remove(projectile.mesh);
  list.splice(index, 1);
}

function spawnFlash(scene: THREE.Scene, flashes: Flash[], x: number, z: number, scale: number): void {
  const mesh = new THREE.Mesh(
    FLASH_GEOMETRY,
    new THREE.MeshBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.85 })
  );
  mesh.position.set(x, 0.8, z);
  mesh.scale.setScalar(0.5);
  scene.add(mesh);
  // The blast briefly lights the arena around it — on a blackout wave this is
  // one of the only ways to see the horde coming.
  const light = new THREE.PointLight(0xffaa33, 0, scale * 3, 2);
  light.position.set(x, 1.0, z);
  scene.add(light);
  flashes.push({ mesh, light, life: FLASH_LIFE, maxLife: FLASH_LIFE, maxScale: scale });
}

export interface ExplosionSpec {
  ownerIndex: number;
  x: number;
  z: number;
  radius: number;
  /** Blast damage vs zombies (scaled by falloff). */
  damage: number;
  /** Flat damage vs players inside the radius (no falloff). Omit to scale. */
  playerDamage?: number;
}

/**
 * Resolves an area blast: falloff damage to every zombie and player in range
 * with a clear line of sight, plus the expanding visual flash. Shared by
 * projectile detonations and by explosive barrels shot on the map.
 */
export function explode(
  scene: THREE.Scene,
  flashes: Flash[],
  spec: ExplosionSpec,
  world: ProjectileWorld
): ExplosionEvent {
  const explosion: ExplosionEvent = {
    ownerIndex: spec.ownerIndex,
    x: spec.x,
    z: spec.z,
    radius: spec.radius,
    damage: spec.damage,
    zombieDamage: new Map(),
    playerDamage: new Map(),
  };

  for (let z = 0; z < world.zombies.length; z++) {
    const zombie = world.zombies[z];
    if (!zombie.alive) continue;
    const distance = Math.hypot(zombie.x - spec.x, zombie.z - spec.z);
    if (distance > spec.radius + zombie.radius) continue;
    if (!world.grid.lineOfSight(spec.x, spec.z, zombie.x, zombie.z)) continue;
    const falloff = 1 - PHYSICS_CONFIG.explosionFalloff * Math.min(1, distance / Math.max(0.01, spec.radius));
    explosion.zombieDamage.set(z, (explosion.zombieDamage.get(z) ?? 0) + spec.damage * falloff);
  }
  for (let p = 0; p < world.players.length; p++) {
    const player = world.players[p];
    if (!player.alive) continue;
    const distance = Math.hypot(player.x - spec.x, player.z - spec.z);
    if (distance > spec.radius) continue;
    if (!world.grid.lineOfSight(spec.x, spec.z, player.x, player.z)) continue;
    // A flat `playerDamage` (grenade) ignores falloff so the balance rule —
    // survive the first blast, die on the second — holds at every distance.
    const amount =
      spec.playerDamage !== undefined
        ? spec.playerDamage
        : spec.damage *
            (1 -
              PHYSICS_CONFIG.explosionFalloff * Math.min(1, distance / Math.max(0.01, spec.radius)));
    explosion.playerDamage.set(p, (explosion.playerDamage.get(p) ?? 0) + amount);
  }

  spawnFlash(scene, flashes, spec.x, spec.z, spec.radius);
  return explosion;
}

/**
 * Steps every projectile, resolves collisions and returns accumulated damage.
 * `flashes` (explosion visuals) are owned by the caller and updated here too.
 */
export function updateProjectiles(
  scene: THREE.Scene,
  list: Projectile[],
  flashes: Flash[],
  dt: number,
  world: ProjectileWorld
): ProjectileEvents {
  const events: ProjectileEvents = { explosions: [], playerDamage: new Map() };

  for (let i = list.length - 1; i >= 0; i--) {
    const projectile = list[i];
    projectile.life -= dt;

    if (projectile.kind === 'fireball') {
      // home toward the nearest alive player
      let target: { x: number; z: number } | null = null;
      let best = Infinity;
      for (const player of world.players) {
        if (!player.alive) continue;
        const distance = Math.hypot(player.x - projectile.x, player.z - projectile.z);
        if (distance < best) {
          best = distance;
          target = player;
        }
      }
      if (target) {
        const desired = Math.atan2(target.z - projectile.z, target.x - projectile.x);
        let delta = desired - projectile.angle;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        const turn = Math.max(-FIREBALL_TURN * dt, Math.min(FIREBALL_TURN * dt, delta));
        projectile.angle += turn;
      }

      projectile.x += Math.cos(projectile.angle) * projectile.speed * dt;
      projectile.z += Math.sin(projectile.angle) * projectile.speed * dt;
      projectile.mesh.position.set(projectile.x, 1.0, projectile.z);

      // direct hit on a player
      let consumed = false;
      for (let p = 0; p < world.players.length; p++) {
        const player = world.players[p];
        if (!player.alive) continue;
        if (Math.hypot(player.x - projectile.x, player.z - projectile.z) < 0.55) {
          events.playerDamage.set(p, (events.playerDamage.get(p) ?? 0) + projectile.damage);
          consumed = true;
          break;
        }
      }
      // slams into walls mid-flight
      if (!consumed && world.grid.isBlockedWorld(projectile.x, projectile.z)) {
        consumed = true;
      }
      if (consumed || projectile.life <= 0) {
        removeProjectile(scene, list, i);
      }
      continue;
    }

    // straight-flying player projectile — grenades arc & bounce, rockets fly on
    const previousX = projectile.x;
    const previousZ = projectile.z;
    projectile.x += Math.cos(projectile.angle) * projectile.speed * dt;
    projectile.z += Math.sin(projectile.angle) * projectile.speed * dt;
    projectile.mesh.rotation.y = -projectile.angle;

    let detonate = projectile.life <= 0;

    if (projectile.kind === 'grenade') {
      projectile.vy -= GRENADE_GRAVITY * dt;
      projectile.y += projectile.vy * dt;
      if (projectile.y <= GROUND_Y) {
        projectile.y = GROUND_Y;
        projectile.vy = -projectile.vy * GRENADE_BOUNCE;
        if (Math.abs(projectile.vy) < 0.6) projectile.vy = 0; // settle
      }
      // bounce off the wall face the canister entered
      if (world.grid.isBlockedWorld(projectile.x, projectile.z)) {
        if (!world.grid.isBlockedWorld(previousX, projectile.z)) {
          projectile.x = previousX;
          projectile.angle = Math.PI - projectile.angle;
        } else if (!world.grid.isBlockedWorld(projectile.x, previousZ)) {
          projectile.z = previousZ;
          projectile.angle = -projectile.angle;
        } else {
          projectile.x = previousX;
          projectile.z = previousZ;
          projectile.angle += Math.PI;
        }
      }
    } else if (world.grid.isBlockedWorld(projectile.x, projectile.z)) {
      detonate = true; // rockets detonate on walls
    }

    projectile.mesh.position.set(projectile.x, projectile.y, projectile.z);

    if (!detonate && projectile.kind === 'rocket') {
      for (const zombie of world.zombies) {
        if (!zombie.alive) continue;
        if (Math.hypot(zombie.x - projectile.x, zombie.z - projectile.z) < zombie.radius + 0.3) {
          detonate = true;
          break;
        }
      }
    }

    if (detonate) {
      events.explosions.push(
        explode(
          scene,
          flashes,
          {
            ownerIndex: projectile.ownerIndex,
            x: projectile.x,
            z: projectile.z,
            radius: projectile.radius,
            damage: projectile.damage,
            playerDamage: projectile.playerDamage,
          },
          world
        )
      );
      removeProjectile(scene, list, i);
    }
  }

  // explosion flashes
  for (let i = flashes.length - 1; i >= 0; i--) {
    const flash = flashes[i];
    flash.life -= dt;
    const progress = 1 - flash.life / flash.maxLife;
    flash.mesh.scale.setScalar(0.5 + progress * flash.maxScale);
    const material = flash.mesh.material as THREE.MeshBasicMaterial;
    material.opacity = Math.max(0, 0.85 * (1 - progress));
    flash.light.intensity = flash.maxScale * 9 * Math.max(0, 1 - progress);
    if (flash.life <= 0) {
      scene.remove(flash.mesh, flash.light);
      material.dispose(); // geometry is shared across all flashes
      flashes.splice(i, 1);
    }
  }

  return events;
}
