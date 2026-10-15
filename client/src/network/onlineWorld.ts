/**
 * OnlineWorld — the client-side mirror of the server-authoritative world.
 *
 * In an online match the Colyseus room owns every mob, deployable, drop, hazard
 * and fireball. This module keeps the client's *render* arrays (`horde.zombies`,
 * `barricades`, `pickups`) in sync with `state.enemies` / `state.props` /
 * `state.drops`, draws the server's hazards and fireballs, and interpolates mob
 * motion between the 20 Hz patches so movement reads smoothly.
 *
 * It never runs game rules: destruction FX, score and damage all come from the
 * room's one-shot events (see `LobbyHandlers`), and combat input is reported
 * back through the lobby (`reportEnemyHit` …).
 */
import * as THREE from 'three';

import type { GridMap } from '../../../shared/src/grid.ts';
import { buildFireballMesh, buildSpinnerMesh } from '../game/actors.ts';
import { placeBarricade, removeBarricade } from '../game/barricades.ts';
import type { Barricade } from '../game/barricades.ts';
import { PICKUP_RADIUS, spawnPickup } from '../game/pickups.ts';
import type { Pickup } from '../game/pickups.ts';
import { removeZombie, spawnZombie } from '../game/enemies.ts';
import type { Horde, Zombie } from '../game/enemies.ts';
import type { Player } from '../game/player.ts';
import type { Lobby, RoomInfo } from './lobby.ts';

/** The live client-side game objects the mirror writes into. */
export interface OnlineWorldContext {
  scene: THREE.Scene;
  grid: GridMap;
  horde: Horde;
  barricades: Barricade[];
  pickups: Pickup[];
}

/** Shared floor-plane geometry for hazard patches (never disposed). */
const HAZARD_GEOMETRY = new THREE.PlaneGeometry(1, 1);

/** How quickly a mob mesh closes the gap to its last server position. */
const ENEMY_LERP_RATE = 14;

interface EnemyTarget {
  x: number;
  z: number;
}

export class OnlineWorld {
  /** server mob id → its local render proxy. */
  private readonly enemyProxies = new Map<number, Zombie>();
  /** local render proxy → its server mob id (for reporting shot damage). */
  private readonly idByProxy = new Map<Zombie, number>();
  private readonly enemyTargets = new Map<number, EnemyTarget>();
  /** "cx,cz" → the local barricade proxy. */
  private readonly propProxies = new Map<string, Barricade>();
  /** server drop id → the local pickup proxy. */
  private readonly dropProxies = new Map<number, Pickup>();
  /** Drop ids we already asked the room for (so we don't spam the message). */
  private readonly requested = new Set<number>();
  private readonly hazardMeshes: THREE.Mesh[] = [];
  /** One render slot per server projectile; `kind` is tracked so a pooled slot
   * is rebuilt when a fireball index is reused by a spinner (or vice versa). */
  private readonly fireballMeshes: { mesh: THREE.Object3D; kind: 'fireball' | 'spinner' }[] = [];

  /** Tears every mirrored entity down (match start / end / leaving the room). */
  reset(ctx: OnlineWorldContext): void {
    for (const proxy of this.enemyProxies.values()) removeZombie(ctx.horde, ctx.scene, proxy);
    this.enemyProxies.clear();
    this.idByProxy.clear();
    this.enemyTargets.clear();

    for (const prop of this.propProxies.values()) {
      removeBarricade(ctx.grid, ctx.scene, ctx.barricades, prop);
    }
    this.propProxies.clear();

    for (const [, pickup] of this.dropProxies) {
      const index = ctx.pickups.indexOf(pickup);
      if (index !== -1) {
        ctx.scene.remove(pickup.mesh);
        ctx.pickups.splice(index, 1);
      }
    }
    this.dropProxies.clear();
    this.requested.clear();

    for (const mesh of this.hazardMeshes) {
      ctx.scene.remove(mesh);
      (mesh.material as THREE.Material).dispose(); // per-instance tint material
    }
    this.hazardMeshes.length = 0;
    for (const slot of this.fireballMeshes) ctx.scene.remove(slot.mesh);
    this.fireballMeshes.length = 0;
  }

  /**
   * Reconciles the mirrored meshes with one room snapshot: adds what appeared,
   * updates what moved, and silently removes what the server destroyed (the
   * destruction FX come from the room's one-shot events instead).
   */
  sync(ctx: OnlineWorldContext, info: RoomInfo): void {
    this.syncEnemies(ctx, info);
    this.syncProps(ctx, info);
    this.syncDrops(ctx, info);
    this.syncHazards(ctx, info);
    this.syncFireballs(ctx, info);
  }

