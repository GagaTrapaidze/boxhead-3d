/**
 * ────────────────────────────────────────────────────────────────────────────
 *  BALANCE CONFIGURATION — the single place to tune gameplay by hand.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Every gameplay number the client uses at runtime is declared here. Nothing in
 * the engine hardcodes damage, cadence, ranges, drop rates or wave pacing, so
 * you can rebalance the game by editing this file alone.
 *
 * Conventions
 *  - Distances are world units (1 unit = 1 grid cell).
 *  - Times are seconds unless the field name ends in `Ms`.
 *  - `magSize: 0` means infinite ammo.
 *  - `lifeSeconds` is a projectile's lifetime (grenade fuse / dud timeout).
 *
 * Weapon order in `WEAPON_BALANCE` MUST match `WeaponId` in `weapons.ts`;
 * the weapons test asserts ids line up with their array index.
 *
 * Structure of this file:
 *  - `WEAPON_*` / `*_CONFIG` rows — one per weapon (grenade blast rules, uzi
 *    drop weight, pistol cadence, …).
 *  - `DROP_CONFIG`     — floating-cube drop frequency and loot table.
 *  - `WAVE_CONFIG`     — wave pacing; derives its drop rates from DROP_CONFIG.
 *  - `COOP_CONFIG`     — local 2-player revive loop (10 s countdown, 2 s i-frames).
 *
 * Field-name glossary (the knobs the weapon system consumes):
 *  - `fireIntervalMs`  cadence — milliseconds between shots (1 / fireRate).
 *  - `damage`          per-pellet / per-projectile damage (`baseDamage`,
 *                      `damagePerBullet`); grenade blast damage lives here too.
 *  - `maxRange`        hitscan reach in world units.
 *  - `throwVelocity`   is `projectileSpeed` (thrown weapons only).
 *  - `explosionRadius` is the AoE blast radius.
 */

