/**
 * Authoritative world simulation for the co-op room (server-side).
 *
 * This is the Phase 3–5 port of the client's horde / props / drops systems: it
 * owns every enemy's id, position, health and target, generates waves, moves the
 * horde with the shared flow field, runs the Devil's fireballs and phase-2 dash
 * hazards, tracks deployable barrels / wooden crates (with explosion chains) and
 * rolls loot drops — all without any Three.js meshes. Clients render the results
 * from the room state and report their own resolved shot damage back.
 *
 * Player HP stays client-authoritative: melee / hazard / fireball / explosion
 * damage is accumulated here and drained by the room, which forwards it to the
 * affected client's own `applyDamage` path.
 */
import { GridMap } from '../../../shared/src/grid.ts';
import { computeFlowField, sampleFlow } from '../../../shared/src/flowfield.ts';
import type { FlowField } from '../../../shared/src/flowfield.ts';
import { getMap } from '../../../shared/src/maps.ts';
import type { MapDefinition } from '../../../shared/src/maps.ts';
import {
  BARREL_CONFIG,
  BLACK_DEVIL_MIN_WAVE,
  CRATE_CONFIG,
  DIRECTOR_CONFIG,
  ENEMY_CONFIG,
  PHYSICS_CONFIG,
  PLAYER_CONFIG,
  WAVE_CONFIG,
  WAVE_EVENT_CONFIG,
} from '../../../shared/src/balance.config.ts';
import { waveEventFor } from '../../../shared/src/waveEvents.ts';
import type { WaveEventKind } from '../../../shared/src/waveEvents.ts';
import { getWeapon } from '../../../shared/src/weapons.ts';
import {
  advanceShockwaveRing,
  createShockwaveRing,
  ringSweepHitsCircle,
} from '../../../shared/src/shockwave.ts';
import type { ShockwaveRing } from '../../../shared/src/shockwave.ts';
import {
  advanceCurse,
  canApplyCurse,
  createCurseState,
  curseProgress,
  isInCurseCircle,
} from '../../../shared/src/curse.ts';
import type { CurseState } from '../../../shared/src/curse.ts';
import { bossLootCount, pickBossLoot, rollDropKind } from '../../../shared/src/loot.ts';
import type { DropKind, EnemyKind, PropKind } from '../../../shared/src/loot.ts';

const ATTACK_RANGE = ENEMY_CONFIG.attackRange;
const ATTACK_COOLDOWN = ENEMY_CONFIG.attackCooldown;
const WALL_ATTACK_INTERVAL = ENEMY_CONFIG.wallAttackInterval;
const DEVIL_FIRE_INTERVAL = ENEMY_CONFIG.devilFireInterval;
const DEVIL_FIRE_RANGE_MIN = ENEMY_CONFIG.devilFireRangeMin;
const DEVIL_FIRE_RANGE_MAX = ENEMY_CONFIG.devilFireRangeMax;
const SUPPRESS_DURATION = ENEMY_CONFIG.suppressDuration;
/** Wave-7 boss tuning (single source: shared/src/balance.config.ts). */
const BLACK_DEVIL = ENEMY_CONFIG.blackDevil;
/** Damage a mob deals to a barricade it is clawing through (every 0.5 s). */
const BARRICADE_MELEE_DAMAGE = 25;
/** Explosive-barrel durability (mirrors the client's BARRICADE_HP). */
const BARRICADE_HP = 150;

export interface SimPlayer {
  id: string;
  x: number;
  z: number;
  alive: boolean;
}

export type DashState = 'idle' | 'windup' | 'dash';

export interface SimEnemy {
  id: number;
  kind: EnemyKind;
  hp: number;
  maxHp: number;
  x: number;
  z: number;
  /** Facing angle (radians) — the client copies this onto the mesh rotation. */
  dir: number;
  radius: number;
  speed: number;
  damage: number;
  score: number;
  attackCooldown: number;
  wallTimer: number;
  fireCooldown: number;
  suppressTimer: number;
  enraged: boolean;
  phase2: boolean;
  dashState: DashState;
  dashTimer: number;
  dashDirX: number;
  dashDirZ: number;
  hazTimer: number;
  /**
   * Black Devil only: 'idle' | 'charge' (1 s laser telegraph) | 'fire' (3.5 s
   * beam channel). While charging or firing the boss stands still and every
   * other attack is disabled.
   */
  attackState: 'idle' | 'charge' | 'fire';
  /** Countdown within the active laser phase (telegraph or channel). */
  attackTimer: number;
  /** Seconds until the next laser telegraph is allowed. */
  laserCooldown: number;
  /** Beam aim direction (unit vector), ramped with rotational inertia. */
  laserDirX: number;
  laserDirZ: number;
  /** sessionId the current beam is locked onto ("" when idle). */
  laserTarget: string;
  /** Countdown to the next beam damage tick. */
  laserTick: number;
  /**
   * Distance the beam actually reaches, clamped to the first wall / crate the
   * ray meets (grid raycast). Clients draw the telegraph and beam only this far
   * so the laser never renders through an obstacle, and beam damage is limited
   * to victims in front of that hit point.
   */
  laserLength: number;
  /** Seconds until the next radial shockwave is allowed (strict 4.5 s). */
  shockCooldown: number;
  /** sessionId of the nearest alive player this tick ("" when none). */
  target: string;
}

export interface SimHazard {
  id: number;
  x: number;
  z: number;
  radius: number;
  damage: number;
  life: number;
  maxLife: number;
  tick: number;
}

/**
 * A live expanding shockwave: an annulus that races outward from the boss
 * origin. It is a real physical entity (not an instant radius check) that
 * sweeps the perimeter across players' bodies over several ticks, is occluded
 * by walls / crates, and curses whoever it lands on.
 */
export interface SimShockwave extends ShockwaveRing {
  id: number;
  /** Player ids already resolved (damaged, occluded or cleared by cover). */
  readonly resolved: Set<string>;
}

/** Per-player curse runtime kept by the simulation (id = sessionId). */
export interface SimCurse extends CurseState {}

export interface SimFireball {
  id: number;
  /** 'fireball' = red Devil homing orb; 'spinner' = black Devil's orbiting cubes. */
  kind: 'fireball' | 'spinner';
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  /** Orbit phase of a spinner's cubes, in radians (synchronized to clients). */
  spin: number;
  life: number;
}