  private syncEnemies(ctx: OnlineWorldContext, info: RoomInfo): void {
    const seen = new Set<number>();
    for (const enemy of info.enemies) {
      seen.add(enemy.id);
      let proxy = this.enemyProxies.get(enemy.id);
      if (!proxy) {
        // spawnZombie applies each kind's own rendered scale (red Devil 1.15,
        // Black Devil ~1.5× larger).
        proxy = spawnZombie(ctx.horde, ctx.scene, enemy.kind, enemy.x, enemy.z);
        this.enemyProxies.set(enemy.id, proxy);
        this.idByProxy.set(proxy, enemy.id);
        this.enemyTargets.set(enemy.id, { x: enemy.x, z: enemy.z });
      }
      proxy.hp = enemy.hp;
      proxy.maxHp = enemy.maxHp;
      this.applyDevilRage(proxy, enemy.phase2);
      // Black Devil: mirror the server's synchronized attack state so both
      // clients paint the same telegraph / beam from the same tick.
      proxy.attackState = enemy.attack === 1 ? 'charge' : enemy.attack === 2 ? 'fire' : 'idle';
      proxy.laserDirX = enemy.laserX;
      proxy.laserDirZ = enemy.laserZ;
      // Server-clamped beam reach: the render stops at the obstacle the raycast
      // hit, so the purple laser can never pass through a wall / crate.
      proxy.laserLength = enemy.laserLength;
      proxy.attackTimer = enemy.attackTimer;
      const target = this.enemyTargets.get(enemy.id);
      if (target) {
        target.x = enemy.x;
        target.z = enemy.z;
      }
      proxy.dirTarget = enemy.dir;
    }

    for (const [id, proxy] of [...this.enemyProxies]) {
      if (seen.has(id)) continue;
      removeZombie(ctx.horde, ctx.scene, proxy); // state-driven removal: no FX
      this.enemyProxies.delete(id);
      this.idByProxy.delete(proxy);
      this.enemyTargets.delete(id);
    }
  }

  /** Phase-2 rage: swell the boss and light its flame crown (no local logic). */
  private applyDevilRage(proxy: Zombie, phase2: boolean): void {
    if (proxy.kind !== 'devil') return;
    if (proxy.phase2 === phase2) return;
    proxy.phase2 = phase2;
    const light = proxy.mesh.userData.rageLight as THREE.PointLight | undefined;
    const flames = proxy.mesh.userData.rageFlames as THREE.Group | undefined;
    if (light) light.intensity = phase2 ? 2.4 : 0;
    if (flames) flames.visible = phase2;
    proxy.mesh.scale.setScalar(phase2 ? 1.25 : 1.15);
  }

  private syncProps(ctx: OnlineWorldContext, info: RoomInfo): void {
    const seen = new Set<string>();
    for (const prop of info.props) {
      const key = `${prop.cx},${prop.cz}`;
      seen.add(key);
      let proxy = this.propProxies.get(key);
      if (!proxy) {
        const placed = placeBarricade(ctx.grid, ctx.scene, ctx.barricades, prop.cx, prop.cz, prop.kind);
        if (!placed) continue; // cell taken locally — the next patch retries
        proxy = placed;
        this.propProxies.set(key, proxy);
      }
      proxy.hp = prop.hp;
      proxy.maxHp = prop.maxHp;
    }

    for (const [key, proxy] of [...this.propProxies]) {
      if (seen.has(key)) continue;
      removeBarricade(ctx.grid, ctx.scene, ctx.barricades, proxy);
      this.propProxies.delete(key);
    }
  }

  private syncDrops(ctx: OnlineWorldContext, info: RoomInfo): void {
    const seen = new Set<number>();
    for (const drop of info.drops) {
      seen.add(drop.id);
      let proxy = this.dropProxies.get(drop.id);
      if (!proxy) {
        proxy = spawnPickup(ctx.scene, ctx.pickups, drop.x, drop.z, drop.kind);
        this.dropProxies.set(drop.id, proxy);
      }
      proxy.x = drop.x;
      proxy.z = drop.z;
      proxy.ttl = drop.ttl;
    }

    for (const [id, proxy] of [...this.dropProxies]) {
      if (seen.has(id)) continue;
      const index = ctx.pickups.indexOf(proxy);
      if (index !== -1) {
        ctx.scene.remove(proxy.mesh);
        ctx.pickups.splice(index, 1);
      }
      this.dropProxies.delete(id);
      this.requested.delete(id);
    }
  }