export interface WeaponBalance {
  name: string;
  kind: 'hitscan' | 'projectile' | 'deployable';
  /** Damage per pellet / per projectile impact (before AoE falloff). */
  damage: number;
  /** Fraction of damage shed from point-blank to `maxRange` (0 = none). */
  damageFalloff: number;
  /** Minimum milliseconds between shots (cadence = 1 / fireRate). */
  fireIntervalMs: number;
  /** Magazine capacity; 0 = infinite ammo. */
  magSize: number;
  /** Hitscan pellet count (1 for single-shot weapons). */
  pelletCount: number;
  /** Max aim deviation per pellet, in radians. */
  spread: number;
  /** Effective range in world units (hitscan only). 0 = infinite. */
  maxRange: number;
  /** Distance within which `closeRangeDamage` replaces the scaled damage. */
  closeRangeThreshold: number;
  /** Damage per pellet inside `closeRangeThreshold` (0 = no bonus zone). */
  closeRangeDamage: number;
  /** Projectile speed in world units/second (0 for hitscan/deployable). */
  projectileSpeed: number;
  /** Projectile lifetime in seconds (0 = no cap). */
  lifeSeconds: number;
  /** Explosion / AoE radius in world units (0 = direct hit only). */
  explosionRadius: number;
  /** Minimum combo tier required to fire this weapon. */
  comboTier: number;
  /** Hitscan passes through victims (railgun). */
  pierce: boolean;
  /** Flat damage dealt to players inside the blast radius (no distance
   * falloff). When omitted, players take the scaled `damage` instead. */
  damageToPlayers?: number;
  /** Backwards kick applied on firing, in world units. */
  recoil: number;
  /** Tracer / muzzle-flash tint (0xRRGGBB). */
  tracerColor: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. PISTOL — infinite-ammo starter; deliberately 25% slower than before.
// ─────────────────────────────────────────────────────────────────────────────
export const PISTOL_CONFIG: WeaponBalance & { infiniteAmmo: boolean } = {
  name: 'Pistol',
  kind: 'hitscan',
  damage: 25,
  damageFalloff: 0.15,
  /** Was 250 ms; +33% cooldown == 25% slower rate of fire (250 / 0.75). */
  fireIntervalMs: 333,
  magSize: 0,
  pelletCount: 1,
  spread: 0.02,
  maxRange: 24,
  closeRangeThreshold: 0,
  closeRangeDamage: 0,
  projectileSpeed: 0,
  lifeSeconds: 0,
  explosionRadius: 0,
  comboTier: 0,
  pierce: false,
  recoil: 0.14,
  tracerColor: 0xfff2a0,
  /** Documentation mirror of `magSize: 0` — the pistol never runs dry. */
  infiniteAmmo: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. SHOTGUN — distance-scaled: 1-shot kill inside 3 cells, 2 shots beyond.
//
// A standard walker has 60 HP. `spread` is kept tight enough that every pellet
// of a centred blast connects inside ~3 cells (target half-angle 0.45 / 3 = 0.15),
// which is what makes the close-range numbers exact rather than luck.
//
// Base pellet damage was buffed by exactly +35% (10 → 13.5), cumulative on top
// of the earlier balance pass; the close-range pellet is scaled by the same
// factor (15 → 20.25) so the proximity curve keeps its 1.5× close/mid ratio:
//   inside 3 u : 5 pellets × 20.25 = 101.25 ≥ 60 → guaranteed point-blank kill
//   beyond 3 u : 5 pellets × ~10.5 = 52.5 < 60 → two shots (105 ≥ 60), one never
//   far out    : the cone grows wider than the target, so 3+ shots are needed
// ─────────────────────────────────────────────────────────────────────────────
export const SHOTGUN_CONFIG: WeaponBalance = {
  name: 'Shotgun',
  kind: 'hitscan',
  /** Pellet base damage: 10 × 1.35 = 13.5 (the +35% buff). */
  damage: 13.5,
  damageFalloff: 0.2,
  fireIntervalMs: 900,
  magSize: 6, 
  pelletCount: 5,
  spread: 0.1,
  maxRange: 16,
  /** 3 grid cells: inside this, every connecting pellet uses closeRangeDamage. */
  closeRangeThreshold: 3,
  /** Point-blank pellet damage: 15 × 1.35 = 20.25 (same +35% factor). */
  closeRangeDamage: 20.25,
  projectileSpeed: 0,
  lifeSeconds: 0,
  explosionRadius: 0,
  comboTier: 1,
  pierce: false,
  recoil: 0.2,
  tracerColor: 0xff8844,
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. UZI — high cyclic rate, frequent drops.
// ─────────────────────────────────────────────────────────────────────────────
export const UZI_CONFIG: WeaponBalance & { dropRateWeight: number } = {
  name: 'Uzi',
  kind: 'hitscan',
  damage: 13,
  damageFalloff: 0.3,
  /** Rapid spray: ~18 rounds/second. */
  fireIntervalMs: 55,
  magSize: 40,
  pelletCount: 1,
  spread: 0.06,
  maxRange: 30,
  closeRangeThreshold: 0,
  closeRangeDamage: 0,
  projectileSpeed: 0,
  lifeSeconds: 0,
  explosionRadius: 0,
  comboTier: 2,
  pierce: false,
  recoil: 0.06,
  tracerColor: 0x00ff88,
  /** Relative weight in the mob drop table — the highest of any weapon. */
  dropRateWeight: 40,
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. GRENADE — 0.6 s fuse, guaranteed instakill on the horde, tuned vs boss/players.
// ─────────────────────────────────────────────────────────────────────────────

/** Fuse (also the projectile lifetime): 0.6 s — halved from the old 1.2 s. */
const GRENADE_FUSE_TIME = 0.6;
/** Horizontal throw speed of the arcing canister. */
const GRENADE_THROW_VELOCITY = 18;
/** Blast damage vs the zombie horde: a guaranteed one-hit instakill (60 HP mobs). */
const GRENADE_HORDE_DAMAGE = 9999;
/**
 * Blast damage vs players: with PLAYER_CONFIG.maxHp = 100 a player survives the
 * first blast (100 − 55 = 45 HP left) and dies on the second (45 − 55 < 0).
 * Applied flat — no distance falloff — so the two-blast rule is exact.
 */
const GRENADE_PLAYER_DAMAGE = 55;
/**
 * Damage a single grenade blast deals to the Devil boss (its explosive armor
 * cap). Tied to `ENEMY_CONFIG.devil.explosiveDamageCap` below so the boss
 * invariant can never drift: one blast wounds it, exactly two destroy it.
 */
export const DEVIL_EXPLOSIVE_CAP = 500;

export const GRENADE_CONFIG: WeaponBalance & {
  fuseTime: number;
  launchLift: number;
  throwVelocity: number;
  damageToZombies: number;
  damageToPlayers: number;
  damageToDevil: number;
} = {
  name: 'Grenade',
  kind: 'projectile',
  /** Engine blast damage — see `damageToZombies` (same value, named knob). */
  damage: GRENADE_HORDE_DAMAGE,
  /** One-hit instakill for every standard horde zombie inside the radius. */
  damageToZombies: GRENADE_HORDE_DAMAGE,
  /** Flat damage vs players: survives the 1st blast, dies on the 2nd. */
  damageToPlayers: GRENADE_PLAYER_DAMAGE,
  /** Per-blast damage vs the Devil: two blasts (2 × 500 ≥ 850 HP) kill it. */
  damageToDevil: DEVIL_EXPLOSIVE_CAP,
  damageFalloff: 0,
  fireIntervalMs: 1200,
  magSize: 5,
  pelletCount: 1,
  spread: 0.08,
  maxRange: 0,
  closeRangeThreshold: 0,
  closeRangeDamage: 0,
  /** Horizontal throw speed (the arc's forward velocity). */
  projectileSpeed: GRENADE_THROW_VELOCITY,
  /** Named alias of `projectileSpeed` — the projectile arc speed knob. */
  throwVelocity: GRENADE_THROW_VELOCITY,
  /** Fuse (also the projectile lifetime). */
  lifeSeconds: GRENADE_FUSE_TIME,
  fuseTime: GRENADE_FUSE_TIME,
  /** Initial upward velocity of the throw arc. */
  launchLift: 5.5,
  /** AoE blast radius. */
  explosionRadius: 4,
  comboTier: 2,
  pierce: false,
  recoil: 0.15,
  tracerColor: 0xff4400,
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. Remaining weapons (kept here so *every* weapon reads from this file).
// ─────────────────────────────────────────────────────────────────────────────
export const BARREL_CONFIG: WeaponBalance & {
  /** Seconds a neighbouring barrel waits before its chained blast fires. */
  chainFuseDelay: number;
  /** Extra blast radius (beyond `explosionRadius`) that can start a chain. */
  chainTriggerRadius: number;
  /** Grid rings to search for a free barrel cell before giving up. */
  placementSearchRadius: number;
} = {
  name: 'Barrel',
  kind: 'deployable',
  damage: 150,
  damageFalloff: 0,
  fireIntervalMs: 1500,
  magSize: 3,
  pelletCount: 1,
  spread: 0,
  maxRange: 0,
  closeRangeThreshold: 0,
  closeRangeDamage: 0,
  projectileSpeed: 0,
  lifeSeconds: 0,
  explosionRadius: 4.5,
  comboTier: 3,
  pierce: false,
  recoil: 0.1,
  tracerColor: 0xff7a1a,
  /** 0.08 s staggered fuse between barrels touched by a chain reaction. */
  chainFuseDelay: 0.08,
  /** Blast radius that reaches the next barrel — its own 4.5 u AoE. */
  chainTriggerRadius: 4.5,
  /** How many grid rings to search for a free placement cell (front cell first). */
  placementSearchRadius: 3,
};

// ─────────────────────────────────────────────────────────────────────────────
// 5b. CRATE — dedicated wooden barricade: solid, 150 HP, NEVER explodes.
//
// Crates snap to the grid exactly like barrels (one full 1×1 cell), so a line
// of them is an airtight wall. They have no blast radius and no chain fuse —
// when destroyed they simply splinter away, opening their cell again. The horde
// claws them down at BARRICADE_MELEE_DAMAGE per bite; players can shoot them
// (per-hit damage) to clear a misplaced wall.
// ─────────────────────────────────────────────────────────────────────────────
export const CRATE_CONFIG: WeaponBalance & {
  /** Hit points of a deployed crate (the horde claws through this). */
  hp: number;
  /** Always false: a destroyed crate collapses, it never detonates. */
  explodes: boolean;
} = {
  name: 'Crate',
  kind: 'deployable',
  /** Nominal — crates never detonate, so `damage` is never dealt. */
  damage: 25,
  damageFalloff: 0,
  /** Placement cadence — the limiting factor (stock is infinite). */
  fireIntervalMs: 1200,
  magSize: 0, // infinite stock: the cadence, not supply, limits wall-building
  pelletCount: 1,
  spread: 0,
  maxRange: 0,
  closeRangeThreshold: 0,
  closeRangeDamage: 0,
  projectileSpeed: 0,
  lifeSeconds: 0,
  explosionRadius: 0, // non-explosive by design
  comboTier: 1,
  pierce: false,
  recoil: 0.08,
  tracerColor: 0xc89a5a,
  hp: 150,
  explodes: false,
};

export const MINE_CONFIG: WeaponBalance = {
  name: 'Mine',
  kind: 'deployable',
  damage: 120,
  damageFalloff: 0,
  fireIntervalMs: 1500,
  magSize: 4,
  pelletCount: 1,
  spread: 0,
  maxRange: 0,
  closeRangeThreshold: 0,
  closeRangeDamage: 0,
  projectileSpeed: 0,
  /** Mine fuse after it is tripped. */
  lifeSeconds: 1,
  explosionRadius: 3.5,
  comboTier: 4,
  pierce: false,
  recoil: 0.1,
  tracerColor: 0xcc3333,
};

export const ROCKET_CONFIG: WeaponBalance = {
  name: 'Rocket Launcher',
  kind: 'projectile',
  damage: 100,
  damageFalloff: 0,
  fireIntervalMs: 1500,
  magSize: 4,
  pelletCount: 1,
  spread: 0.03,
  maxRange: 0,
  closeRangeThreshold: 0,
  closeRangeDamage: 0,
  projectileSpeed: 24,
  /** Dud self-destruct timeout. */
  lifeSeconds: 3,
  explosionRadius: 5,
  comboTier: 4,
  pierce: false,
  recoil: 0.18,
  tracerColor: 0xffaa33,
};

export const RAILGUN_CONFIG: WeaponBalance = {
  name: 'Railgun',
  kind: 'hitscan',
  damage: 150,
  damageFalloff: 0,
  fireIntervalMs: 1600,
  magSize: 3,
  pelletCount: 1,
  spread: 0,
  maxRange: 120,
  closeRangeThreshold: 0,
  closeRangeDamage: 0,
  projectileSpeed: 0,
  lifeSeconds: 0,
  explosionRadius: 0,
  comboTier: 5,
  pierce: true,
  recoil: 0.2,
  tracerColor: 0x88ddff,
};

/** Ordered to match `WeaponId` in weapons.ts. */
export const WEAPON_BALANCE: readonly WeaponBalance[] = [
  PISTOL_CONFIG,
  SHOTGUN_CONFIG,
  UZI_CONFIG,
  GRENADE_CONFIG,
  BARREL_CONFIG,
  MINE_CONFIG,
  ROCKET_CONFIG,
  RAILGUN_CONFIG,
  CRATE_CONFIG,
];

/**
 * Minimum kill multiplier required to fire each weapon (index = weapon id).
 * Grenade sits between the Uzi and the Barrel so explosives arrive early.
 */
export const WEAPON_MULTIPLIER_REQUIREMENT: Readonly<Record<number, number>> = {
  0: 0, // Pistol — starter
  1: 4, // Shotgun
  2: 8, // Uzi
  3: 10, // Grenade — Wave 2 / early kill combo
  4: 16, // Barrel / Wall
  5: 16, // Mine
  6: 20, // Rocket Launcher
  7: 24, // Railgun
  8: 1, // Wooden crate — early-access fortification (before the shotgun)
};

// ─────────────────────────────────────────────────────────────────────────────
// DROPS — floating item/weapon cubes left by dead mobs
// ─────────────────────────────────────────────────────────────────────────────
export interface DropBalance {
  /** Overall drop-frequency multiplier: 0.70 = exactly 30% fewer drops. */
  mobDropMultiplier: number;
  /** Probability (0..1) that a defeated mob drops anything, before the
   * global frequency multiplier above. */
  baseDropRate: number;
  /** Derived effective drop probability = baseDropRate × mobDropMultiplier. */
  effectiveDropRate: number;
  /** Relative weights for each drop kind (higher = more common). */
  dropWeights: Readonly<Record<'shotgun' | 'uzi' | 'grenade' | 'barrel' | 'power', number>>;
  /** Ammo granted by each weapon pickup (also its unlock amount). */
  pickupAwards: Readonly<Record<'shotgun' | 'uzi' | 'grenade' | 'barrel', number>>;
  /** Seconds a dropped pickup stays on the ground before it despawns. */
  pickupLifeSeconds: number;
  /** Final seconds of `pickupLifeSeconds` spent flashing out a warning blink. */
  pickupWarningSeconds: number;
  /** Toggle period of the despawn warning blink, in seconds. */
  pickupBlinkInterval: number;
  /** Walk-over collection radius. */
  pickupRadius: number;
  /** HP restored by a health-pack drop (boss loot). */
  healthRestore: number;
}

/** Base drop chance before the global frequency multiplier (35% drop rate). */
const BASE_DROP_RATE = 0.35;
/** Global frequency multiplier: set to 1 so the effective rate matches BASE_DROP_RATE directly. */
const DROP_MULTIPLIER = 1;

/**
 * THE drop-tuning table. `mobDropMultiplier: 0.70` reduces the overall drop
 * frequency of floating cubes by exactly 30% — edit it (or the loot weights
 * and ammo awards) without touching any engine logic.
 */
export const DROP_CONFIG: DropBalance = {
  mobDropMultiplier: DROP_MULTIPLIER,
  baseDropRate: BASE_DROP_RATE,
  effectiveDropRate: BASE_DROP_RATE * DROP_MULTIPLIER,
  dropWeights: {
    shotgun: 20,
    // Uzi is deliberately the most common weapon drop.
    uzi: UZI_CONFIG.dropRateWeight,
    grenade: 15,
    barrel: 12,
    power: 10,
  },
  pickupAwards: {
    shotgun: 5,
    uzi: 25,
    grenade: 2,
    barrel: 5,
  },
  /** Memory-friendly: ground cubes clean themselves up after 15 s. */
  pickupLifeSeconds: 15,
  /** The last 3 s flicker before removal. */
  pickupWarningSeconds: 3,
  /** ~6.7 blinks/second during the warning window. */
  pickupBlinkInterval: 0.15,
  pickupRadius: 0.9,
  healthRestore: 50,
};

// ─────────────────────────────────────────────────────────────────────────────
// WAVE / DROPS
// ─────────────────────────────────────────────────────────────────────────────
export interface WaveBalance {
  /** Clear the wave → every player returns to full HP. */
  fullHpRestoreOnWaveEnd: boolean;
  /** Probability (0..1) that a defeated mob drops anything at all, before the
   * global frequency multiplier below. */
  baseDropRate: number;
  /** Global drop-frequency multiplier applied to `baseDropRate`.
   * 0.70 = drops are exactly 30% less frequent than before. */
  dropRateMultiplier: number;
  /** Derived effective drop probability = baseDropRate × dropRateMultiplier. */
  mobDropRate: number;
  /** Relative weights for each drop kind (higher = more common). */
  dropWeights: Readonly<Record<'shotgun' | 'uzi' | 'grenade' | 'barrel' | 'power', number>>;
  /** Ammo granted by each weapon pickup (also its unlock amount). */
  pickupAwards: Readonly<Record<'shotgun' | 'uzi' | 'grenade' | 'barrel', number>>;
  /** Seconds a dropped pickup stays on the ground before it despawns. */
  pickupLifeSeconds: number;
  /** Final seconds of `pickupLifeSeconds` spent flashing out a warning blink. */
  pickupWarningSeconds: number;
  /** Toggle period of the despawn warning blink, in seconds. */
  pickupBlinkInterval: number;
  /** Walk-over collection radius. */
  pickupRadius: number;
  /** HP restored by a health-pack drop (boss loot). */
  healthRestore: number;
}

/** The −30% drop-frequency knob, re-exported for tests and engine imports.
 * The authoritative value lives on `DROP_CONFIG.mobDropMultiplier`. */
export const DROP_RATE_MULTIPLIER = DROP_CONFIG.mobDropMultiplier;

export const WAVE_CONFIG: WaveBalance = {
  /** Clear the wave → every *living* player returns to full HP (Solo + Co-op). */
  fullHpRestoreOnWaveEnd: true,
  baseDropRate: DROP_CONFIG.baseDropRate,
  dropRateMultiplier: DROP_CONFIG.mobDropMultiplier,
  /** 0.70 × 0.70 = 0.49 → exactly 30% fewer drops than the 0.70 base. */
  mobDropRate: DROP_CONFIG.effectiveDropRate,
  dropWeights: DROP_CONFIG.dropWeights,
  pickupAwards: DROP_CONFIG.pickupAwards,
  pickupLifeSeconds: DROP_CONFIG.pickupLifeSeconds,
  pickupWarningSeconds: DROP_CONFIG.pickupWarningSeconds,
  pickupBlinkInterval: DROP_CONFIG.pickupBlinkInterval,
  pickupRadius: DROP_CONFIG.pickupRadius,
  healthRestore: DROP_CONFIG.healthRestore,
};

// ─────────────────────────────────────────────────────────────────────────────
// PLAYER
// ─────────────────────────────────────────────────────────────────────────────
export interface PlayerBalance {
  maxHp: number;
  speed: number;
  radius: number;
  /** Units/second the weapon recoil kick recovers at. */
  recoilRecovery: number;
  /** Seconds of POWER ×2 from a pickup. */
  powerDuration: number;
}

export const PLAYER_CONFIG: PlayerBalance = {
  maxHp: 100,
  speed: 9,
  radius: 0.4,
  recoilRecovery: 1.6,
  powerDuration: 8,
};

// ─────────────────────────────────────────────────────────────────────────────
// CO-OP (Local 2-Player) — downed/revive loop
// ─────────────────────────────────────────────────────────────────────────────
export interface CoopBalance {
  /** Seconds a downed player waits before their partner revives them. */
  reviveCountdown: number;
  /** Seconds of fast-flashing invulnerability granted on revive. */
  reviveInvulnerability: number;
  /** Visual blink period while downed (mesh toggles visibility). */
  blinkInterval: number;
  /** Visual blink period during post-revive invulnerability (faster). */
  invulnBlinkInterval: number;
  /** Radius of the glowing revive circle drawn around a downed player. */
  reviveCircleRadius: number;
  /** Seconds the partner must hold inside the circle to fast-track a revive. */
  reviveHoldSeconds: number;
}

export const COOP_CONFIG: CoopBalance = {
  reviveCountdown: 10.0,
  reviveInvulnerability: 2.0,
  blinkInterval: 0.15,
  invulnBlinkInterval: 0.075,
  /** Glowing "high-five" ring: a partner standing within 1.8 u holds a revive. */
  reviveCircleRadius: 1.8,
  /** 2.5 s of continuous hold revives instantly (the 10 s timer keeps ticking). */
  reviveHoldSeconds: 2.5,
};

// ─────────────────────────────────────────────────────────────────────────────
// ENEMIES / DIRECTOR
// ─────────────────────────────────────────────────────────────────────────────
export interface ZombieBalance {
  hp: number;
  speed: number;
  damage: number;
  radius: number;
  score: number;
}

/**
 * The Devil boss adds explosive armor to the plain zombie stats.
 *
 * `explosiveDamageCap` is the most damage a single explosion (grenade, barrel,
 * rocket, mine) may take from the Devil in one blast — a classic damage cap that
 * only ever *reduces* damage, so nothing else becomes stronger against it.
 */
export interface DevilBalance extends ZombieBalance {
  explosiveDamageCap: number;
}

export interface BlackDevilBalance extends DevilBalance {
  /** Attack 1 — spinning fireball: 4 orbiting cubes fired at range. */
  spinnerSpeed: number;
  spinnerLife: number;
  spinnerDamage: number;
  /** Seconds between spinner volleys. */
  spinnerInterval: number;
  /** How sharply a spinner steers after launch, in radians/second (low = dodgeable). */
  spinnerTurnRate: number;
  /** Distance band the boss holds while in its ranged stance. */
  spinnerRangeMin: number;
  spinnerRangeMax: number;
  /** Orbit spin rate of the 4 cubes (radians/second). */
  spinnerSpinRate: number;
  /** Attack 2 — radial shockwave (close-range defense). */
  /** Outer radius (world units) the expanding ring grows to before it fades. */
  shockwaveRadius: number;
  /** Flat damage dealt to every player the ring's perimeter actually touches. */
  shockwaveDamage: number;
  /** Strict internal cooldown between shockwaves, in seconds. */
  shockwaveCooldown: number;
  /** A player closer than this triggers a shockwave (when off cooldown). */
  shockwaveTriggerRange: number;
  /** World units/second the ring perimeter expands outward (see
   * `SHOCKWAVE_EXPANSION_SPEED`, the single tuning knob for this). */
  shockwaveExpansionSpeed: number;
  /** Half-thickness of the expanding ring's damage band, in world units. The
   * perimeter must physically sweep a victim's body to connect, so this sets
   * how forgiving that contact test is (a small band = a thin wave). */
  shockwaveRingThickness: number;
  /**
   * Curse (co-op) — a player the shockwave lands on takes ticking damage until
   * a teammate stands in the cleansing circle for `curseCleanseSeconds`.
   */
  /** HP lost on every curse damage tick. */
  curseDamage: number;
  /** Seconds between curse damage ticks. */
  curseTickInterval: number;
  /** Radius (world units / platform blocks) of the cleansing circle. */
  curseRadius: number;
  /** Seconds a teammate must hold inside the circle to lift the curse. */
  curseCleanseSeconds: number;
  /** Attack 3 — telegraphed purple tracking laser. */
  /** Telegraph wind-up: the boss stands still and paints a thin aim line. */
  laserTelegraph: number;
  /** Channel duration of the thick beam. */
  laserDuration: number;
  /** Seconds after the beam ends before the next telegraph. */
  laserCooldown: number;
  laserRange: number;
  /** Half-width of the beam's damage volume (world units). */
  laserHalfWidth: number;
  /** How fast the beam tracks its target, in radians/second (inertia). */
  laserTurnRate: number;
  /** Damage per beam tick to a player caught in the beam. */
  laserDamage: number;
  /** Seconds between beam damage ticks. */
  laserTickInterval: number;
  /** Loot explosion on death: how many reward cubes drop (inclusive range). */
  lootDropMin: number;
  lootDropMax: number;
}

/**
 * Black Devil shockwave expansion speed, in world units per second.
 *
 * This is THE knob for Attack 2's travel time: the ring races outward at this
 * exact speed on both the server authority and the offline client AI, so the
 * reaction window (dodge or reach cover) is identical in every mode. Exposed as
 * a standalone constant because it is the single most-tuned boss value.
 */
export const SHOCKWAVE_EXPANSION_SPEED = 10;

export interface EnemyBalance {
  walker: ZombieBalance;
  runner: ZombieBalance;
  devil: DevilBalance;
  /** Wave-7 boss: black, 1.5× the red Devil, three synchronized attacks. */
  blackDevil: BlackDevilBalance;
  /** Melee reach added to the zombie radius. */
  attackRange: number;
  /** Grace period between a zombie's melee hits, in seconds. */
  attackCooldown: number;
  /** Seconds a zombie spends between bites when chewing a barrel. */
  wallAttackInterval: number;
  /** Devil fireball pacing. */
  devilFireInterval: number;
  devilFireRangeMin: number;
  devilFireRangeMax: number;
  /** Hits at or below this rate-of-fire interval suppress devil attacks (ms). */
  rapidFireIntervalMs: number;
  suppressDuration: number;
  /** Devil fireball: flight speed, lifetime, homing turn rate, impact damage. */
  fireballSpeed: number;
  fireballLife: number;
  fireballTurnRate: number;
  fireballDamage: number;
  /** Devil phase 2: enrage once HP drops to this fraction of max (0.5 = 50%). */
  devilPhase2HpFraction: number;
  /** Seconds between phase-2 dash charges. */
  devilDashInterval: number;
  /** Wind-up telegraph before a dash — the Devil holds still. */
  devilDashWindup: number;
  /** Charge speed multiplier applied to the Devil's base speed. */
  devilDashSpeedMultiplier: number;
  /** Maximum duration of a single dash charge. */
  devilDashDuration: number;
  /** Seconds a fiery hazard patch keeps burning on the floor. */
  devilTrailLife: number;
  /** Damage a trail patch deals per tick to a player standing on it. */
  devilTrailDamage: number;
  /** Seconds between trail damage ticks. */
  devilTrailTick: number;
  /** How often a charging Devil drops a trail patch. */
  devilTrailDropInterval: number;
  /** World-unit radius of a trail hazard patch. */
  devilTrailRadius: number;
}

export const ENEMY_CONFIG: EnemyBalance = {
  walker: { hp: 60, speed: 2.0, damage: 10, radius: 0.45, score: 10 },
  runner: { hp: 10, speed: 3.6, damage: 7, radius: 0.4, score: 15 },
  // Boss resilience. Invariant (asserted by shared/test/balance.test.ts):
  //   explosiveDamageCap < hp ≤ 2 × explosiveDamageCap
  // so ONE direct grenade blast wounds the Devil and exactly TWO destroy it,
  // while standard mobs (60 / 40 HP) stay a guaranteed one-hit kill because
  // GRENADE_CONFIG.damage (9999) is far above their HP at any blast distance.
  devil: {
    hp: 600, // 500 < 850 ≤ 1000 → exactly two direct explosions
    speed: 1.8,
    damage: 15,
    radius: 0.7,
    score: 100,
    // damage taken per explosion, whatever the falloff — shared with GRENADE_CONFIG.damageToDevil
    explosiveDamageCap: DEVIL_EXPLOSIVE_CAP,
  },
  // Wave-7 BLACK DEVIL — 1200 HP, three server-authoritative attacks:
  //  A1 spinning fireball (4 orbiting cubes), A2 radial shockwave (<=3 u),
  //  A3 telegraphed purple tracking laser (1 s telegraph + 3.5 s channel).
  blackDevil: {
    hp: 1200,
    speed: 1.6,
    damage: 20,
    // ~1.5× the red Devil's rendered body (0.7 u × 1.15 scale ⇒ ~1.05 u here).
    radius: 1.05,
    score: 500,
    // Three direct grenade blasts fell it (400 < 1200 ≤ 1200); one never does.
    explosiveDamageCap: 400,
    spinnerSpeed: 8,
    spinnerLife: 5,
    spinnerDamage: 18,
    spinnerInterval: 2.6,
    spinnerTurnRate: 0.9,
    spinnerRangeMin: 3,
    spinnerRangeMax: 13,
    spinnerSpinRate: 9,
    shockwaveRadius: 15,
    shockwaveDamage: 25,
    shockwaveCooldown: 4.5,
    shockwaveTriggerRange: 10,
    // 4 u ring at 12 u/s: a 0.33 s window to break line-of-sight behind cover.
    shockwaveExpansionSpeed: SHOCKWAVE_EXPANSION_SPEED,
    shockwaveRingThickness: 0.5,
    // Curse: 5 HP/second until cleansed by a teammate's 3 s hold in the 2 u zone.
    curseDamage: 5,
    curseTickInterval: 1,
    curseRadius: 2,
    curseCleanseSeconds: 3,
    laserTelegraph: 1.0,
    laserDuration: 3.5,
    laserCooldown: 8.0,
    laserRange: 24,
    laserHalfWidth: 0.7,
    // Slack enough that a sprinting/strafe-dodging player can out-run the turn.
    laserTurnRate: 0.5,
    laserDamage: 10,
    laserTickInterval: 0.25,
    lootDropMin: 3,
    lootDropMax: 4,
  },
  attackRange: 1.05,
  attackCooldown: 0.9,
  wallAttackInterval: 0.5,
  devilFireInterval: 3.5,
  devilFireRangeMin: 7,
  devilFireRangeMax: 11,
  rapidFireIntervalMs: 150,
  suppressDuration: 1.2,
  fireballSpeed: 7,
  fireballLife: 5,
  fireballTurnRate: 2.6,
  fireballDamage: 15,
  // Phase 2 "rage": at or below half HP the Devil burns and starts dashing.
  devilPhase2HpFraction: 0.5,
  devilDashInterval: 3.5,
  devilDashWindup: 0.5,
  devilDashSpeedMultiplier: 2.5,
  devilDashDuration: 1.2,
  devilTrailLife: 2.0,
  devilTrailDamage: 10,
  devilTrailTick: 0.5,
  devilTrailDropInterval: 0.09,
  devilTrailRadius: 0.55,
};

export interface DirectorBalance {
  /** Seconds before wave 1 starts. */
  openingIntermission: number;
  /** Nominal intermission length, in seconds (the window's midpoint). */
  waveIntermissionSec: number;
  /** Randomised intermission window: minimum seconds between waves. */
  waveIntermissionMinSec: number;
  /** Randomised intermission window: maximum seconds between waves. */
  waveIntermissionMaxSec: number;
  /** Zombies added per wave, and the floor/cap. */
  baseCount: number;
  perWaveCount: number;
  maxCount: number;
  /** Zombies released per batch and the gap between batches. */
  spawnBatchSize: number;
  spawnInterval: number;
  /** Wave at which runners/devils start appearing. */
  runnerFromWave: number;
  devilFromWave: number;
  maxDevils: number;
  /** Wave that hosts the Black Devil boss encounter. */
  blackDevilWave: number;
  /** Normal mob-count multiplier on the boss wave (0.5 = −50% small mobs). */
  blackDevilMobCountMultiplier: number;
  /** Living-zombie count at (or below) which the survivors ENRAGE. */
  enrageThreshold: number;
  /** Movement-speed multiplier applied to enraged zombies (1.75 = +75%). */
  enrageSpeedMultiplier: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// SPECIAL WAVE EVENTS — themed variant waves every few rounds
// ─────────────────────────────────────────────────────────────────────────────
export type WaveEventKind = 'none' | 'speedHorde' | 'blackout';

export interface WaveEventBalance {
  /** Event waves repeat with this period, in waves (8 → every 4th wave). */
  period: number;
  /** Speed-horde waves sit at `wave % period === speedHordeOffset` (4, 12, …). */
  speedHordeOffset: number;
  /** Blackout waves sit at `wave % period === blackoutOffset` (8, 16, …). */
  blackoutOffset: number;
  /** Extra movement speed for a speed-horde runner (+0.8 = +80%). */
  runnerSpeedBonus: number;
}

export const WAVE_EVENT_CONFIG: WaveEventBalance = {
  period: 8,
  speedHordeOffset: 3,
  blackoutOffset: 5, 
  runnerSpeedBonus: 0.8,
};

export const DIRECTOR_CONFIG: DirectorBalance = {
  openingIntermission: 4,
  /** Between-wave grace period: a randomised 7.0–10.0 s window (≈8.5 s). */
  waveIntermissionSec: 8.5,
  waveIntermissionMinSec: 7.0,
  waveIntermissionMaxSec: 10.0,
  baseCount: 4,
  perWaveCount: 3,
  maxCount: 40,
  spawnBatchSize: 3,
  spawnInterval: 0.5,
  runnerFromWave: 2,
  devilFromWave: 3,
  maxDevils: 4,
  blackDevilWave: 7,
  blackDevilMobCountMultiplier: 0.5,
  /** Last-ditch sprint: no downtime once the wave is nearly cleared. */
  enrageThreshold: 3,
  enrageSpeedMultiplier: 1.75,
};

// ─────────────────────────────────────────────────────────────────────────────
// FX
// ─────────────────────────────────────────────────────────────────────────────
export interface FxBalance {
  tracerLife: number;
  muzzleFlashLife: number;
  impactLife: number;
  impactScale: number;
  explosionFlashLife: number;
}

export const FX_CONFIG: FxBalance = {
  tracerLife: 0.12,
  muzzleFlashLife: 0.08,
  impactLife: 0.1,
  impactScale: 0.3,
  explosionFlashLife: 0.25,
};

// ─────────────────────────────────────────────────────────────────────────────
// GRENADE ARC / EXPLOSION PHYSICS
// ─────────────────────────────────────────────────────────────────────────────
export interface PhysicsBalance {
  /** Downward acceleration applied to a thrown grenade. */
  grenadeGravity: number;
  /** Energy retained when a grenade bounces off the floor (0..1). */
  grenadeBounce: number;
  /** Height at which a grenade is considered to be resting on the ground. */
  groundY: number;
  /** Fraction of blast damage shed at the edge of the radius. */
  explosionFalloff: number;
}

export const PHYSICS_CONFIG: PhysicsBalance = {
  grenadeGravity: 26,
  grenadeBounce: 0.45,
  groundY: 0.3,
  explosionFalloff: 0.6,
};

// ─────────────────────────────────────────────────────────────────────────────
// GAME FEEL / JUICE — camera trauma, hit-stop and voxel gib particles
// ─────────────────────────────────────────────────────────────────────────────
export interface FeelBalance {
  /** Trauma added by a close-range shotgun blast (light kick). */
  shotgunTrauma: number;
  /** Trauma added by a grenade / rocket / mine detonation (medium shake). */
  explosionTrauma: number;
  /** Trauma added by an explosive-barrel chain detonation (heavy rumble). */
  barrelChainTrauma: number;
  /** Trauma added by the Black Devil's radial shockwave (subtle shake). */
  shockwaveTrauma: number;
  /** Trauma shed per second — higher is a snappier, shorter shake. */
  traumaDecay: number;
  /** Maximum camera displacement in world units at full trauma. */
  shakeMaxOffset: number;  /** Maximum camera roll in radians at full trauma. */
  shakeMaxRoll: number;
  /** Shake oscillator frequency in Hz (how fast the camera jitters). */
  shakeFrequency: number;
  /** Seconds of micro-freeze on a heavy impact (30 ms). */
  hitStopSeconds: number;
  /** Voxel gibs spawned by a standard zombie death (min / max). */
  gibCountMin: number;
  gibCountMax: number;
  /** Voxel gibs spawned by a boss death. */
  gibCountBoss: number;
  /** Seconds a gib lives before it fades out completely. */
  gibLifeSeconds: number;
  /** Downward acceleration applied to every gib. */
  gibGravity: number;
  /** Random outward launch speed range for gibs (world units/second). */
  gibSpeedMin: number;
  gibSpeedMax: number;
  /** Reusable gib meshes allocated once (nothing is created mid-wave). */
  gibPoolSize: number;
}

export const JUICE_CONFIG: FeelBalance = {
  /** Task tuning: 0.08 s light kick for a point-blank shotgun. */
  shotgunTrauma: 0.08,
  /** Task tuning: 0.2 s medium shake for a grenade blast. */
  explosionTrauma: 0.2,
  /** Task tuning: 0.35 s heavy directional rumble for a barrel chain. */
  barrelChainTrauma: 0.35,
  /** Task tuning: 0.22 s subtle shake for the boss's close-range shockwave. */
  shockwaveTrauma: 0.22,
  /** Trauma decays fully in ~1.4 s from 1.0. */
  traumaDecay: 0.7,
  /** Full-trauma shake nudges the camera by 0.35 world units. */
  shakeMaxOffset: 0.35,
  /** Full-trauma shake rolls the camera ~1.4°. */
  shakeMaxRoll: 0.025,
  /** ~28 Hz jitter reads as a crunchy punch, not a slow wave. */
  shakeFrequency: 28,
  /** 30 ms frame freeze on heavy impacts (grenade / point-blank shotgun). */
  hitStopSeconds: 0.03,
  gibCountMin: 4,
  gibCountMax: 6,
  gibCountBoss: 14,
  gibLifeSeconds: 1.0,
  gibGravity: 22,
  gibSpeedMin: 2.5,
  gibSpeedMax: 6.5,
  /** 96 pooled cubes — far more than a burst ever needs. */
  gibPoolSize: 96,
};

// ─────────────────────────────────────────────────────────────────────────────
// PROCEDURAL AUDIO — zero-asset Web Audio synthesis (no MP3/WAV files)
// ─────────────────────────────────────────────────────────────────────────────
/** Oscillator waveforms accepted by the Web Audio API (DOM-free alias). */
export type Waveform = 'sine' | 'square' | 'sawtooth' | 'triangle';

export interface SoundSpec {
  /** Peak gain (0..1) of this voice, before the master volume. */
  volume: number;
  /** Total envelope length in seconds (also the stop time). */
  duration: number;
  /** Tone start frequency in Hz (0 = noise-only voice). */
  freqStart: number;
  /** Tone end frequency in Hz (exponential glide). */
  freqEnd: number;
  /** White-noise mix in the voice (0..1; 0 = pure tone, 1 = pure noise). */
  noise: number;
  /** Low-pass cutoff for the noise layer in Hz (0 = bypass, full band). */
  lowpass: number;
  /** Oscillator waveform used for the tonal layer. */
  wave: Waveform;
}

export interface AudioBalance {
  /** Master gain applied to every synthesized voice (0..1). */
  masterVolume: number;
  /** Hard cap on voices scheduled per second (guards against spam). */
  maxVoicesPerSecond: number;
  pistol: SoundSpec;
  shotgun: SoundSpec;
  uzi: SoundSpec;
  explosion: SoundSpec;
  pickup: SoundSpec;
  zombieHit: SoundSpec;
  zombieDeath: SoundSpec;
  /** Black Devil radial shockwave (close-range boom). */
  shockwave: SoundSpec;
  /** Black Devil laser: rising charge hum at the start of each channel. */
  laser: SoundSpec;
}

export const AUDIO_CONFIG: AudioBalance = {
  masterVolume: 0.35,
  /** Uzi fire can reach ~18/s; cap slightly above so it never drops shots. */
  maxVoicesPerSecond: 24,
  /** High-frequency click/pop with quick decay. */
  pistol: { volume: 0.5, duration: 0.09, freqStart: 900, freqEnd: 220, noise: 0.5, lowpass: 6000, wave: 'square' },
  /** Heavy low-frequency punch + noisy burst. */
  shotgun: { volume: 0.9, duration: 0.28, freqStart: 180, freqEnd: 45, noise: 0.85, lowpass: 2200, wave: 'triangle' },
  /** Rapid micro-clicks with a short pitch envelope. */
  uzi: { volume: 0.3, duration: 0.05, freqStart: 1100, freqEnd: 320, noise: 0.45, lowpass: 7000, wave: 'square' },
  /** Low-passed white noise + sub-bass decay. */
  explosion: { volume: 1.0, duration: 0.7, freqStart: 90, freqEnd: 28, noise: 1.0, lowpass: 900, wave: 'sine' },
  /** Cheerful two-tone 8-bit arpeggio (the manager layers the second tone). */
  pickup: { volume: 0.4, duration: 0.22, freqStart: 660, freqEnd: 990, noise: 0, lowpass: 0, wave: 'square' },
  /** Low-pitched thud/crunch on a non-lethal hit. */
  zombieHit: { volume: 0.35, duration: 0.1, freqStart: 180, freqEnd: 70, noise: 0.6, lowpass: 1200, wave: 'triangle' },
  /** Deeper, wetter crunch when a zombie dies. */
  zombieDeath: { volume: 0.5, duration: 0.24, freqStart: 140, freqEnd: 40, noise: 0.8, lowpass: 900, wave: 'sawtooth' },
  /** Low sub-bass thump + a cushion of noise: the shockwave's pressure wave. */
  shockwave: { volume: 0.85, duration: 0.5, freqStart: 120, freqEnd: 30, noise: 0.9, lowpass: 800, wave: 'sine' },
  /** Rising sawtooth charge: the telegraph / beam wind-up sting. */
  laser: { volume: 0.45, duration: 0.6, freqStart: 320, freqEnd: 900, noise: 0.15, lowpass: 4000, wave: 'sawtooth' },
};

// ─────────────────────────────────────────────────────────────────────────────
// PERFORMANCE — 2D spatial hash broadphase for mob separation
// ─────────────────────────────────────────────────────────────────────────────
export interface SpatialBalance {
  /** Bucket edge length in world units (≈2 × the largest mob radius). */
  cellSize: number;
}

export const SPATIAL_CONFIG: SpatialBalance = {
  cellSize: 2,
};

// ─────────────────────────────────────────────────────────────────────────────
// COMBO MULTIPLIER — classic Boxhead kill-chain rules
// ─────────────────────────────────────────────────────────────────────────────
export interface ComboBalance {
  /** Seconds the combo is held after each kill before it resets to ×1. */
  windowSeconds: number;
  /** Multipliers that fire a spree banner + audio cue + speed boost. */
  milestones: readonly number[];
  /** Banner text keyed by milestone multiplier. */
  labels: Readonly<Record<number, string>>;
  /** Fractional move-speed bonus granted at a milestone (0.2 = +20%). */
  spreeSpeedBoost: number;
  /** Seconds the spree speed boost lasts. */
  spreeSpeedDuration: number;
}

export const COMBO_CONFIG: ComboBalance = {
  windowSeconds: 1.8,
  milestones: [10, 25, 50],
  labels: {
    10: 'SPREE!',
    25: 'UNSTOPPABLE!',
    50: 'GODLIKE!',
  },
  spreeSpeedBoost: 0.2,
  spreeSpeedDuration: 3,
};