export interface SimProp {
  kind: PropKind;
  cx: number;
  cz: number;
  hp: number;
  maxHp: number;
}

export interface SimDrop {
  id: number;
  kind: DropKind;
  x: number;
  z: number;
  ttl: number;
}

export type DirectorPhase = 'intermission' | 'spawning' | 'active';

/** A one-shot world event the room broadcasts to every client. */
export type SimEvent =
  | { type: 'enemyKilled'; id: number; kind: EnemyKind; x: number; z: number; killer: string }
  | { type: 'propDestroyed'; kind: PropKind; cx: number; cz: number }
  | { type: 'explosion'; x: number; z: number; radius: number }
  | { type: 'shockwave'; x: number; z: number; radius: number; speed: number }
  | { type: 'waveStart'; wave: number; event: WaveEventKind }
  | { type: 'waveClear'; wave: number };

export class WorldSim {
  readonly grid: GridMap;
  readonly enemies: SimEnemy[] = [];
  readonly hazards: SimHazard[] = [];
  readonly fireballs: SimFireball[] = [];
  readonly props: SimProp[] = [];
  readonly drops: SimDrop[] = [];
  /** Live expanding shockwave rings (Attack 2). */
  readonly shockwaves: SimShockwave[] = [];
  /** Active curse debuffs, keyed by player sessionId. */
  private readonly curses = new Map<string, SimCurse>();

  wave = 0;
  event: WaveEventKind = 'none';
  phase: DirectorPhase = 'intermission';
  timer = DIRECTOR_CONFIG.openingIntermission;

  private readonly queue: EnemyKind[] = [];
  private spawnTimer = 0;
  private field: FlowField | null = null;
  private fieldTimer = 0;
  private players: SimPlayer[] = [];
  private nextEnemyId = 1;
  private nextHazardId = 1;
  private nextFireballId = 1;
  private nextDropId = 1;
  private nextShockwaveId = 1;
  private spawnPoints: { x: number; z: number }[] = [];
  /** Staggered barrel chain fuses (`chainFuseDelay` per link). */
  private chainFuses: { cx: number; cz: number; timer: number }[] = [];
  private readonly events: SimEvent[] = [];
  private readonly playerDamage = new Map<string, number>();

  constructor(mapId: string) {
    const map = getMap(mapId);
    this.grid = new GridMap(map.width, map.height, 1);
    this.applyMap(map);
  }

  // --- map / lifecycle -----------------------------------------------------

  private applyMap(map: MapDefinition): void {
    for (let z = 0; z < map.height; z++) {
      for (let x = 0; x < map.width; x++) {
        this.grid.setBlocked(x, z, map.grid[z][x] === 1);
      }
    }
    // The horde emerges from the map's perimeter gate alcoves when it declares
    // them; older maps without gates fall back to their authored spawn points.
    this.spawnPoints =
      map.spawnGates.length > 0
        ? map.spawnGates.map((gate) => ({ x: gate.x, z: gate.y }))
        : map.zombieSpawns.map((s) => ({ x: s.x, z: s.y }));
  }

  /** Resets the whole match: clears all entities and restarts the director. */
  reset(mapId: string): void {
    const map = getMap(mapId);
    this.applyMap(map);
    this.enemies.length = 0;
    this.hazards.length = 0;
    this.fireballs.length = 0;
    this.props.length = 0;
    this.drops.length = 0;
    this.shockwaves.length = 0;
    this.curses.clear();
    this.chainFuses = [];
    this.field = null;
    this.fieldTimer = 0;
    this.wave = 0;
    this.event = 'none';
    this.phase = 'intermission';
    this.timer = DIRECTOR_CONFIG.openingIntermission;
    this.queue.length = 0;
    this.spawnTimer = 0;
    this.events.length = 0;
    this.playerDamage.clear();
  }

  /** Copies the authoritative player transforms in before each step. */
  syncPlayers(players: SimPlayer[]): void {
    this.players = players;
    // Drop curse state for anyone who left the room so the map never leaks.
    if (this.curses.size > 0) {
      const live = new Set(players.map((player) => player.id));
      for (const id of [...this.curses.keys()]) {
        if (!live.has(id)) this.curses.delete(id);
      }
    }
  }

  // --- curse queries (the room mirrors these into its schema) ---------------

  /** True while this player is cursed (ticking damage until cleansed). */
  isCursed(id: string): boolean {
    return this.curses.has(id);
  }

  /** Normalized cleanse hold (0..1) for a cursed player (0 when not cursed). */
  curseProgressOf(id: string): number {
    const curse = this.curses.get(id);
    return curse ? curseProgress(curse) : 0;
  }

  /** Clears a player's curse immediately (death / respawn / match reset). */
  clearCurse(id: string): void {
    this.curses.delete(id);
  }

  // --- queries -------------------------------------------------------------

  propAt(cx: number, cz: number): SimProp | undefined {
    return this.props.find((prop) => prop.cx === cx && prop.cz === cz);
  }

  enemyById(id: number): SimEnemy | undefined {
    return this.enemies.find((enemy) => enemy.id === id);
  }

  // --- drains --------------------------------------------------------------

  /** Takes the events accumulated since the last drain (the room broadcasts them). */
  drainEvents(): SimEvent[] {
    if (this.events.length === 0) return [];
    const drained = this.events.slice();
    this.events.length = 0;
    return drained;
  }

  /** Takes the player damage accumulated since the last drain, keyed by sessionId. */
  drainPlayerDamage(): Map<string, number> {
    const drained = new Map(this.playerDamage);
    this.playerDamage.clear();
    return drained;
  }

  // --- mutators (called from room messages) --------------------------------

  /**
   * Applies weapon damage to an enemy. Rapid-fire hits (fire interval at or
   * below `rapidFireIntervalMs`) suppress a Devil's fireballs. Returns true when
   * the hit killed it.
   */
  damageEnemy(id: number, amount: number, weaponId: number, killer = ''): boolean {
    const enemy = this.enemyById(id);
    if (!enemy || !(amount > 0)) return false;
    if (enemy.kind === 'devil' && getWeapon(weaponId).fireIntervalMs <= ENEMY_CONFIG.rapidFireIntervalMs) {
      enemy.suppressTimer = Math.max(enemy.suppressTimer, SUPPRESS_DURATION);
    }
    enemy.hp -= amount;
    if (enemy.hp > 0) return false;
    this.killEnemy(enemy, killer);
    return true;
  }