  private syncHazards(ctx: OnlineWorldContext, info: RoomInfo): void {
    while (this.hazardMeshes.length > info.hazards.length) {
      const mesh = this.hazardMeshes.pop() as THREE.Mesh;
      ctx.scene.remove(mesh);
      (mesh.material as THREE.Material).dispose();
    }
    for (let i = 0; i < info.hazards.length; i++) {
      const hazard = info.hazards[i];
      let mesh = this.hazardMeshes[i];
      if (!mesh) {
        mesh = new THREE.Mesh(
          HAZARD_GEOMETRY,
          new THREE.MeshBasicMaterial({
            color: 0xff5a12,
            transparent: true,
            opacity: 0.5,
            depthWrite: false,
          })
        );
        mesh.rotation.x = -Math.PI / 2;
        ctx.scene.add(mesh);
        this.hazardMeshes[i] = mesh;
      }
      mesh.position.set(hazard.x, 0.04, hazard.z);
      mesh.scale.setScalar(hazard.radius * 2);
      const fade = hazard.maxLife > 0 ? hazard.life / hazard.maxLife : 0;
      (mesh.material as THREE.MeshBasicMaterial).opacity = 0.5 * Math.min(1, fade * 2);
    }
  }

  private syncFireballs(ctx: OnlineWorldContext, info: RoomInfo): void {
    while (this.fireballMeshes.length > info.fireballs.length) {
      const slot = this.fireballMeshes.pop() as { mesh: THREE.Object3D; kind: 'fireball' | 'spinner' };
      ctx.scene.remove(slot.mesh);
    }
    for (let i = 0; i < info.fireballs.length; i++) {
      const ball = info.fireballs[i];
      let slot = this.fireballMeshes[i];
      if (!slot || slot.kind !== ball.kind) {
        if (slot) ctx.scene.remove(slot.mesh);
        const mesh = ball.kind === 'spinner' ? buildSpinnerMesh() : buildFireballMesh();
        ctx.scene.add(mesh);
        slot = { mesh, kind: ball.kind };
        this.fireballMeshes[i] = slot;
      }
      slot.mesh.position.set(ball.x, 1.0, ball.z);
      // Spinners whirl at the server-synchronized orbit phase.
      if (ball.kind === 'spinner') slot.mesh.rotation.y = ball.spin;
    }
  }

  /**
   * One frame of smoothing: mobs ease toward their last server position, and
   * drops bob / blink on their server-owned despawn timer.
   */
  update(ctx: OnlineWorldContext, dt: number): void {
    const blend = Math.min(1, dt * ENEMY_LERP_RATE);
    for (const [id, proxy] of this.enemyProxies) {
      const target = this.enemyTargets.get(id);
      if (!target) continue;
      proxy.x += (target.x - proxy.x) * blend;
      proxy.z += (target.z - proxy.z) * blend;
      proxy.mesh.position.set(proxy.x, 0, proxy.z);
      if (proxy.dirTarget !== undefined) proxy.mesh.rotation.y = proxy.dirTarget;
    }

    for (const [, pickup] of this.dropProxies) {
      const crate = pickup.mesh.children[0] as THREE.Mesh | undefined;
      if (crate) crate.rotation.y += dt * 2;
      // The room owns the despawn; the local ttl only drives the warning blink.
      pickup.ttl = Math.max(0, pickup.ttl - dt);
      pickup.blinkTimer -= dt;
      if (pickup.ttl > 0 && pickup.ttl <= 3) {
        if (pickup.blinkTimer <= 0) {
          pickup.mesh.visible = !pickup.mesh.visible;
          pickup.blinkTimer = 0.15;
        }
      } else if (!pickup.mesh.visible) {
        pickup.mesh.visible = true;
      }
    }
  }

  /**
   * Sends one `pickupItem` per drop the local player is standing on. Deduped by
   * id until the room answers, so a slow round-trip never spams the message.
   */
  collectDrops(lobby: Lobby, player: Player): void {
    if (!player.alive) return;
    for (const [id, proxy] of this.dropProxies) {
      if (this.requested.has(id)) continue;
      if (Math.hypot(player.x - proxy.x, player.z - proxy.z) > PICKUP_RADIUS) continue;
      this.requested.add(id);
      lobby.requestPickup(id, player.x, player.z);
    }
  }

  /** Re-arms a drop so a rejected pickup (out of range) can be retried. */
  retryDrop(dropId: number): void {
    this.requested.delete(dropId);
  }

  /** The server mob id behind one of our local render proxies, if any. */
  enemyIdOf(proxy: Zombie): number | undefined {
    return this.idByProxy.get(proxy);
  }

  /** Local read access for tests / debug HUD. */
  get mirroredEnemies(): number {
    return this.enemyProxies.size;
  }

  get mirroredProps(): number {
    return this.propProxies.size;
  }

  get mirroredDrops(): number {
    return this.dropProxies.size;
  }

  /** Server mob ids currently rendered (sorted) — used by the browser checks. */
  enemyIds(): number[] {
    return [...this.enemyProxies.keys()].sort((a, b) => a - b);
  }

  /** "cx,cz" cells of every rendered prop (sorted). */
  propCells(): string[] {
    return [...this.propProxies.keys()].sort();
  }

  /** Server drop ids currently rendered (sorted). */
  dropIds(): number[] {
    return [...this.dropProxies.keys()].sort((a, b) => a - b);
  }
}