  private killEnemy(enemy: SimEnemy, killer = ''): void {
    const index = this.enemies.indexOf(enemy);
    if (index === -1) return;
    this.enemies.splice(index, 1);
    this.events.push({
      type: 'enemyKilled',
      id: enemy.id,
      kind: enemy.kind,
      x: enemy.x,
      z: enemy.z,
      killer,
    });
    // The Black Devil dies in a "loot explosion": 3–4 reward cubes (health
    // packs, special ammo / barrels) scattered around its footprint.
    if (enemy.kind === 'blackDevil') {
      const count = bossLootCount();
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const distance = 0.4 + Math.random() * 1.1;
        this.spawnDrop(
          pickBossLoot(),
          enemy.x + Math.cos(angle) * distance,
          enemy.z + Math.sin(angle) * distance
        );
      }
      return;
    }
    const drop = rollDropKind();
    if (drop) this.spawnDrop(drop, enemy.x, enemy.z);
  }

  private spawnDrop(kind: DropKind, x: number, z: number): void {
    this.drops.push({ id: this.nextDropId++, kind, x, z, ttl: WAVE_CONFIG.pickupLifeSeconds });
  }

  /** Deploys a barrel / crate. False when the cell is out of bounds or taken. */
  placeProp(kind: PropKind, cx: number, cz: number): boolean {
    if (!this.grid.inBounds(cx, cz) || this.grid.isBlockedCell(cx, cz)) return false;
    const maxHp = kind === 'crate' ? CRATE_CONFIG.hp : BARRICADE_HP;
    this.grid.setBlocked(cx, cz, true);
    this.props.push({ kind, cx, cz, hp: maxHp, maxHp });
    return true;
  }

  /** Applies shot damage to a prop; detonates / removes it on destruction. */
  damageProp(cx: number, cz: number, amount: number, killer = ''): void {
    const prop = this.propAt(cx, cz);
    if (!prop || !(amount > 0)) return;
    prop.hp -= amount;
    if (prop.hp > 0) return;
    this.destroyProp(prop, true, killer);
  }

  private destroyProp(prop: SimProp, chainAllowed: boolean, killer = ''): void {
    this.grid.setBlocked(prop.cx, prop.cz, false);
    const index = this.props.indexOf(prop);
    if (index === -1) return;
    this.props.splice(index, 1);
    this.events.push({ type: 'propDestroyed', kind: prop.kind, cx: prop.cx, cz: prop.cz });
    // A wooden crate never explodes and never chains — it can still drop loot.
    if (prop.kind === 'crate') {
      const drop = rollDropKind();
      if (drop) this.spawnDrop(drop, prop.cx + 0.5, prop.cz + 0.5);
      return;
    }
    this.explode(
      prop.cx + 0.5,
      prop.cz + 0.5,
      BARREL_CONFIG.explosionRadius,
      BARREL_CONFIG.damage,
      undefined,
      chainAllowed,
      killer
    );
  }

  /**
   * Area blast: falloff damage to enemies (with the Devil explosive cap) and
   * players, plus a staggered chain reaction to neighbouring barrels. Shared by
   * barrel detonations and by client-reported grenade / rocket / mine blasts.
   */
  explode(
    x: number,
    z: number,
    radius: number,
    damage: number,
    /**
     * Flat damage dealt to players (grenades) — omit for distance falloff.
     * `0` means the blast deals no player damage at all.
     */
    playerDamage?: number,
    chainAllowed = true,
    killer = ''
  ): void {
    this.events.push({ type: 'explosion', x, z, radius });

    // Resolve victims to objects *before* any kills splice the enemy array.
    const victims: { enemy: SimEnemy; amount: number }[] = [];
    for (const enemy of this.enemies) {
      const distance = Math.hypot(enemy.x - x, enemy.z - z);
      if (distance > radius + enemy.radius) continue;
      if (!this.grid.lineOfSight(x, z, enemy.x, enemy.z)) continue;
      const falloff =
        1 - PHYSICS_CONFIG.explosionFalloff * Math.min(1, distance / Math.max(0.01, radius));
      let amount = damage * falloff;
      if (enemy.kind === 'devil') amount = Math.min(amount, ENEMY_CONFIG.devil.explosiveDamageCap);
      else if (enemy.kind === 'blackDevil') amount = Math.min(amount, BLACK_DEVIL.explosiveDamageCap);
      victims.push({ enemy, amount });
    }
    for (const { enemy, amount } of victims) {
      enemy.hp -= amount;
      if (enemy.hp <= 0) this.killEnemy(enemy, killer);
    }

    const flat = playerDamage !== undefined ? playerDamage : null;
    if (flat !== 0) {
      for (const player of this.players) {
        if (!player.alive) continue;
        const distance = Math.hypot(player.x - x, player.z - z);
        if (distance > radius) continue;
        if (!this.grid.lineOfSight(x, z, player.x, player.z)) continue;
        const amount =
          flat !== null
            ? flat
            : damage *
              (1 - PHYSICS_CONFIG.explosionFalloff * Math.min(1, distance / Math.max(0.01, radius)));
        this.playerDamage.set(player.id, (this.playerDamage.get(player.id) ?? 0) + amount);
      }
    }

    if (!chainAllowed) return;
    let queued = 0;
    for (const prop of this.props) {
      if (prop.kind !== 'barrel') continue;
      const bx = prop.cx + 0.5;
      const bz = prop.cz + 0.5;
      if (Math.hypot(bx - x, bz - z) > BARREL_CONFIG.chainTriggerRadius) continue;
      if (this.chainFuses.some((fuse) => fuse.cx === prop.cx && fuse.cz === prop.cz)) continue;
      this.chainFuses.push({ cx: prop.cx, cz: prop.cz, timer: BARREL_CONFIG.chainFuseDelay * (queued + 1) });
      queued++;
    }
  }

  /** Grants a drop to a player standing on it; returns the kind granted. */
  pickup(dropId: number, playerX: number, playerZ: number): DropKind | null {
    const index = this.drops.findIndex((drop) => drop.id === dropId);
    if (index === -1) return null;
    const drop = this.drops[index];
    if (Math.hypot(drop.x - playerX, drop.z - playerZ) > WAVE_CONFIG.pickupRadius) return null;
    this.drops.splice(index, 1);
    return drop.kind;
  }

  // --- simulation ----------------------------------------------------------

  /** Advances one tick; results are accumulated for `drainEvents`/`drainPlayerDamage`. */
  step(dt: number): void {
    this.updateDirector(dt);
    this.updateHorde(dt);
    this.updateShockwaves(dt);
    this.updateHazards(dt);
    this.updateFireballs(dt);
    this.updateCurses(dt);
    this.updateChainFuses(dt);
    this.updateDrops(dt);
  }

  private updateDirector(dt: number): void {
    if (this.phase === 'intermission') {
      this.timer -= dt;
      if (this.timer > 0) return;
      this.wave += 1;
      this.event = waveEventFor(this.wave);
      this.buildQueue();
      this.phase = 'spawning';
      this.spawnTimer = 0;
      this.events.push({ type: 'waveStart', wave: this.wave, event: this.event });
      return;
    }
    if (this.phase === 'spawning') {
      this.spawnTimer -= dt;
      if (this.spawnTimer > 0) return;
      for (let i = 0; i < DIRECTOR_CONFIG.spawnBatchSize && this.queue.length > 0; i++) {
        this.spawnEnemy(this.queue.shift() as EnemyKind);
      }
      this.spawnTimer = DIRECTOR_CONFIG.spawnInterval;
      if (this.queue.length === 0) this.phase = 'active';
      return;
    }
    if (this.enemies.length === 0) {
      this.events.push({ type: 'waveClear', wave: this.wave });
      this.phase = 'intermission';
      this.timer = this.pickIntermissionSeconds();
      this.event = 'none'; // lights come back / the speed boost ends with the wave
    }
  }

  /** Randomised between-wave grace period from the configured 7–10 s window. */
  private pickIntermissionSeconds(): number {
    const lo = Math.min(DIRECTOR_CONFIG.waveIntermissionMinSec, DIRECTOR_CONFIG.waveIntermissionMaxSec);
    const hi = Math.max(DIRECTOR_CONFIG.waveIntermissionMinSec, DIRECTOR_CONFIG.waveIntermissionMaxSec);
    return lo + Math.random() * (hi - lo);
  }

  private buildQueue(): void {
    // Wave-7 boss encounter: the standard horde is halved (−50% small mobs) so
    // players can focus the Black Devil, and no extra red Devils join it.
    //
    // Strict spawn gate: the encounter wave is clamped to a hard floor so the
    // boss can NEVER leak into waves 1–6, even if the balance table drifts.
    const bossWaveIndex = Math.max(DIRECTOR_CONFIG.blackDevilWave, BLACK_DEVIL_MIN_WAVE);
    const bossWave = this.wave === bossWaveIndex;
    const mobMultiplier = bossWave ? DIRECTOR_CONFIG.blackDevilMobCountMultiplier : 1;
    const count = Math.round(
      Math.min(
        DIRECTOR_CONFIG.maxCount,
        DIRECTOR_CONFIG.baseCount + DIRECTOR_CONFIG.perWaveCount * this.wave
      ) * mobMultiplier
    );
    // Speed Horde: exclusively lightweight runners (spawn applies the +80% bonus).
    if (this.event === 'speedHorde') {
      for (let i = 0; i < count; i++) this.queue.push('runner');
      return;
    }
    for (let i = 0; i < count; i++) {
      const runner = this.wave >= DIRECTOR_CONFIG.runnerFromWave && i % 3 === 2;
      this.queue.push(runner ? 'runner' : 'walker');
    }
    if (bossWave) {
      // The boss spawns first, at the very start of the wave.
      this.queue.unshift('blackDevil');
      return;
    }
    if (this.wave >= DIRECTOR_CONFIG.devilFromWave) {
      const devils = Math.min(DIRECTOR_CONFIG.maxDevils, 1 + Math.floor(this.wave / 4));
      for (let i = 0; i < devils; i++) this.queue.push('devil');
    }
  }

  private spawnEnemy(kind: EnemyKind): void {
    const stats = ENEMY_CONFIG[kind];
    const spawn = this.pickSpawnCell();
    const enemy: SimEnemy = {
      id: this.nextEnemyId++,
      kind,
      hp: stats.hp,
      maxHp: stats.hp,
      x: spawn.x,
      z: spawn.z,
      dir: 0,
      radius: stats.radius,
      speed: stats.speed,
      damage: stats.damage,
      score: stats.score,
      attackCooldown: 0,
      wallTimer: 0,
      fireCooldown: DEVIL_FIRE_INTERVAL * (0.4 + Math.random() * 0.6),
      suppressTimer: 0,
      enraged: false,
      phase2: false,
      dashState: 'idle',
      dashTimer: ENEMY_CONFIG.devilDashInterval,
      dashDirX: 0,
      dashDirZ: -1,
      hazTimer: 0,
      attackState: 'idle',
      attackTimer: 0,
      laserCooldown: BLACK_DEVIL.laserCooldown * (0.5 + Math.random() * 0.5),
      laserDirX: 0,
      laserDirZ: -1,
      laserTarget: '',
      laserTick: 0,
      laserLength: BLACK_DEVIL.laserRange,
      shockCooldown: 0,
      target: '',
    };
    // Speed Horde: every runner gets its +80% movement bonus (HP stays at 40).
    if (this.event === 'speedHorde' && kind === 'runner') {
      enemy.speed *= 1 + WAVE_EVENT_CONFIG.runnerSpeedBonus;
    }
    this.enemies.push(enemy);
  }

  private pickSpawnCell(): { x: number; z: number } {
    const anchor = this.players.find((player) => player.alive) ?? this.players[0] ?? { x: 20, z: 20 };
    for (let attempt = 0; attempt < 12 && this.spawnPoints.length > 0; attempt++) {
      const candidate = this.spawnPoints[Math.floor(Math.random() * this.spawnPoints.length)];
      if (this.grid.isBlockedWorld(candidate.x, candidate.z)) continue;
      if (Math.hypot(candidate.x - anchor.x, candidate.z - anchor.z) < 8) continue;
      return { x: candidate.x, z: candidate.z };
    }
    let fallback: { x: number; z: number } | null = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      const cx = 1 + Math.floor(Math.random() * (this.grid.width - 2));
      const cz = 1 + Math.floor(Math.random() * (this.grid.height - 2));
      if (this.grid.isBlockedCell(cx, cz)) continue;
      const center = this.grid.centerOf(cx, cz);
      if (!fallback) fallback = center;
      const distance = Math.hypot(center.x - anchor.x, center.z - anchor.z);
      if (distance >= 9 && distance <= 28) return center;
    }
    return fallback ?? { x: anchor.x + 6, z: anchor.z };
  }

  private nearestPlayer(x: number, z: number): SimPlayer | null {
    let best: SimPlayer | null = null;
    let bestDistance = Infinity;
    for (const player of this.players) {
      if (!player.alive) continue;
      const distance = Math.hypot(player.x - x, player.z - z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = player;
      }
    }
    return best;
  }

  /** A specific living player by sessionId (the laser's locked target). */
  private playerById(id: string): SimPlayer | null {
    if (!id) return null;
    const player = this.players.find((candidate) => candidate.id === id);
    return player && player.alive ? player : null;
  }

  /**
   * Attack 2 — radial shockwave (close-range defense).
   *
   * Spawns a *physical* expanding ring at the boss instead of applying instant
   * radius damage: the ring's perimeter races outward over the following ticks
   * and only wounds a player when it actually sweeps their body (see
   * {@link updateShockwaves}). The one-shot event tells every client to play the
   * same expanding ring + screen shake.
   */
  private shockwave(enemy: SimEnemy): void {
    const ring: SimShockwave = {
      ...createShockwaveRing(
        enemy.x,
        enemy.z,
        BLACK_DEVIL.shockwaveRadius,
        BLACK_DEVIL.shockwaveRingThickness,
        BLACK_DEVIL.shockwaveExpansionSpeed
      ),
      id: this.nextShockwaveId++,
      resolved: new Set<string>(),
    };
    this.shockwaves.push(ring);
    this.events.push({
      type: 'shockwave',
      x: ring.x,
      z: ring.z,
      radius: ring.maxRadius,
      speed: ring.speed,
    });
  }

  /**
   * One tick of every live shockwave: expand the ring, then resolve each living
   * player the swept perimeter touches.
   *
   * A player is resolved at most once per ring (their id joins `resolved`):
   * they take the flat shockwave damage and gain a curse *only* when the boss
   * has a clear line-of-sight ray to them. Behind a wooden crate or wall the
   * ray is blocked, so the wave is occluded and the player is spared entirely
   * — cover genuinely blocks the shockwave.
   *
   * The flat impact damage always lands; the curse is additionally gated by the
   * strict {@link canApplyCurse} rules (solo immunity, one curse at a time and
   * the respawn / revive immunity window) evaluated in {@link applyCurse}.
   */
  private updateShockwaves(dt: number): void {
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const ring = this.shockwaves[i];
      const { prevRadius } = advanceShockwaveRing(ring, dt);

      for (const player of this.players) {
        if (!player.alive || ring.resolved.has(player.id)) continue;
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
        // The perimeter reached this body: mark it done either way so cover
        // persists for the rest of the wave.
        ring.resolved.add(player.id);
        if (!this.grid.lineOfSight(ring.x, ring.z, player.x, player.z)) continue;
        this.playerDamage.set(
          player.id,
          (this.playerDamage.get(player.id) ?? 0) + BLACK_DEVIL.shockwaveDamage
        );
        this.applyCurse(player.id);
      }

      if (ring.radius >= ring.maxRadius) this.shockwaves.splice(i, 1);
    }
  }

  /**
   * Flags a player as cursed (fresh tick/cleanse clocks if not already) — but
   * only when all three strict guards allow it. A failed guard is silent: the
   * shockwave still dealt its flat impact damage, only the debuff is withheld.
   */
  private applyCurse(playerId: string): void {
    if (this.curses.has(playerId)) return; // already cursed: keep its clocks
    if (!this.curseAllowed(playerId)) return;
    this.curses.set(playerId, createCurseState());
  }

  /**
   * The sessionId of the player currently holding the single active curse (''
   * when none). Only a *living* holder counts: a curse whose victim has died
   * frees the slot immediately, exactly as if it had been cleansed.
   */
  private activeCurseHolder(): string {
    for (const id of this.curses.keys()) {
      const holder = this.players.find((player) => player.id === id);
      if (holder && holder.alive) return id;
    }
    return '';
  }

  /** Evaluates the shared curse guards against the live match state. */
  private curseAllowed(playerId: string): boolean {
    return canApplyCurse({
      playerCount: this.players.length,
      activeCursedId: this.activeCurseHolder(),
      targetId: playerId,
      targetAlive: this.players.some((player) => player.id === playerId && player.alive),
      // In co-op a downed player is either on the respawn timer or being
      // actively revived; either way the whole match is curse-immune.
      anyPlayerDowned: this.players.some((player) => !player.alive),
    });
  }

  /**
   * One tick of every active curse: bleed `curseDamage` on the fixed interval
   * and let a *teammate* standing inside the cleansing circle chip away at the
   * 3 s hold. The hold resets the moment that teammate steps out, and a curse
   * is dropped entirely when its victim goes down or a teammate finishes the
   * cleanse.
   */
  private updateCurses(dt: number): void {
    if (this.curses.size === 0) return;
    for (const [id, curse] of [...this.curses]) {
      const cursed = this.players.find((player) => player.id === id);
      if (!cursed || !cursed.alive) {
        this.curses.delete(id);
        continue;
      }
      const cleansed = this.players.some(
        (teammate) =>
          teammate.id !== id &&
          teammate.alive &&
          isInCurseCircle(cursed.x, cursed.z, teammate.x, teammate.z)
      );
      const step = advanceCurse(curse, dt, cleansed);
      if (step.damage > 0) {
        this.playerDamage.set(id, (this.playerDamage.get(id) ?? 0) + step.damage);
      }
      if (step.cleansed) this.curses.delete(id);
    }
  }

  /** Recomputes the shared flow field toward every living player (4 Hz). */
  private refreshField(dt: number): void {
    this.fieldTimer -= dt;
    if (this.fieldTimer > 0) return;
    const goals: { cx: number; cz: number }[] = [];
    for (const player of this.players) {
      if (!player.alive) continue;
      const cx = this.grid.cellX(player.x);
      const cz = this.grid.cellZ(player.z);
      if (!this.grid.inBounds(cx, cz) || this.grid.isBlockedCell(cx, cz)) continue;
      if (!goals.some((goal) => goal.cx === cx && goal.cz === cz)) goals.push({ cx, cz });
    }
    if (goals.length > 0) {
      this.field = computeFlowField(this.grid, goals);
      this.fieldTimer = 0.25;
    }
  }

  private updateHorde(dt: number): void {
    this.refreshField(dt);
    const field = this.field;
    const enraged = this.enemies.length > 0 && this.enemies.length <= DIRECTOR_CONFIG.enrageThreshold;

    for (const enemy of this.enemies) {
      enemy.enraged = enraged;
      if (enemy.attackCooldown > 0) enemy.attackCooldown -= dt;
      if (enemy.wallTimer > 0) enemy.wallTimer -= dt;

      const target = this.nearestPlayer(enemy.x, enemy.z);
      if (!target) continue;
      enemy.target = target.id;

      const toTargetX = target.x - enemy.x;
      const toTargetZ = target.z - enemy.z;
      const distanceToTarget = Math.hypot(toTargetX, toTargetZ);
      const invDistance = 1 / Math.max(distanceToTarget, 1e-6);

      let dirX = 0;
      let dirZ = 0;
      let frozen = false;
      let speedScale = 1;

      if (enemy.kind === 'blackDevil') {
        enemy.dir = Math.atan2(toTargetX, toTargetZ);

        if (enemy.attackState === 'charge') {
          // Attack 3, telegraph phase: stand still and paint an aim line locked
          // onto the chosen player (1 s). Every other attack is disabled.
          frozen = true;
          enemy.attackTimer -= dt;
          const locked = this.playerById(enemy.laserTarget) ?? target;
          const ldx = locked.x - enemy.x;
          const ldz = locked.z - enemy.z;
          const len = Math.hypot(ldx, ldz) || 1;
          enemy.laserDirX = ldx / len;
          enemy.laserDirZ = ldz / len;
          // Continuous raycast: the aim line stops at the first wall / crate it
          // meets, so the telegraph never paints through cover.
          enemy.laserLength = this.grid.raycastDistance(
            enemy.x,
            enemy.z,
            enemy.laserDirX,
            enemy.laserDirZ,
            BLACK_DEVIL.laserRange
          );
          if (enemy.attackTimer <= 0) {
            enemy.attackState = 'fire';
            enemy.attackTimer = BLACK_DEVIL.laserDuration;
            enemy.laserTick = 0;
          }
        } else if (enemy.attackState === 'fire') {
          // Attack 3, beam phase: hold still, track the locked player with
          // rotational inertia (sprint/strafe dodges it) and tick damage.
          frozen = true;
          enemy.attackTimer -= dt;
          const locked = this.playerById(enemy.laserTarget) ?? target;
          const desired = Math.atan2(locked.x - enemy.x, locked.z - enemy.z);
          let delta = desired - Math.atan2(enemy.laserDirX, enemy.laserDirZ);
          while (delta > Math.PI) delta -= Math.PI * 2;
          while (delta < -Math.PI) delta += Math.PI * 2;
          const maxTurn = BLACK_DEVIL.laserTurnRate * dt;
          const angle = Math.atan2(enemy.laserDirX, enemy.laserDirZ) + Math.max(-maxTurn, Math.min(maxTurn, delta));
          enemy.laserDirX = Math.sin(angle);
          enemy.laserDirZ = Math.cos(angle);
          // Re-clamp the beam every tick: as the boss tracks, the beam length
          // follows whatever obstacle now blocks the ray from its origin.
          enemy.laserLength = this.grid.raycastDistance(
            enemy.x,
            enemy.z,
            enemy.laserDirX,
            enemy.laserDirZ,
            BLACK_DEVIL.laserRange
          );
          enemy.laserTick -= dt;
          if (enemy.laserTick <= 0) {
            enemy.laserTick = BLACK_DEVIL.laserTickInterval;
            for (const player of this.players) {
              if (!player.alive) continue;
              const ox = player.x - enemy.x;
              const oz = player.z - enemy.z;
              const along = ox * enemy.laserDirX + oz * enemy.laserDirZ;
              // Only victims in front of the wall the beam stops at are exposed.
              if (along < 0 || along > enemy.laserLength) continue;
              const perpendicular = Math.abs(ox * enemy.laserDirZ - oz * enemy.laserDirX);
              if (perpendicular > BLACK_DEVIL.laserHalfWidth + PLAYER_CONFIG.radius) continue;
              if (!this.grid.lineOfSight(enemy.x, enemy.z, player.x, player.z)) continue;
              this.playerDamage.set(
                player.id,
                (this.playerDamage.get(player.id) ?? 0) + BLACK_DEVIL.laserDamage
              );
            }
          }
          if (enemy.attackTimer <= 0) {
            enemy.attackState = 'idle';
            enemy.attackTimer = 0;
            enemy.laserCooldown = BLACK_DEVIL.laserCooldown;
            enemy.laserDirX = 0;
            enemy.laserDirZ = 0;
          }
        } else {
          // Idle: hold the ranged band, defend with the shockwave and pick
          // between the laser wind-up and a spinner volley.
          if (distanceToTarget > BLACK_DEVIL.spinnerRangeMax) {
            dirX = toTargetX * invDistance;
            dirZ = toTargetZ * invDistance;
          } else if (distanceToTarget < BLACK_DEVIL.spinnerRangeMin) {
            dirX = -toTargetX * invDistance;
            dirZ = -toTargetZ * invDistance;
          }
          if (enemy.shockCooldown > 0) enemy.shockCooldown -= dt;
          if (enemy.laserCooldown > 0) enemy.laserCooldown -= dt;
          enemy.fireCooldown -= dt;

          const crowded = this.players.some(
            (player) =>
              player.alive &&
              Math.hypot(player.x - enemy.x, player.z - enemy.z) <= BLACK_DEVIL.shockwaveTriggerRange
          );
          if (crowded && enemy.shockCooldown <= 0) {
            this.shockwave(enemy);
            enemy.shockCooldown = BLACK_DEVIL.shockwaveCooldown;
          }

          const hasSight = this.grid.lineOfSight(enemy.x, enemy.z, target.x, target.z);
          if (enemy.laserCooldown <= 0 && distanceToTarget <= BLACK_DEVIL.laserRange && hasSight) {
            enemy.attackState = 'charge';
            enemy.attackTimer = BLACK_DEVIL.laserTelegraph;
            enemy.laserTarget = target.id;
            const len = Math.max(distanceToTarget, 1e-6);
            enemy.laserDirX = toTargetX / len;
            enemy.laserDirZ = toTargetZ / len;
            enemy.laserLength = this.grid.raycastDistance(
              enemy.x,
              enemy.z,
              enemy.laserDirX,
              enemy.laserDirZ,
              BLACK_DEVIL.laserRange
            );
          } else if (
            enemy.fireCooldown <= 0 &&
            distanceToTarget <= BLACK_DEVIL.spinnerRangeMax &&
            hasSight
          ) {
            // Attack 1 — spinning fireball: 4 orbiting cubes aimed at the target.
            this.fireballs.push({
              id: this.nextFireballId++,
              kind: 'spinner',
              x: enemy.x,
              z: enemy.z,
              dirX: toTargetX * invDistance,
              dirZ: toTargetZ * invDistance,
              spin: 0,
              life: BLACK_DEVIL.spinnerLife,
            });
            enemy.fireCooldown = BLACK_DEVIL.spinnerInterval;
          }
        }
      } else if (enemy.kind === 'devil') {
        if (!enemy.phase2 && enemy.hp <= enemy.maxHp * ENEMY_CONFIG.devilPhase2HpFraction) {
          enemy.phase2 = true;
        }
        enemy.dir = Math.atan2(toTargetX, toTargetZ);
        enemy.suppressTimer -= dt;
        enemy.fireCooldown -= dt;

        if (enemy.phase2 && enemy.dashState === 'windup') {
          frozen = true;
          enemy.dashTimer -= dt;
          if (enemy.dashTimer <= 0) {
            enemy.dashState = 'dash';
            enemy.dashTimer = ENEMY_CONFIG.devilDashDuration;
            enemy.hazTimer = 0;
          }
        } else if (enemy.phase2 && enemy.dashState === 'dash') {
          dirX = enemy.dashDirX;
          dirZ = enemy.dashDirZ;
          speedScale = ENEMY_CONFIG.devilDashSpeedMultiplier;
          enemy.dashTimer -= dt;
          enemy.hazTimer -= dt;
          if (enemy.hazTimer <= 0) {
            this.dropHazard(enemy.x, enemy.z);
            enemy.hazTimer = ENEMY_CONFIG.devilTrailDropInterval;
          }
          if (enemy.dashTimer <= 0) {
            enemy.dashState = 'idle';
            enemy.dashTimer = ENEMY_CONFIG.devilDashInterval;
          }
        } else {
          // ranged stance: close beyond ~11, back off inside ~7, otherwise hold
          if (distanceToTarget > DEVIL_FIRE_RANGE_MAX) {
            dirX = toTargetX * invDistance;
            dirZ = toTargetZ * invDistance;
          } else if (distanceToTarget < DEVIL_FIRE_RANGE_MIN) {
            dirX = -toTargetX * invDistance;
            dirZ = -toTargetZ * invDistance;
          }
          if (
            enemy.suppressTimer <= 0 &&
            enemy.fireCooldown <= 0 &&
            this.grid.lineOfSight(enemy.x, enemy.z, target.x, target.z)
          ) {
            this.fireballs.push({
              id: this.nextFireballId++,
              kind: 'fireball',
              x: enemy.x,
              z: enemy.z,
              dirX: toTargetX * invDistance,
              dirZ: toTargetZ * invDistance,
              spin: 0,
              life: ENEMY_CONFIG.fireballLife,
            });
            enemy.fireCooldown = DEVIL_FIRE_INTERVAL;
          }
          if (enemy.phase2) {
            enemy.dashTimer -= dt;
            if (enemy.dashTimer <= 0) {
              enemy.dashState = 'windup';
              enemy.dashTimer = ENEMY_CONFIG.devilDashWindup;
              enemy.dashDirX = toTargetX * invDistance;
              enemy.dashDirZ = toTargetZ * invDistance;
            }
          }
        }
      } else if (enraged) {
        dirX = toTargetX * invDistance;
        dirZ = toTargetZ * invDistance;
      } else if (field) {
        const flow = sampleFlow(this.grid, field, enemy.x, enemy.z);
        dirX = flow.x;
        dirZ = flow.z;
      }
      if (dirX === 0 && dirZ === 0) {
        dirX = toTargetX * invDistance;
        dirZ = toTargetZ * invDistance;
      }

      // local separation (straight O(n²) at server entity counts)
      let sepX = 0;
      let sepZ = 0;
      for (const other of this.enemies) {
        if (other === enemy) continue;
        const offsetX = enemy.x - other.x;
        const offsetZ = enemy.z - other.z;
        const distanceSq = offsetX * offsetX + offsetZ * offsetZ;
        const minDistance = enemy.radius + other.radius;
        if (distanceSq > 1e-9 && distanceSq < minDistance * minDistance) {
          const d = Math.sqrt(distanceSq);
          sepX += offsetX / d;
          sepZ += offsetZ / d;
        }
      }
      dirX += sepX * 0.6;
      dirZ += sepZ * 0.6;

      const totalLength = Math.hypot(dirX, dirZ);
      if (!frozen && totalLength > 1e-6) {
        dirX /= totalLength;
        dirZ /= totalLength;
        const baseSpeed = enraged
          ? enemy.speed * DIRECTOR_CONFIG.enrageSpeedMultiplier
          : enemy.speed;
        const intended = baseSpeed * speedScale * dt;
        const resolved = this.grid.resolveCircle(
          enemy.x + dirX * intended,
          enemy.z + dirZ * intended,
          enemy.radius
        );
        const moved = Math.hypot(resolved.x - enemy.x, resolved.z - enemy.z);
        enemy.x = resolved.x;
        enemy.z = resolved.z;
        if (enemy.kind !== 'devil') enemy.dir = Math.atan2(dirX, dirZ);

        // pushed into a wall → chew the barricade in front, if any
        if (moved < intended * 0.5 && intended > 0) {
          const front = {
            cx: this.grid.cellX(enemy.x + dirX * 1.2),
            cz: this.grid.cellZ(enemy.z + dirZ * 1.2),
          };
          const prop = this.propAt(front.cx, front.cz);
          if (prop && enemy.wallTimer <= 0) {
            enemy.wallTimer = WALL_ATTACK_INTERVAL;
            prop.hp -= BARRICADE_MELEE_DAMAGE;
            if (prop.hp <= 0) this.destroyProp(prop, true);
          }
        }
      }

      // rigid player collider: push the mob out of the player's body
      for (const player of this.players) {
        if (!player.alive) continue;
        const offsetX = enemy.x - player.x;
        const offsetZ = enemy.z - player.z;
        const minDistance = PLAYER_CONFIG.radius + enemy.radius;
        const distanceSq = offsetX * offsetX + offsetZ * offsetZ;
        if (distanceSq >= minDistance * minDistance) continue;
        let normalX = 1;
        let normalZ = 0;
        let distance = 0;
        if (distanceSq > 1e-9) {
          distance = Math.sqrt(distanceSq);
          normalX = offsetX / distance;
          normalZ = offsetZ / distance;
        }
        const overlap = minDistance - distance;
        const resolved = this.grid.resolveCircle(
          enemy.x + normalX * overlap,
          enemy.z + normalZ * overlap,
          enemy.radius
        );
        enemy.x = resolved.x;
        enemy.z = resolved.z;
      }

      // melee contact (measured after separation)
      const meleeDistance = Math.hypot(target.x - enemy.x, target.z - enemy.z);
      if (meleeDistance <= ATTACK_RANGE + enemy.radius * 0.5 && enemy.attackCooldown <= 0) {
        this.playerDamage.set(target.id, (this.playerDamage.get(target.id) ?? 0) + enemy.damage);
        enemy.attackCooldown = ATTACK_COOLDOWN;
      }
    }
  }

  /** Drops a fiery floor patch left behind by a phase-2 Devil dash (capped). */
  private dropHazard(x: number, z: number): void {
    if (this.hazards.length >= 64) return;
    this.hazards.push({
      id: this.nextHazardId++,
      x,
      z,
      radius: ENEMY_CONFIG.devilTrailRadius,
      damage: ENEMY_CONFIG.devilTrailDamage,
      life: ENEMY_CONFIG.devilTrailLife,
      maxLife: ENEMY_CONFIG.devilTrailLife,
      tick: ENEMY_CONFIG.devilTrailTick,
    });
  }

  private updateHazards(dt: number): void {
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const hazard = this.hazards[i];
      hazard.life -= dt;
      if (hazard.life <= 0) {
        this.hazards.splice(i, 1);
        continue;
      }
      hazard.tick -= dt;
      if (hazard.tick > 0) continue;
      hazard.tick = ENEMY_CONFIG.devilTrailTick;
      for (const player of this.players) {
        if (!player.alive) continue;
        if (Math.hypot(player.x - hazard.x, player.z - hazard.z) <= hazard.radius + 0.2) {
          this.playerDamage.set(player.id, (this.playerDamage.get(player.id) ?? 0) + hazard.damage);
        }
      }
    }
  }

  private updateFireballs(dt: number): void {
    for (let i = this.fireballs.length - 1; i >= 0; i--) {
      const ball = this.fireballs[i];
      const spinner = ball.kind === 'spinner';
      const speed = spinner ? BLACK_DEVIL.spinnerSpeed : ENEMY_CONFIG.fireballSpeed;
      // Spinners barely steer (they are aimed at fire time and dodgeable).
      const turnRate = spinner ? BLACK_DEVIL.spinnerTurnRate : ENEMY_CONFIG.fireballTurnRate;
      const damage = spinner ? BLACK_DEVIL.spinnerDamage : ENEMY_CONFIG.fireballDamage;
      ball.life -= dt;
      if (ball.life <= 0) {
        this.fireballs.splice(i, 1);
        continue;
      }
      if (spinner) ball.spin += BLACK_DEVIL.spinnerSpinRate * dt;

      // gentle homing toward the nearest player
      const target = this.nearestPlayer(ball.x, ball.z);
      if (target) {
        const toX = target.x - ball.x;
        const toZ = target.z - ball.z;
        const length = Math.hypot(toX, toZ);
        if (length > 1e-6) {
          const turn = Math.min(1, turnRate * dt);
          ball.dirX += (toX / length - ball.dirX) * turn;
          ball.dirZ += (toZ / length - ball.dirZ) * turn;
          const norm = Math.hypot(ball.dirX, ball.dirZ) || 1;
          ball.dirX /= norm;
          ball.dirZ /= norm;
        }
      }
      ball.x += ball.dirX * speed * dt;
      ball.z += ball.dirZ * speed * dt;

      if (this.grid.isBlockedWorld(ball.x, ball.z)) {
        this.fireballs.splice(i, 1);
        continue;
      }
      let hit = false;
      for (const player of this.players) {
        if (!player.alive) continue;
        if (Math.hypot(player.x - ball.x, player.z - ball.z) <= PLAYER_CONFIG.radius + 0.45) {
          this.playerDamage.set(player.id, (this.playerDamage.get(player.id) ?? 0) + damage);
          hit = true;
          break;
        }
      }
      if (hit) this.fireballs.splice(i, 1);
    }
  }

  private updateChainFuses(dt: number): void {
    for (let i = this.chainFuses.length - 1; i >= 0; i--) {
      const fuse = this.chainFuses[i];
      fuse.timer -= dt;
      if (fuse.timer > 0) continue;
      this.chainFuses.splice(i, 1);
      const prop = this.propAt(fuse.cx, fuse.cz);
      if (prop && prop.kind === 'barrel') this.destroyProp(prop, false);
    }
  }

  private updateDrops(dt: number): void {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      this.drops[i].ttl -= dt;
      if (this.drops[i].ttl <= 0) this.drops.splice(i, 1);
    }
  }
}
