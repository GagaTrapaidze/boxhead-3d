/**
 * Boxhead 2Play Rooms — main orchestrator.
 * Wires the start modal (single / local duo / online placeholder), the input
 * manager, camera controller, combat glue (hitscan, projectiles, mines,
 * barricades), wave director, pickups and the HUD.
 *
 * Combat is keyboard-only: the player faces their movement direction (8-way)
 * and their shoot key fires along that facing (Solo: Space · Co-op P1: / or
 * Enter · Co-op P2: Space). Local co-op adds a 10 s downed/revive loop.
 */
import * as THREE from 'three';

import { WeaponId, getWeapon, hasAmmo, isReadyToFire } from '../../shared/src/weapons.ts';
import {
  comboMilestoneLabel,
  comboWindowSeconds,
  isComboMilestone,
} from '../../shared/src/combo.ts';
import {
  BARREL_CONFIG,
  COMBO_CONFIG,
  COOP_CONFIG,
  CRATE_CONFIG,
  DIRECTOR_CONFIG,
  ENEMY_CONFIG,
  JUICE_CONFIG,
  WAVE_CONFIG,
} from '../../shared/src/balance.config.ts';
import { advanceRevive, isInReviveCircle } from '../../shared/src/revive.ts';
import {
  CURSE_CLEANSE_SECONDS,
  advanceCurse,
  createCurseState,
  curseProgress,
  isInCurseCircle,
} from '../../shared/src/curse.ts';
import { waveEventLabel } from '../../shared/src/waveEvents.ts';
import type { WaveEventKind } from '../../shared/src/waveEvents.ts';

import { createWorld, loadMap, resizeWorld, updateSpawnGateWarnings } from './game/world.ts';
import type { World } from './game/world.ts';
import { applyGraphicsQuality, registerGraphicsWorld } from './game/graphics.ts';
import { DEFAULT_MAP_ID, getMap } from '../../shared/src/maps.ts';
import type { MapDefinition } from '../../shared/src/maps.ts';
import { CameraController } from './game/camera.ts';
import { InputManager } from './game/input.ts';
import type { GameMode } from './game/input.ts';
import {
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  applyRecoil,
  comboReset,
  comboTick,
  createPlayer,
  cycleWeapon,
  decayRecoil,
  ensureWeaponUnlocked,
  fireHitscan,
  healToFull,
  movePlayer,
  registerKill,
  removePlayerMesh,
  selectSlot,
  setAimDirection,
  syncActor,
} from './game/player.ts';
import { updateWeaponMesh } from './game/actors.ts';
import type { CharacterId } from './game/actors.ts';
import type { Player } from './game/player.ts';
import {
  RAPID_FIRE_INTERVAL_MS,
  SUPPRESS_DURATION,
  applySuppression,
  createDirector,
  createHorde,
  removeZombie,
  spawnZombie,
  updateDirector,
  updateHorde,
} from './game/enemies.ts';
import type { Director, Horde, Zombie } from './game/enemies.ts';
import {
  BARRICADE_HIT_RADIUS,
  barrelAt,
  barricadeAt,
  damageBarricade,
  findPlacementCell,
  findStandingCell,
  placeBarricade,
  removeBarricade,
} from './game/barricades.ts';
import type { Barricade, BarricadeKind } from './game/barricades.ts';
import { NightMode } from './game/lighting.ts';
import { ReviveCircle } from './game/reviveCircle.ts';
import { CurseCircle } from './game/curseCircle.ts';
import type { CursedMarker } from './game/curseCircle.ts';
import { explode, spawnPlayerProjectile, updateProjectiles } from './game/projectiles.ts';
import type { ExplosionEvent, Flash, Projectile, ProjectileWorld } from './game/projectiles.ts';
import { applyPickup, rollDropKind, spawnBossLoot, spawnPickup, updatePickups } from './game/pickups.ts';
import type { Pickup } from './game/pickups.ts';
import type { PickupKind } from './game/actors.ts';
import { FxLayer } from './game/fx.ts';
import { BossFx } from './game/bossFx.ts';
import { GibLayer } from './game/gibs.ts';
import { audio } from './game/audio.ts';
import {
  hideOverlay,
  initMenu,
  setOnlineStatus,
  setRoomInfo,
  showMatchSummary,
  showMenu,
} from './ui/menu.ts';
import type { MatchSummary, PlayerSummary, StartMode } from './ui/menu.ts';
import { Lobby } from './network/lobby.ts';
import type { OnlinePlayer, RoomInfo } from './network/lobby.ts';
import { OnlineWorld } from './network/onlineWorld.ts';
import type { OnlineWorldContext } from './network/onlineWorld.ts';
import { weaponIconSvg } from './ui/weaponIcons.ts';

type Phase = 'menu' | 'playing' | 'over';

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
}

interface Mine {
  x: number;
  z: number;
  ownerIndex: number;
  mesh: THREE.Mesh;
}

const world: World = createWorld(byId('app'));
// Bind the scene to the persisted graphics mode (HIGH/LOW) and apply it now.
registerGraphicsWorld(world);

// HUD
const hud = byId('hud');
const multVal = byId('multVal');
const multFill = byId('multfill');
const mult2 = byId('mult2');
const scoreEl = byId('score');
const scoreLabelEl = byId('scoreLabel');
const waveEl = byId('wave');
const powerupEl = byId('powerup');
const powerTimeEl = byId('powerTime');
const messageEl = byId('message');
const flashEl = byId('flash');
const reviveLabelEl = byId('reviveLabel');
const mateLabelsWrap = byId('mateLabels');
const curseLabelsWrap = byId('curseLabels');
const comboBannerEl = byId('comboBanner');
const eventBannerEl = byId('eventBanner');
const waveTimerEl = byId('waveTimer');
const bossBar = byId('bossBar');
const bossFill = byId('bossFill');

/** DOM handles for one split-screen player status card. */
interface PlayerCard {
  root: HTMLElement;
  hpFill: HTMLElement;
  hpVal: HTMLElement;
  weapon: HTMLElement;
  icon: HTMLElement;
  ammoRow: HTMLElement;
  ammo: HTMLElement;
  revive: HTMLElement;
}

const card1: PlayerCard = {
  root: byId('card1'),
  hpFill: byId('hp1fill'),
  hpVal: byId('hp1val'),
  weapon: byId('weapon1'),
  icon: byId('wicon1'),
  ammoRow: byId('ammoRow1'),
  ammo: byId('ammo1'),
  revive: byId('revive1'),
};

const card2: PlayerCard = {
  root: byId('card2'),
  hpFill: byId('hp2fill'),
  hpVal: byId('hp2val'),
  weapon: byId('weapon2'),
  icon: byId('wicon2'),
  ammoRow: byId('ammoRow2'),
  ammo: byId('ammo2'),
  revive: byId('revive2'),
};

/** Scratch vector reused for HUD world→screen projection (never allocates). */
const REPROJECT = new THREE.Vector3();

// --- game state -------------------------------------------------------------
let phase: Phase = 'menu';
let mode: GameMode = 'single';
let lastMode: StartMode = 'single';
let lastMapId = DEFAULT_MAP_ID;
let input: InputManager | null = null;
let cameraRig: CameraController | null = null;
let players: Player[] = [];
let horde: Horde = createHorde();
let director: Director = createDirector();
let barricades: Barricade[] = [];
let projectiles: Projectile[] = [];
let flashes: Flash[] = [];
let pickups: Pickup[] = [];
let mines: Mine[] = [];
let score = 0;
/** The arena currently loaded into `world` (set on every match start). */
let currentMap: MapDefinition = getMap(DEFAULT_MAP_ID);
/** Authored horde spawn points for the active map, in engine {x, z} form. */
let zombieSpawnPoints: { x: number; z: number }[] = [];

// --- online (Colyseus) state ------------------------------------------------
/** True while the current match is an online room match. */
let isOnline = false;
/** Seat of the local player in the room (drives spawn placement + presence). */
let localSeat = 0;
/** Network-driven peer actors — visual only, never part of the local simulation. */
let remotePlayers: Player[] = [];
let remoteBySession = new Map<string, Player>();
/** Scratch list for camera framing (rebuilt each frame; capacity is tiny). */
const cameraPlayers: Player[] = [];
let onlineLobby: Lobby | null = null;
let onlineInfo: RoomInfo | null = null;

/**
 * Mirror of the server-authoritative world (mobs, props, drops, hazards). In an
 * online match the local `horde`/`barricades`/`pickups` arrays are *renders* of
 * this mirror — the server owns what exists, where it is and when it dies.
 */
const onlineWorld = new OnlineWorld();

/** Live view of the render arrays the mirror writes into. */
function onlineContext(): OnlineWorldContext {
  return { scene: world.scene, grid: world.grid, horde, barricades, pickups };
}

/**
 * Blasts we already resolved and reported this frame: the server echoes them
 * back (`explosion`), and the local flash has already played, so the echo must
 * not double it up.
 */
const pendingLocalExplosions: { x: number; z: number }[] = [];
/** A single client-resolved hit on a barrel always detonates it (as locally). */
const BARREL_SHOT_DAMAGE = 1000;

let toastText = '';
let toastTimer = 0;
function toast(text: string, seconds: number): void {
  toastText = text;
  toastTimer = seconds;
}

// --- persistence (all-time records) -----------------------------------------
const HIGH_WAVE_KEY = 'boxhead.highWave';
const HIGH_SCORE_KEY = 'boxhead.highScore';

/** Reads a stored record; 0 when absent or storage is blocked. */
function readRecord(key: string): number {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? 0 : Number(raw);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0; // private mode can throw on access
  }
}

function writeRecord(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    /* storage unavailable — records simply don't persist */
  }
}

// --- combo feedback ---------------------------------------------------------
let comboBannerTimeout = 0;

/** Pops the floating milestone banner (e.g. "×10 SPREE!"). */
function showComboBanner(text: string): void {
  comboBannerEl.textContent = text;
  comboBannerEl.hidden = false;
  comboBannerEl.classList.remove('show');
  void comboBannerEl.offsetWidth; // force reflow so the animation restarts
  comboBannerEl.classList.add('show');
  window.clearTimeout(comboBannerTimeout);
  comboBannerTimeout = window.setTimeout(() => {
    comboBannerEl.hidden = true;
    comboBannerEl.classList.remove('show');
  }, 950);
}

/** Grants the brief milestone speed boost (cleared when its timer lapses). */
function grantSpree(player: Player): void {
  player.speedMult = 1 + COMBO_CONFIG.spreeSpeedBoost;
  player.spreeTimer = COMBO_CONFIG.spreeSpeedDuration;
}

// --- wave-event banner -------------------------------------------------------
let eventBannerTimeout = 0;

/** Pops the themed wave-event banner ("SPEED HORDE!" / "BLACKOUT!"). */
function showEventBanner(text: string): void {
  eventBannerEl.textContent = text;
  eventBannerEl.hidden = false;
  eventBannerEl.classList.remove('show');
  void eventBannerEl.offsetWidth; // force reflow so the animation restarts
  eventBannerEl.classList.add('show');
  window.clearTimeout(eventBannerTimeout);
  eventBannerTimeout = window.setTimeout(() => {
    eventBannerEl.hidden = true;
    eventBannerEl.classList.remove('show');
  }, 1700);
}

// Pooled combat FX — tracers, muzzle flashes and the muzzle light. Everything
// is allocated once, so firing never allocates GPU resources mid-wave.
const fx = new FxLayer(world.scene);

// Pooled voxel gibs — one shared pool, recycled on every death (no GC spikes).
const gibs = new GibLayer(world.scene);

// Glowing co-op revive circle ("high-five" fast-track) — one mesh, repositioned
// around whichever player is currently downed.
const reviveCircle = new ReviveCircle(world.scene);

// Black Devil curse cleansing zones — the 2 u floor circles drawn around every
// cursed player, doubled as the radial cleanse-hold progress indicator.
const curseCircle = new CurseCircle(world.scene);
/** Scratch marker list rebuilt each frame (capacity is tiny — never grows). */
const curseMarkers: CursedMarker[] = [];

// Blackout-wave lighting rig: dims the arena and hands every player a
// flashlight cone along their facing (see game/lighting.ts).
const nightMode = new NightMode(world);

// Black Devil boss FX: the telegraphed laser line/beam and the radial
// shockwave rings (see game/bossFx.ts). Driven by the simulated boss state.
const bossFx = new BossFx(world.scene);

/** Blast profile of an explosive barrel (single source of truth: the table). */
const BARREL_BLAST = getWeapon(WeaponId.Barrel);

/**
 * Hit-stop: heavy impacts freeze the simulation for a few milliseconds before
 * resuming, which sells the weight of grenade blasts and point-blank shotgun
 * connections. Counted down at the top of `update`.
 */
let hitStopTimer = 0;
function requestHitStop(): void {
  hitStopTimer = Math.max(hitStopTimer, JUICE_CONFIG.hitStopSeconds);
}

/** A barrel waiting on its staggered chain fuse (0.08 s per link). */
interface ChainFuse {
  cx: number;
  cz: number;
  timer: number;
  /** Player index credited with the kill (−1 = the horde itself). */
  ownerIndex: number;
  /** Unit direction of the pushing blast, for the directional camera rumble. */
  dirX: number;
  dirZ: number;
}

let chainFuses: ChainFuse[] = [];

/** Shared resources for deployed mines — one geometry, one material, no per-drop allocation. */
const MINE_GEOMETRY = new THREE.BoxGeometry(0.5, 0.12, 0.5);
const MINE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xcc3333, roughness: 0.6 });

/** Fires the procedural gunshot matching the weapon (see game/audio.ts). */
function shotSound(weaponId: number): void {
  if (weaponId === WeaponId.Shotgun) audio.shotgun();
  else if (weaponId === WeaponId.Uzi) audio.uzi();
  else audio.pistol();
}

function flashDamage(): void {
  flashEl.style.opacity = '1';
  window.setTimeout(() => {
    flashEl.style.opacity = '0';
  }, 120);
}

// --- lifecycle --------------------------------------------------------------
/**
 * All actor / projectile / pickup meshes are built from shared cached
 * geometry & material (see game/actors.ts), so tearing one down is a plain
 * `scene.remove()`: no disposal, no GPU churn, no leaks across restarts.
 * Only genuinely per-instance materials are released (barricade tint,
 * explosion-flash colour).
 */
function removeMeshes(list: { mesh: THREE.Object3D }[]): void {
  for (const item of list) world.scene.remove(item.mesh);
  list.length = 0;
}

function clearWorld(): void {
  // Drop the mirrored world first: it removes its own proxies from the live
  // arrays, so nothing is left dangling across a match restart.
  onlineWorld.reset(onlineContext());
  removeMeshes(horde.zombies);
  horde.field = null;
  horde.fieldTimer = 0;
  director = createDirector();

  removeMeshes(projectiles);
  for (const flash of flashes) {
    world.scene.remove(flash.mesh, flash.light);
    (flash.mesh.material as THREE.Material).dispose(); // per-instance; geometry is shared
  }
  flashes.length = 0;

  for (const barricade of barricades) {
    world.grid.setBlocked(barricade.cx, barricade.cz, false);
    world.scene.remove(barricade.mesh);
    (barricade.mesh.material as THREE.Material).dispose(); // per-instance tint material
  }
  barricades.length = 0;

  for (const hazard of horde.hazards) {
    world.scene.remove(hazard.mesh);
    (hazard.mesh.material as THREE.Material).dispose(); // per-instance tint material
  }
  horde.hazards.length = 0;

  removeMeshes(mines);
  removeMeshes(pickups);
  fx.reset();
  gibs.reset();
  bossFx.reset();
  chainFuses = [];
  hitStopTimer = 0;
  reviveCircle.hide();
  curseCircle.hide();
  nightMode.reset();

  for (const player of players) removePlayerMesh(world.scene, player);
  players = [];
  for (const remote of remotePlayers) removePlayerMesh(world.scene, remote);
  remotePlayers = [];
  remoteBySession = new Map();
  score = 0;
  toastText = '';
  toastTimer = 0;
  isOnline = false;
}

function startGame(selectedMode: StartMode, mapId: string = lastMapId): void {
  lastMode = selectedMode;
  lastMapId = mapId;
  mode = selectedMode;
  isOnline = false; // local match — drop any online-only actors
  scoreLabelEl.textContent = 'ქულა';
  input?.dispose();
  input = new InputManager(mode);

  // Swap in the chosen arena: clear the previous match, then rebuild the map
  // (3D geometry + collision grid together) before any actor spawns onto it.
  clearWorld();
  currentMap = getMap(mapId);
  loadMap(world, currentMap);
  // The horde emerges from the map's perimeter gate alcoves when it declares
  // them; older maps without gates fall back to their authored spawn points.
  zombieSpawnPoints =
    currentMap.spawnGates.length > 0
      ? currentMap.spawnGates.map((gate) => ({ x: gate.x, z: gate.y }))
      : currentMap.zombieSpawns.map((s) => ({ x: s.x, z: s.y }));

  const spawns = currentMap.playerSpawns;
  const first = { x: spawns[0].x, z: spawns[0].y };
  if (mode === 'single') {
    players.push(createPlayer(world.scene, 0, 'bambo', first));
  } else {
    players.push(createPlayer(world.scene, 0, 'bambo', first));
    players.push(createPlayer(world.scene, 1, 'bon', { x: spawns[1].x, z: spawns[1].y }));
  }

  const center =
    mode === 'single'
      ? first
      : { x: (spawns[0].x + spawns[1].x) / 2, z: (spawns[0].y + spawns[1].y) / 2 };
  cameraRig = new CameraController(world, mode === 'single' ? 'single' : 'duo', center);

  // Apply the persisted graphics mode now that this match's arena and actors
  // exist, so LOW clears their shadow flags too (HIGH restores them).
  applyGraphicsQuality(world);

  hud.hidden = false;
  card2.root.hidden = mode !== 'duo';
  mult2.hidden = mode !== 'duo';
  phase = 'playing';
  toast(
    mode === 'single'
      ? `გადარჩი! — ${currentMap.name}`
      : `P1 მწვანე · P2 ლურჯი — ${currentMap.name}`,
    3
  );
}

// --- online match -----------------------------------------------------------
const CHARACTER_ORDER: CharacterId[] = ['bambo', 'bon', 'bind', 'bert'];

/** Spawn point for a seat, wrapping across the map's authored spawn slots. */
function spawnForSeat(seat: number): { x: number; z: number } {
  const spawns = currentMap.playerSpawns;
  const slot = spawns[seat % spawns.length];
  return { x: slot.x, z: slot.y };
}

function centroidOf(list: Player[]): { x: number; z: number } {
  if (list.length === 0) return { x: 0, z: 0 };
  let x = 0;
  let z = 0;
  for (const player of list) {
    x += player.x;
    z += player.z;
  }
  return { x: x / list.length, z: z / list.length };
}

/** Copies a peer's synchronized presence + life state onto its visual actor. */
function applyPresence(player: Player, presence: OnlinePlayer): void {
  const wasDowned = player.downed;
  player.hp = presence.hp;
  player.x = presence.x;
  player.z = presence.z;
  // Server-authoritative curse: the room owns the tick/cleanse clocks online.
  player.cursed = presence.cursed;
  player.cleanseProgress = presence.cleanseProgress;
  player.curse = null;
  const length = Math.hypot(presence.aimX, presence.aimZ);
  if (length > 1e-4) {
    player.aimX = presence.aimX / length;
    player.aimZ = presence.aimZ / length;
    player.facing = Math.atan2(player.aimX, player.aimZ);
  }
  if (player.weapon !== presence.weapon) {
    player.weapon = presence.weapon;
    updateWeaponMesh(player.mesh, player.weapon);
    player._lastWeaponId = player.weapon;
  }

  // Life state: a downed peer stays as a blinking ghost at their death spot
  // (the blink loop owns `mesh.visible` until they respawn).
  player.alive = presence.alive;
  player.downed = !presence.alive;
  player.reviveTimer = presence.respawnTimer;
  if (!presence.connected) {
    player.mesh.visible = false;
  } else if (presence.alive) {
    player.mesh.visible = true;
    if (wasDowned) player.blinkTimer = COOP_CONFIG.blinkInterval; // just respawned
  } else if (!wasDowned) {
    player.mesh.visible = true; // just went down — begin the ghost blink
    player.blinkTimer = COOP_CONFIG.blinkInterval;
  }
  syncActor(player);
}

/** Adds, updates and removes remote peer actors to match the room's player list. */
function syncRemotePlayers(info: RoomInfo): void {
  const seen = new Set<string>();
  for (const peer of info.players) {
    if (peer.sessionId === info.selfId) continue;
    seen.add(peer.sessionId);
    let remote = remoteBySession.get(peer.sessionId);
    if (!remote) {
      remote = createPlayer(
        world.scene,
        0,
        CHARACTER_ORDER[peer.seat % CHARACTER_ORDER.length],
        spawnForSeat(peer.seat)
      );
      remoteBySession.set(peer.sessionId, remote);
      remotePlayers.push(remote);
    }
    applyPresence(remote, peer);
  }
  for (const [sessionId, remote] of [...remoteBySession]) {
    if (seen.has(sessionId)) continue; // still connected
    removePlayerMesh(world.scene, remote);
    remoteBySession.delete(sessionId);
    const index = remotePlayers.indexOf(remote);
    if (index >= 0) remotePlayers.splice(index, 1);
  }
}

/** Sends the local player's transform to the room (~20 Hz, throttled inside). */
function publishPresence(): void {
  const local = players[0];
  if (!local || !onlineLobby) return;
  onlineLobby.sendPresence({
    x: local.x,
    z: local.z,
    aimX: local.aimX,
    aimZ: local.aimZ,
    hp: Math.round(local.hp),
    weapon: local.weapon,
    // The room scores every kill with the shooter's live combo, so its shared
    // team total always matches the multiplier this client is showing.
    mult: local.mult,
  });
}

/**
 * Online downed state: no action, ghost blink. The 10 s countdown is
 * authoritative on the server and mirrored into `reviveTimer` each patch, so
 * the client never runs its own revive math here.
 */
function enterOnlineDowned(player: Player): void {
  player.hp = 0;
  player.alive = false; // no targeting, damage or pickups
  player.downed = true;
  player.reviveTimer = COOP_CONFIG.reviveCountdown;
  player.reviveHold = 0;
  player.blinkTimer = COOP_CONFIG.blinkInterval;
  player.mesh.visible = true; // ghost blinks at the death spot
  toast(`დაეცი! · აღდგენა ${COOP_CONFIG.reviveCountdown}s-ში`, 2.5);
}

/** Ghost blink for a downed player (online); the server owns the timer. */
function tickOnlineDowned(player: Player, dt: number): void {
  player.blinkTimer -= dt;
  if (player.blinkTimer <= 0) {
    player.mesh.visible = !player.mesh.visible;
    player.blinkTimer = COOP_CONFIG.blinkInterval;
  }
}

/** Mirrors the server's life state onto the one locally-simulated player. */
function syncLocalPlayer(info: RoomInfo): void {
  const local = players[0];
  const me = info.players.find((p) => p.sessionId === info.selfId);
  if (!local || !me) return;

  // Curse status is server-owned online: mirror it for the ground circle + HUD.
  local.cursed = me.cursed;
  local.cleanseProgress = me.cleanseProgress;
  local.curse = null;
  local.reviveTimer = me.respawnTimer;
  if (!me.alive) {
    if (!local.downed) enterOnlineDowned(local);
    local.hp = 0;
    return;
  }
  if (local.downed) respawnLocalPlayer(local, me);
}

/** Revives the local player at the server-authored safe spawn, full HP/Pistol. */
function respawnLocalPlayer(local: Player, presence: OnlinePlayer): void {
  local.downed = false;
  local.alive = true;
  local.hp = PLAYER_MAX_HP;
  local.x = presence.x;
  local.z = presence.z;
  local.aimX = 1;
  local.aimZ = 0;
  local.facing = Math.atan2(local.aimX, local.aimZ);
  local.invulnTimer = COOP_CONFIG.reviveInvulnerability;
  local.blinkTimer = COOP_CONFIG.invulnBlinkInterval;
  local.reviveTimer = 0;
  local.reviveHold = 0;
  local.recoil = 0;
  // Inventory reset: starter Pistol only (matches the local co-op revive).
  local.ammo.clear();
  local.granted.clear();
  local.weapon = WeaponId.Pistol;
  updateWeaponMesh(local.mesh, WeaponId.Pistol);
  local._lastWeaponId = WeaponId.Pistol;
  local.mesh.visible = true;
  syncActor(local);
  toast(`აღდგენილი ხარ! · ${COOP_CONFIG.reviveInvulnerability}s უვნებლობა`, 2.5);
}

/** Projects a world point to screen pixels (reuses the scratch vector). */
function projectToScreen(x: number, y: number, z: number): { left: number; top: number } {
  REPROJECT.set(x, y, z);
  world.camera.updateMatrixWorld();
  REPROJECT.project(world.camera);
  return {
    left: (REPROJECT.x * 0.5 + 0.5) * window.innerWidth,
    top: (-REPROJECT.y * 0.5 + 0.5) * window.innerHeight,
  };
}

/** Pooled countdown labels stacked above downed teammates' bodies. */
const mateLabelPool: HTMLDivElement[] = [];
function mateLabelAt(index: number): HTMLDivElement {
  let label = mateLabelPool[index];
  if (!label) {
    label = document.createElement('div');
    label.className = 'mateLabel';
    mateLabelsWrap.append(label);
    mateLabelPool[index] = label;
  }
  return label;
}

/** Shows each downed teammate's respawn countdown above their body. */
function updateMateLabels(): void {
  for (let i = 0; i < remotePlayers.length; i++) {
    const remote = remotePlayers[i];
    const label = mateLabelAt(i);
    if (!remote.downed) {
      label.hidden = true;
      continue;
    }
    const pos = projectToScreen(remote.x, 2.2, remote.z);
    label.hidden = false;
    label.textContent = `REVIVING IN: ${Math.max(1, Math.ceil(remote.reviveTimer))}s`;
    label.style.left = `${pos.left.toFixed(1)}px`;
    label.style.top = `${pos.top.toFixed(1)}px`;
  }
  for (let i = remotePlayers.length; i < mateLabelPool.length; i++) {
    mateLabelPool[i].hidden = true;
  }
}

/** Pooled "CURSED / CLEANSING" labels stacked above cursed bodies. */
const curseLabelPool: HTMLDivElement[] = [];
function curseLabelAt(index: number): HTMLDivElement {
  let label = curseLabelPool[index];
  if (!label) {
    label = document.createElement('div');
    label.className = 'curseLabel';
    curseLabelsWrap.append(label);
    curseLabelPool[index] = label;
  }
  return label;
}

/**
 * Paints the cleansing circle + progress label for every cursed player (the
 * local player and, online, each mirrored peer). Runs every frame in both
 * modes; the underlying state is local offline and server-mirrored online.
 */
function updateCurseVisuals(): void {
  curseMarkers.length = 0;
  let labelIndex = 0;
  const add = (player: Player): void => {
    if (!player.cursed || !player.alive) return;
    const progress = Math.max(0, Math.min(1, player.cleanseProgress));
    curseMarkers.push({ x: player.x, z: player.z, progress });
    const label = curseLabelAt(labelIndex++);
    const pos = projectToScreen(player.x, 2.4, player.z);
    label.hidden = false;
    label.textContent =
      progress > 0
        ? `CLEANSING ${(CURSE_CLEANSE_SECONDS * (1 - progress)).toFixed(1)}s`
        : 'CURSED!';
    label.style.left = `${pos.left.toFixed(1)}px`;
    label.style.top = `${pos.top.toFixed(1)}px`;
  };
  for (const player of players) add(player);
  for (const remote of remotePlayers) add(remote);
  for (let i = labelIndex; i < curseLabelPool.length; i++) curseLabelPool[i].hidden = true;
  curseCircle.update(curseMarkers);
}

/** Launches an online match from a room snapshot (host and joiners alike). */
function startOnlineMatch(info: RoomInfo): void {
  lastMapId = info.mapId;
  mode = 'single'; // the local player uses the solo keyboard scheme
  input?.dispose();
  input = new InputManager('single');

  clearWorld();
  currentMap = getMap(info.mapId);
  loadMap(world, currentMap);
  zombieSpawnPoints =
    currentMap.spawnGates.length > 0
      ? currentMap.spawnGates.map((gate) => ({ x: gate.x, z: gate.y }))
      : currentMap.zombieSpawns.map((s) => ({ x: s.x, z: s.y }));

  isOnline = true;
  // The HUD score is the room's shared team pool in co-op, not a per-player one.
  scoreLabelEl.textContent = 'TEAM ქულა';
  localSeat = Math.max(0, info.players.findIndex((p) => p.sessionId === info.selfId));
  const start = spawnForSeat(localSeat);
  players.push(
    createPlayer(world.scene, 0, CHARACTER_ORDER[localSeat % CHARACTER_ORDER.length], start)
  );
  syncRemotePlayers(info);

  cameraRig = new CameraController(world, 'duo', centroidOf([...players, ...remotePlayers]));

  // Apply the persisted graphics mode now that the arena and every peer actor
  // exist, so LOW clears their shadow flags too (HIGH restores them).
  applyGraphicsQuality(world);

  hud.hidden = false;
  card2.root.hidden = true;
  mult2.hidden = true;
  hideOverlay();
  phase = 'playing';
  toast(`ონლაინ მატჩი — ${currentMap.name}`, 3);
}

/** Renders lobby UI and keeps actors/game-over in sync with the live room state. */
function handleRoomUpdate(info: RoomInfo | null): void {
  onlineInfo = info;
  setRoomInfo(info);
  if (!info || !isOnline || phase !== 'playing') return;

  // The room owns the score online: mirror the shared team pool so every client
  // (and the game-over summary) reads the identical authoritative number.
  score = info.teamScore;

  // The server declares Game Over the moment every player is down at once.
  if (info.matchOver) {
    endGame();
    return;
  }
  syncRemotePlayers(info);
  syncLocalPlayer(info);

  // Mirror the server's wave director into the local HUD state, then reconcile
  // every authoritative entity into its render proxy.
  director.wave = info.wave;
  director.event = info.event;
  director.phase = info.directorPhase;
  director.timer = info.directorTimer;
  onlineWorld.sync(onlineContext(), info);

  // A prop the server just confirmed may share the local player's cell (crates
  // are deployed underfoot) — push them out before the next shot resolves.
  const local = players[0];
  if (local && local.alive) {
    const resolved = world.grid.resolveCircle(local.x, local.z, PLAYER_RADIUS);
    if (resolved.x !== local.x || resolved.z !== local.z) {
      local.x = resolved.x;
      local.z = resolved.z;
      syncActor(local);
    }
  }
}

/** Builds the lobby client that drives the online panel and match start. */
function createLobby(): Lobby {
  return new Lobby({
    onStatus: (state, message) => setOnlineStatus(state, message),
    onRoom: (info) => handleRoomUpdate(info),
    onStart: (info) => {
      onlineInfo = info;
      // Reconnect while a match is live: resync peers instead of restarting.
      if (!isOnline || phase !== 'playing') startOnlineMatch(info);
    },
    onEnemyKilled: (event) => handleEnemyKilled(event),
    onPropDestroyed: (event) => {
      // A destroyed crate splinters where it stood; a barrel's blast is its own
      // `explosion` event, so it is not doubled up here.
      if (event.kind === 'crate') {
        audio.zombieHit();
        gibs.burst(event.cx + 0.5, event.cz + 0.5, 3);
      }
    },
    onExplosion: (event) => handleServerExplosion(event.x, event.z, event.radius),
    onShockwave: (event) => handleBossShockwave(event.x, event.z, event.radius, event.speed),
    onDamagePlayer: (amount) => {
      const local = players[0];
      if (local) applyDamage(local, amount);
    },
    onGranted: (kind, by) => {
      const local = players[0];
      if (!local) return;
      audio.pickup();
      // The room broadcasts every pickup to BOTH clients and each one applies
      // it to its own player, so loot is a shared co-op benefit.
      const message = applyPickup(local, kind);
      if (local.weapon !== local._lastWeaponId) {
        updateWeaponMesh(local.mesh, local.weapon);
        local._lastWeaponId = local.weapon;
      }
      const collector =
        by && by !== onlineInfo?.selfId ? onlineInfo?.players.find((p) => p.sessionId === by) : null;
      toast(`${collector?.name ?? local.character}: ${message}`, 2);
    },
    onWaveStart: (wave, event) => handleRemoteWaveStart(wave, event),
    onWaveClear: (wave) => handleRemoteWaveClear(wave),
  });
}

/**
 * A mob died — the server decided it, so the FX play for everyone while only the
 * client whose shot landed the kill credits score and combo.
 */
function handleEnemyKilled(event: {
  kind: keyof typeof ENEMY_CONFIG & string;
  x: number;
  z: number;
  killer: string;
}): void {
  // The room already credited this kill to the shared team pool (base score ×
  // the shooter's combo) and the state patch mirrors it onto both HUDs, so only
  // the local stat/combo bookkeeping happens here.
  const owner = event.killer !== '' && event.killer === onlineInfo?.selfId ? players[0] ?? null : null;
  if (owner) {
    owner.kills += 1;
    registerKill(owner);
    if (isComboMilestone(owner.mult)) {
      grantSpree(owner);
      const label = comboMilestoneLabel(owner.mult);
      if (label) showComboBanner(label);
      audio.spree();
    }
  }
  audio.zombieDeath();
  const gibCount =
    event.kind === 'devil' || event.kind === 'blackDevil'
      ? JUICE_CONFIG.gibCountBoss
      : JUICE_CONFIG.gibCountMin +
        Math.floor(Math.random() * (JUICE_CONFIG.gibCountMax - JUICE_CONFIG.gibCountMin + 1));
  gibs.burst(event.x, event.z, gibCount);
}

/**
 * The Black Devil's radial shockwave (both modes): plays the expanding energy
 * ring, a subtle screen shake and the pressure-wave sound. `speed` is the
 * server's expansion speed, so the visual ring reaches each victim at the exact
 * tick the collision sweep does. The damage itself is applied by whoever owns
 * the simulation (local AI offline, the room online).
 */
function handleBossShockwave(x: number, z: number, radius: number, speed?: number): void {
  bossFx.shockwave(x, z, radius, speed);
  cameraRig?.addTrauma(JUICE_CONFIG.shockwaveTrauma);
  audio.shockwave();
}

/** Plays the blast flash for a server-confirmed explosion (ours are skipped). */
function handleServerExplosion(x: number, z: number, radius: number): void {
  const index = pendingLocalExplosions.findIndex(
    (pending) => Math.abs(pending.x - x) < 0.01 && Math.abs(pending.z - z) < 0.01
  );
  if (index !== -1) {
    pendingLocalExplosions.splice(index, 1); // our own blast: the flash is live
    return;
  }
  // `explode` also draws the expanding flash; the damage it computes here is
  // discarded (the server already applied the real blast).
  explode(
    world.scene,
    flashes,
    { ownerIndex: -1, x, z, radius, damage: 0 },
    currentProjectileWorld()
  );
  cameraRig?.addTrauma(JUICE_CONFIG.barrelChainTrauma);
}

/** Reports a blast this client resolved; the room owns its damage and chains. */
function reportLocalExplosion(explosion: ExplosionEvent): void {
  onlineLobby?.reportExplosion(
    explosion.x,
    explosion.z,
    explosion.radius,
    explosion.damage,
    explosion.flatPlayerDamage !== undefined ? explosion.flatPlayerDamage : -1
  );
  // Remember it so the server's echo doesn't replay the same flash.
  pendingLocalExplosions.push({ x: explosion.x, z: explosion.z });
  if (pendingLocalExplosions.length > 32) pendingLocalExplosions.shift();
}

// --- wave-event banner -------------------------------------------------------

/** Pops the "BLACK DEVIL!" boss-wave banner and its ominous sting. */
function announceBossWave(wave: number): void {
  showEventBanner('BLACK DEVIL!');
  audio.spree();
  toast(`ტალღა ${wave} — BLACK DEVIL BOSS! · მოკალი, სანამ ლაზერი მოგკლავს`, 3.5);
}

/** Themed wave banner/toast for a server-declared wave (both clients agree). */
function handleRemoteWaveStart(wave: number, event: WaveEventKind): void {
  if (wave === DIRECTOR_CONFIG.blackDevilWave) {
    announceBossWave(wave);
    return;
  }
  const label = waveEventLabel(event);
  if (label) {
    showEventBanner(label);
    audio.spree();
    toast(
      event === 'speedHorde'
        ? `ტალღა ${wave} — SPEED HORDE · RUNNERS ×1.8!`
        : `ტალღა ${wave} — BLACKOUT! · გამოიყენე ფარა!`,
      3
    );
    return;
  }
  toast(`ტალღა ${wave}!`, 2);
}

/** Wave cleared: living players return to full HP with topped-up magazines. */
function handleRemoteWaveClear(wave: number): void {
  for (const player of players) {
    if (WAVE_CONFIG.fullHpRestoreOnWaveEnd) healToFull(player);
    for (const [weaponId, ammo] of player.ammo) {
      const mag = getWeapon(weaponId).magSize;
      if (mag > 0 && ammo < mag) player.ammo.set(weaponId, mag);
    }
  }
  toast(`ტალღა ${wave} გადალახული! · +100% HP RESTORED`, 3.5);
}

function endGame(): void {
  phase = 'over';
  input?.dispose();
  input = null;

  const summaries: PlayerSummary[] = players.map((p) => ({
    label: `P${p.index + 1} (${p.character.toUpperCase()})`,
    kills: p.kills,
    shotsFired: p.shotsFired,
    shotsHit: p.shotsHit,
    accuracy: p.shotsFired > 0 ? p.shotsHit / p.shotsFired : 0,
    bestCombo: p.bestCombo,
  }));

  // Compare against (and persist) the all-time records held in localStorage.
  const previousWave = readRecord(HIGH_WAVE_KEY);
  const previousScore = readRecord(HIGH_SCORE_KEY);
  const bestWave = Math.max(previousWave, director.wave);
  const bestScore = Math.max(previousScore, score);
  writeRecord(HIGH_WAVE_KEY, bestWave);
  writeRecord(HIGH_SCORE_KEY, bestScore);

  const summary: MatchSummary = {
    players: summaries,
    wave: director.wave,
    score,
    bestWave,
    bestScore,
    newWaveRecord: director.wave > previousWave,
    newScoreRecord: score > previousScore,
  };
  showMatchSummary(summary);
}

function backToMenu(): void {
  clearWorld();
  input?.dispose();
  input = null;
  cameraRig = null;
  phase = 'menu';
  hud.hidden = true;
  reviveLabelEl.hidden = true;
  messageEl.textContent = '';
  showMenu(lastMode); // highlight the controls layout of the mode just played
}

initMenu({
  onStart: (startMode, mapId) => startGame(startMode, mapId),
  onRestart: () => {
    // Online: ask the server to reset the room (host-only) and restart everyone.
    if (isOnline && onlineLobby) onlineLobby.requestRestart();
    else startGame(lastMode, lastMapId);
  },
  onMenu: () => backToMenu(),
  onCreateRoom: (name, mapId) => {
    onlineLobby = createLobby();
    void onlineLobby.createRoom(name, mapId);
  },
  onJoinRoom: (code, name) => {
    onlineLobby = createLobby();
    void onlineLobby.joinRoom(code, name);
  },
  onStartOnline: () => onlineLobby?.startMatch(),
  onLeaveOnline: () => {
    onlineLobby?.leave();
    onlineLobby = null;
    onlineInfo = null;
  },
});

window.addEventListener('resize', () => resizeWorld(world));

// --- combat -----------------------------------------------------------------
function occupantsInCell(cx: number, cz: number): boolean {
  const inside = (x: number, z: number) =>
    Math.abs(x - (cx + 0.5)) < 0.5 && Math.abs(z - (cz + 0.5)) < 0.5;
  for (const player of players) if (player.alive && inside(player.x, player.z)) return true;
  for (const zombie of horde.zombies) if (inside(zombie.x, zombie.z)) return true;
  return false;
}

/** Distance from `player` to the nearest living zombie in front of their aim. */
function nearestTargetDistance(player: Player): number {
  let best = Infinity;
  for (const zombie of horde.zombies) {
    if (!zombie.alive) continue;
    const dx = zombie.x - player.x;
    const dz = zombie.z - player.z;
    if (dx * player.aimX + dz * player.aimZ <= 0) continue; // behind the shooter
    const distance = Math.hypot(dx, dz);
    if (distance < best) best = distance;
  }
  return best;
}

function placeMine(player: Player): void {
  const x = player.x + player.aimX * 1.1;
  const z = player.z + player.aimZ * 1.1;
  const mesh = new THREE.Mesh(MINE_GEOMETRY, MINE_MATERIAL);
  mesh.position.set(x, 0.06, z);
  world.scene.add(mesh);
  mines.push({ x, z, ownerIndex: player.index, mesh });
}

function tryFire(player: Player, nowMs: number): void {
  const weaponId = ensureWeaponUnlocked(player);
  const def = getWeapon(weaponId);
  if (!isReadyToFire(def, nowMs, player.lastFireMs)) return;
  if (def.magSize > 0 && !player.ammo.has(weaponId)) {
    player.ammo.set(weaponId, def.magSize); // first pickup grants a full magazine
  }
  if (!hasAmmo(def, player.ammo.get(weaponId) ?? 0)) {
    if (weaponId !== WeaponId.Pistol) player.weapon = WeaponId.Pistol; // never soft-lock
    return;
  }

  // Pre-validate deployable placement so failures never burn ammo. Barrels snap
  // to the cell in front (falling back to the nearest free cell); wooden crates
  // snap to the 1×1 tile the player is standing on instead.
  let targetCell: { cx: number; cz: number } | null = null;
  if (weaponId === WeaponId.Barrel) {
    targetCell = findPlacementCell(world.grid, player.x, player.z, player.aimX, player.aimZ);
    if (!targetCell) return; // no free cell nearby at all
    if (occupantsInCell(targetCell.cx, targetCell.cz)) return;
    if (barricadeAt(barricades, targetCell.cx, targetCell.cz)) return;
  } else if (weaponId === WeaponId.Crate) {
    targetCell = findStandingCell(world.grid, player.x, player.z);
    if (!targetCell) return; // no free cell nearby at all
  }

  player.lastFireMs = nowMs;
  if (def.magSize > 0) player.ammo.set(weaponId, (player.ammo.get(weaponId) ?? 0) - 1);
  const power = player.powerTimer > 0 ? 2 : 1;

  if (def.kind === 'hitscan') {
    player.shotsFired += 1;
    const targets = horde.zombies.map((zombie) => ({
      x: zombie.x,
      z: zombie.z,
      radius: zombie.radius,
    }));
    const result = fireHitscan(
      player.x,
      player.z,
      player.aimX,
      player.aimZ,
      def,
      targets,
      world.grid
    );

    // one tracer per pellet — the shotgun shows 5 distinct conical rays.
    // A pellet that ran into a wall sparks on its face instead of passing through.
    const color = def.tracerColor;
    for (const pellet of result.pellets) {
      fx.tracer(player.x, player.z, pellet.x, pellet.z, color);
      if (pellet.hitWall) fx.impact(pellet.x, pellet.z, color);
    }

    // chunky muzzle flash for the shotgun, a tight one for the uzi,
    // a light single pop for the pistol
    const muzzleScale =
      weaponId === WeaponId.Shotgun ? 1.6 : weaponId === WeaponId.Uzi ? 0.6 : 0.8;
    fx.muzzleFlash(
      player.x + player.aimX * 0.5,
      player.z + player.aimZ * 0.5,
      muzzleScale,
      color
    );

    // recoil: the shotgun kicks a solid −0.2 u and snaps back; the uzi's
    // micro-jitter kick reads as vibration under its high cyclic rate
    if (weaponId === WeaponId.Uzi) {
      applyRecoil(player, def.recoil * (0.7 + Math.random() * 0.6));
    } else {
      applyRecoil(player, def.recoil);
    }
    shotSound(weaponId);

    // Point-blank guard: any mob physically overlapping the player's bounding
    // radius takes the weapon's full direct-hit damage on firing, so a bullet
    // can never slip harmlessly past an enemy that is inside the player.
    const pointBlankDamage =
      (def.closeRangeDamage > 0 ? def.closeRangeDamage : def.damage) * def.pelletCount * power;
    let embeddedAny = false;
    for (const zombie of horde.zombies) {
      if (!zombie.alive) continue;
      if (Math.hypot(zombie.x - player.x, zombie.z - player.z) <= PLAYER_RADIUS + zombie.radius) {
        embeddedAny = true;
        break;
      }
    }

    // Deployables in the line of fire only matter when they are nearer than
    // the closest zombie this shot would have hit.
    let nearestZombieDistance = Infinity;
    for (const hit of result.hits) {
      const zombie = horde.zombies[hit.index];
      if (!zombie) continue;
      nearestZombieDistance = Math.min(
        nearestZombieDistance,
        Math.hypot(zombie.x - player.x, zombie.z - player.z)
      );
    }

    // an explosive barrel in the line of fire detonates if it is nearer than
    // the closest zombie this shot would have hit
    const barrel = nearestBarricadeAlongRay(
      player.x,
      player.z,
      player.aimX,
      player.aimZ,
      def.maxRange,
      'barrel'
    );
    if (barrel) {
      const barrelDistance = Math.hypot(barrel.cx + 0.5 - player.x, barrel.cz + 0.5 - player.z);
      if (!embeddedAny && barrelDistance <= nearestZombieDistance) {
        // Online: the room detonates it (its blast, chain and kills are shared).
        if (isOnline) {
          onlineLobby?.reportPropDamage(barrel.cx, barrel.cz, BARREL_SHOT_DAMAGE);
          return;
        }
        detonateBarrel(barrel, player);
        return;
      }
    }

    // a wooden crate in the line of fire takes the shot instead — bullets chew
    // its 150 HP (no detonation, just splinters).
    const crate = nearestBarricadeAlongRay(
      player.x,
      player.z,
      player.aimX,
      player.aimZ,
      def.maxRange,
      'crate'
    );
    if (crate) {
      const crateDistance = Math.hypot(crate.cx + 0.5 - player.x, crate.cz + 0.5 - player.z);
      if (!embeddedAny && crateDistance <= nearestZombieDistance) {
        audio.zombieHit();
        fx.impact(crate.cx + 0.5, crate.cz + 0.5, CRATE_CONFIG.tracerColor, 0.8);
        if (isOnline) {
          // The room applies the hit and splinters the crate for everyone.
          onlineLobby?.reportPropDamage(crate.cx, crate.cz, def.damage * power);
          return;
        }
        if (damageBarricade(world.grid, world.scene, barricades, crate, def.damage * power)) {
          gibs.burst(crate.cx + 0.5, crate.cz + 0.5, 3); // splintered
        }
        return; // the pellet was absorbed by the crate
      }
    }

    const victims = new Map<Zombie, number>();
    for (const hit of result.hits) {
      const zombie = horde.zombies[hit.index];
      if (!zombie || !zombie.alive) continue;
      victims.set(zombie, (victims.get(zombie) ?? 0) + hit.damage * power);
    }
    // Mobs embedded in the player: guarantee the full point-blank hit even when
    // no pellet ray happened to line up with them.
    for (const zombie of horde.zombies) {
      if (!zombie.alive) continue;
      if (Math.hypot(zombie.x - player.x, zombie.z - player.z) > PLAYER_RADIUS + zombie.radius) {
        continue;
      }
      victims.set(zombie, Math.max(victims.get(zombie) ?? 0, pointBlankDamage));
    }
    // A point-blank shotgun connection carries weight: light camera kick plus
    // a 30 ms micro-freeze before the simulation resumes.
    if (weaponId === WeaponId.Shotgun && victims.size > 0) {
      if (nearestTargetDistance(player) <= def.closeRangeThreshold) {
        cameraRig?.addTrauma(JUICE_CONFIG.shotgunTrauma);
        requestHitStop();
      }
    }

    if (victims.size > 0) player.shotsHit += 1; // any connecting pellet = a hit
    if (isOnline) {
      // The room owns mob health: report each victim's damage; the death, the
      // loot roll and the kill credit come back as shared events.
      victims.forEach((damage, zombie) => {
        const id = onlineWorld.enemyIdOf(zombie);
        if (id !== undefined) onlineLobby?.reportEnemyHit(id, damage, weaponId);
      });
      return;
    }
    victims.forEach((damage, zombie) => damageZombie(zombie, damage, player, def));
    return;
  }

  if (def.kind === 'projectile') {
    player.shotsFired += 1;
    const kind = weaponId === WeaponId.Grenade ? 'grenade' : 'rocket';
    fx.muzzleFlash(player.x + player.aimX * 0.5, player.z + player.aimZ * 0.5, 1.1, def.tracerColor);
    spawnPlayerProjectile(
      world.scene,
      projectiles,
      def,
      kind,
      player.x + player.aimX * 0.6,
      player.z + player.aimZ * 0.6,
      player.aimX,
      player.aimZ,
      player.index
    );
    applyRecoil(player, def.recoil);
    shotSound(weaponId);
    return;
  }

  if ((weaponId === WeaponId.Barrel || weaponId === WeaponId.Crate) && targetCell) {
    const kind: BarricadeKind = weaponId === WeaponId.Crate ? 'crate' : 'barrel';
    if (isOnline) {
      // Server-validated placement: the prop appears for everyone from the state
      // patch (and blocks the cell here only once it is confirmed).
      onlineLobby?.requestPlaceProp(kind, targetCell.cx, targetCell.cz);
      shotSound(weaponId);
      return;
    }
    placeBarricade(world.grid, world.scene, barricades, targetCell.cx, targetCell.cz, kind);
    horde.fieldTimer = 0; // recompute next frame → zombies reroute immediately
    // A crate spawned on the player's own tile is now a solid cell: push the
    // player out immediately so they never end up shooting from inside a wall.
    if (kind === 'crate') {
      const resolved = world.grid.resolveCircle(player.x, player.z, PLAYER_RADIUS);
      player.x = resolved.x;
      player.z = resolved.z;
      syncActor(player);
    }
    shotSound(weaponId);
    return;
  }
  if (weaponId === WeaponId.Mine) {
    placeMine(player);
    shotSound(weaponId);
  }
}

/** Live view of the world handed to the projectile/explosion resolver. */
function currentProjectileWorld(): ProjectileWorld {
  return { grid: world.grid, zombies: horde.zombies, players };
}

/**
 * Explodes at a world point (an explosive-barrel blast) and applies damage plus
 * a heavy directional camera rumble. Any intact barrels caught inside the blast
 * are queued by `scheduleChainFrom` with a staggered 0.08 s fuse.
 */
function explodeAt(x: number, z: number, owner: Player | null, dirX = 0, dirZ = 0): void {
  horde.fieldTimer = 0; // topology changed → zombies reroute next frame
  cameraRig?.addTrauma(JUICE_CONFIG.barrelChainTrauma, dirX, dirZ);
  applyExplosion(
    explode(
      world.scene,
      flashes,
      {
        ownerIndex: owner?.index ?? -1,
        x,
        z,
        radius: BARREL_BLAST.explosionRadius,
        damage: BARREL_BLAST.damage,
      },
      currentProjectileWorld()
    )
  );
}

/** Shots an explosive barrel: removes it, then detonates its blast. */
function detonateBarrel(
  barrel: Barricade,
  owner: Player | null,
  dirX = 0,
  dirZ = 0
): void {
  if (barrel.kind !== 'barrel') return; // wooden crates never explode
  const x = barrel.cx + 0.5;
  const z = barrel.cz + 0.5;
  removeBarricade(world.grid, world.scene, barricades, barrel);
  let pushX = dirX;
  let pushZ = dirZ;
  if (pushX === 0 && pushZ === 0 && owner) {
    pushX = x - owner.x;
    pushZ = z - owner.z;
  }
  explodeAt(x, z, owner, pushX, pushZ);
}

/**
 * Queues every intact barrel caught in a blast onto the chain reaction. Each
 * link is staggered 0.08 s after the previous one, so a cluster cascades rather
 * than detonating as a single pulse. A barrel already waiting on a fuse is
 * never re-queued, which keeps the cascade finite.
 */
function scheduleChainFrom(explosion: ExplosionEvent): void {
  const radius = BARREL_CONFIG.chainTriggerRadius;
  let queued = 0;
  for (const barrel of barricades) {
    if (barrel.kind !== 'barrel') continue; // crates never chain — no blast
    const bx = barrel.cx + 0.5;
    const bz = barrel.cz + 0.5;
    if (Math.hypot(bx - explosion.x, bz - explosion.z) > radius) continue;
    if (chainFuses.some((fuse) => fuse.cx === barrel.cx && fuse.cz === barrel.cz)) continue;
    chainFuses.push({
      cx: barrel.cx,
      cz: barrel.cz,
      timer: BARREL_CONFIG.chainFuseDelay * (queued + 1),
      ownerIndex: explosion.ownerIndex,
      dirX: bx - explosion.x,
      dirZ: bz - explosion.z,
    });
    queued++;
  }
}

/** Steps the staggered chain fuses; each firing barrel spawns its own links. */
function updateChainFuses(dt: number): void {
  for (let i = chainFuses.length - 1; i >= 0; i--) {
    const fuse = chainFuses[i];
    fuse.timer -= dt;
    if (fuse.timer > 0) continue;
    chainFuses.splice(i, 1);
    const barrel = barrelAt(barricades, fuse.cx, fuse.cz);
    if (!barrel) continue; // already destroyed, or a crate took the free cell
    detonateBarrel(barrel, players[fuse.ownerIndex] ?? null, fuse.dirX, fuse.dirZ);
  }
}

/** Nearest barricade of `kind` the ray (origin + unit direction) passes through. */
function nearestBarricadeAlongRay(
  x: number,
  z: number,
  dirX: number,
  dirZ: number,
  maxDistance: number,
  kind: BarricadeKind
): Barricade | null {
  let best: Barricade | null = null;
  let bestDistance = maxDistance;
  for (const barricade of barricades) {
    if (barricade.kind !== kind) continue;
    const centreX = barricade.cx + 0.5;
    const centreZ = barricade.cz + 0.5;
    const offsetX = centreX - x;
    const offsetZ = centreZ - z;
    const along = offsetX * dirX + offsetZ * dirZ;
    if (along <= 0 || along >= bestDistance) continue;
    const perpendicularSq = offsetX * offsetX + offsetZ * offsetZ - along * along;
    if (perpendicularSq > BARRICADE_HIT_RADIUS * BARRICADE_HIT_RADIUS) continue;
    // the barricade itself blocks its cell, so trace the LOS up to just short of it
    const reach = along - BARRICADE_HIT_RADIUS - 0.05;
    if (reach > 0 && !world.grid.lineOfSight(x, z, x + dirX * reach, z + dirZ * reach)) continue;
    best = barricade;
    bestDistance = along;
  }
  return best;
}

/**
 * Applies an explosion's damage. Victim zombies are resolved to objects *before*
 * any kills land, because killing one splices the horde and shifts the indices
 * the damage map is keyed by.
 */
function applyExplosion(explosion: ExplosionEvent): void {
  const owner = players[explosion.ownerIndex] ?? null;
  const victims: { zombie: Zombie; amount: number }[] = [];
  explosion.zombieDamage.forEach((amount, index) => {
    const zombie = horde.zombies[index];
    if (zombie?.alive) victims.push({ zombie, amount: explosiveDamageTo(zombie, amount) });
  });
  if (owner && victims.length > 0) owner.shotsHit += 1; // projectile connected
  for (const { zombie, amount } of victims) damageZombie(zombie, amount, owner, null);
  explosion.playerDamage.forEach((amount, index) => {
    const player = players[index];
    if (player) applyDamage(player, amount);
  });
  // Every blast both freezes the frame briefly and can start a barrel chain —
  // a grenade landing next to a barrel cluster sets the whole line off.
  requestHitStop();
  scheduleChainFrom(explosion);
}

/**
 * Boss armor against explosives: a single explosion can never take more than
 * `ENEMY_CONFIG.devil.explosiveDamageCap` from the Devil, no matter the blast
 * falloff. With cap 500 and Devil HP 850 that means one grenade blast wounds it
 * and exactly two destroy it, while standard mobs keep their one-hit kill.
 */
function explosiveDamageTo(zombie: Zombie, amount: number): number {
  if (zombie.kind === 'devil') return Math.min(amount, ENEMY_CONFIG.devil.explosiveDamageCap);
  if (zombie.kind === 'blackDevil') return Math.min(amount, ENEMY_CONFIG.blackDevil.explosiveDamageCap);
  return amount;
}

function damageZombie(
  zombie: Zombie,
  damage: number,
  owner: Player | null,
  sourceDef: { fireIntervalMs: number } | null
): void {
  if (!zombie || !zombie.alive) return;
  if (sourceDef && sourceDef.fireIntervalMs <= RAPID_FIRE_INTERVAL_MS) {
    applySuppression(zombie, SUPPRESS_DURATION); // rapid fire suppresses devils
  }
  zombie.hp -= damage;
  if (zombie.hp > 0) {
    audio.zombieHit();
    return;
  }
  // Score per kill = base score × the combo in effect at the moment of the kill.
  const combo = owner ? owner.mult : 1;
  score += zombie.score * combo;
  audio.zombieDeath();
  if (owner) {
    owner.kills += 1;
    registerKill(owner); // +1 combo and refresh the hold window
    if (isComboMilestone(owner.mult)) {
      grantSpree(owner); // brief speed boost
      const label = comboMilestoneLabel(owner.mult);
      if (label) showComboBanner(label); // floating milestone text
      audio.spree(); // rising arpeggio cue
    }
  }
  // Voxel gib burst — a handful for mobs, a shower for the boss.
  const gibCount =
    zombie.kind === 'devil' || zombie.kind === 'blackDevil'
      ? JUICE_CONFIG.gibCountBoss
      : JUICE_CONFIG.gibCountMin +
        Math.floor(Math.random() * (JUICE_CONFIG.gibCountMax - JUICE_CONFIG.gibCountMin + 1));
  gibs.burst(zombie.x, zombie.z, gibCount);
  removeZombie(horde, world.scene, zombie);
  // The Black Devil dies in a 3–4 reward "loot explosion" (health packs,
  // special ammo, barrels). Every other mob keeps its single drop roll.
  if (zombie.kind === 'blackDevil') {
    spawnBossLoot(world.scene, pickups, zombie.x, zombie.z);
    return;
  }
  const drop = rollDropKind();
  if (drop) spawnPickup(world.scene, pickups, zombie.x, zombie.z, drop);
}

/**
 * Offline curse tick: advance every cursed local player's clocks, apply the
 * ticking damage, and lift the curse when a teammate finishes the 3 s hold.
 * Online the room runs an identical loop and mirrors the result through the
 * schema, so this is skipped there.
 */
function updateLocalCurses(dt: number): void {
  for (const player of players) {
    if (!player.cursed && !player.curse) continue;
    // A downed player's curse lapses with the run — no ticking through death.
    if (!player.alive) {
      player.curse = null;
      player.cursed = false;
      player.cleanseProgress = 0;
      continue;
    }
    if (!player.curse) player.curse = createCurseState();
    const cleansed = players.some(
      (other) =>
        other !== player &&
        other.alive &&
        isInCurseCircle(player.x, player.z, other.x, other.z)
    );
    const step = advanceCurse(player.curse, dt, cleansed);
    if (step.damage > 0) applyDamage(player, step.damage);
    if (step.cleansed) {
      player.curse = null;
      player.cursed = false;
      player.cleanseProgress = 0;
      audio.pickup();
      toast(`P${player.index + 1}: CURSE LIFTED!`, 2.5);
    } else {
      player.cursed = true;
      player.cleanseProgress = curseProgress(player.curse);
    }
  }
}

function applyDamage(player: Player, amount: number): void {
  if (!player.alive || player.invulnTimer > 0 || amount <= 0) return;
  player.hp = Math.max(0, player.hp - amount);
  comboReset(player); // getting hurt resets the multiplier
  flashDamage();
  if (player.hp > 0) return;

  // Online: the room owns life/death — enter the local downed state and report
  // the death so the server starts the 10 s respawn clock (or Game Over).
  if (isOnline) {
    enterOnlineDowned(player);
    onlineLobby?.reportDeath();
    return;
  }

  // Local co-op: with a living partner, dropping to 0 HP begins the 10 s
  // downed/revive countdown instead of ending the game. If no partner is
  // alive (solo, or both died together) it's Game Over immediately.
  const partnerAlive = players.some((p) => p !== player && p.alive);
  if (mode === 'duo' && partnerAlive) {
    downPlayer(player);
    return;
  }
  player.alive = false;
  player.mesh.visible = false;
  if (players.every((p) => !p.alive)) endGame();
}

/** Puts a player into the co-op downed state at their death position. */
function downPlayer(player: Player): void {
  player.hp = 0;
  player.alive = false; // no targeting, no damage, no pickups — but the mesh stays
  player.downed = true;
  player.reviveTimer = COOP_CONFIG.reviveCountdown;
  player.reviveHold = 0;
  player.blinkTimer = COOP_CONFIG.blinkInterval;
  player.mesh.visible = true; // ghost blinks at the death spot (see tickDownedPlayer)
  toast(`P${player.index + 1} დაეცა! · REVIVING IN ${COOP_CONFIG.reviveCountdown}s`, 2.5);
}

/** Scratch revive timers reused every frame (no per-tick allocation). */
const SCRATCH_REVIVE = { timer: 0, hold: 0 };

/**
 * One frame of the downed state: ghost blink + the passive 10 s countdown +
 * the active "high-five" hold (a partner inside the circle for 2.5 s revives
 * the downed player immediately — see shared/src/revive.ts).
 */
function tickDownedPlayer(player: Player, partnerInCircle: boolean, dt: number): void {
  player.blinkTimer -= dt;
  if (player.blinkTimer <= 0) {
    player.mesh.visible = !player.mesh.visible;
    player.blinkTimer = COOP_CONFIG.blinkInterval;
  }
  SCRATCH_REVIVE.timer = player.reviveTimer;
  SCRATCH_REVIVE.hold = player.reviveHold;
  const outcome = advanceRevive(SCRATCH_REVIVE, partnerInCircle, dt);
  player.reviveTimer = Math.max(0, SCRATCH_REVIVE.timer);
  player.reviveHold = SCRATCH_REVIVE.hold;
  if (outcome === 'waiting') return;
  revivePlayer(player, outcome);
}

/** Brings a downed player back: full HP, starter Pistol, brief i-frames. */
function revivePlayer(player: Player, how: 'passive' | 'active'): void {
  player.mesh.visible = true;
  player.downed = false;
  player.alive = true;
  player.hp = PLAYER_MAX_HP; // full base HP
  player.invulnTimer = COOP_CONFIG.reviveInvulnerability;
  player.blinkTimer = COOP_CONFIG.invulnBlinkInterval;
  player.reviveTimer = 0;
  player.reviveHold = 0;
  player.recoil = 0;
  // Inventory reset: every weapon/ammo/grant is stripped — starter Pistol only.
  player.ammo.clear();
  player.granted.clear();
  player.weapon = WeaponId.Pistol;
  updateWeaponMesh(player.mesh, WeaponId.Pistol);
  player._lastWeaponId = WeaponId.Pistol;
  reviveCircle.hide();
  toast(
    how === 'active'
      ? `HIGH-FIVE! P${player.index + 1} REVIVED · ${COOP_CONFIG.reviveInvulnerability}s INVULNERABLE`
      : `P${player.index + 1} REVIVED! · ${COOP_CONFIG.reviveInvulnerability}s INVULNERABLE`,
    2.5
  );
}

/** Fast-flashing i-frames granted after a revive; ends with the mesh visible. */
function tickInvulnerability(player: Player, dt: number): void {
  if (player.invulnTimer <= 0) return;
  player.invulnTimer -= dt;
  player.blinkTimer -= dt;
  if (player.blinkTimer <= 0) {
    player.mesh.visible = !player.mesh.visible;
    player.blinkTimer = COOP_CONFIG.invulnBlinkInterval;
  }
  if (player.invulnTimer <= 0) {
    player.invulnTimer = 0;
    player.mesh.visible = true;
  }
}

function updateMines(): void {
  for (let i = mines.length - 1; i >= 0; i--) {
    const mine = mines[i];
    const triggered = horde.zombies.some(
      (zombie) => zombie.alive && Math.hypot(zombie.x - mine.x, zombie.z - mine.z) < 1.6
    );
    if (!triggered) continue;
    world.scene.remove(mine.mesh); // shared mine resources — nothing to dispose
    mines.splice(i, 1);
    // detonate through the regular explosion path (the Mine's configured fuse)
    spawnPlayerProjectile(
      world.scene,
      projectiles,
      getWeapon(WeaponId.Mine),
      'grenade',
      mine.x,
      mine.z,
      1,
      0,
      mine.ownerIndex
    );
  }
}

// --- frame ------------------------------------------------------------------

/**
 * Binds one live player into their split-screen status card: HP bar + number,
 * active weapon name & silhouette, and ammo (∞ for the infinite pistol). While
 * a co-op player is downed the ammo row is swapped for a blinking revive timer.
 */
function updatePlayerCard(card: PlayerCard, player: Player): void {
  card.hpFill.style.width = `${Math.max(0, Math.min(1, player.hp / PLAYER_MAX_HP)) * 100}%`;
  card.hpVal.textContent = String(Math.max(0, Math.round(player.hp)));

  const def = getWeapon(ensureWeaponUnlocked(player));
  const weaponKey = String(def.id);
  if (card.icon.dataset.weaponId !== weaponKey) {
    card.icon.dataset.weaponId = weaponKey;
    card.weapon.textContent = def.name;
    card.icon.innerHTML = weaponIconSvg(def.id);
  }

  if (player.downed) {
    card.root.classList.add('downed');
    card.revive.hidden = false;
    card.revive.textContent =
      player.reviveHold > 0
        ? `HIGH-FIVE! ${Math.max(1, Math.ceil(COOP_CONFIG.reviveHoldSeconds - player.reviveHold))}s`
        : `REVIVING IN: ${Math.max(1, Math.ceil(player.reviveTimer))}s`;
    card.ammoRow.hidden = true;
    return;
  }

  card.root.classList.remove('downed');
  card.revive.hidden = true;
  card.ammoRow.hidden = false;
  card.ammo.textContent =
    def.magSize === 0 ? '∞' : String(player.ammo.get(def.id) ?? def.magSize);
}

function update(dt: number, nowMs: number): void {
  const inp = input;
  if (!inp || !cameraRig) return;

  // Hit-stop: heavy impacts freeze the whole simulation for a few milliseconds.
  if (hitStopTimer > 0) {
    hitStopTimer -= dt;
    return;
  }

  for (const player of players) {
    if (player.downed) {
      // Online: the server owns the countdown — just blink and wait.
      if (isOnline) {
        tickOnlineDowned(player, dt);
        continue;
      }
      // Local co-op: ghost blink + passive countdown + active circle hold.
      const partnerInCircle = players.some(
        (other) =>
          other !== player &&
          other.alive &&
          isInReviveCircle(player.x, player.z, other.x, other.z)
      );
      tickDownedPlayer(player, partnerInCircle, dt);
      if (player.downed) {
        reviveCircle.show(
          player.x,
          player.z,
          player.reviveHold / COOP_CONFIG.reviveHoldSeconds
        );
      }
      continue;
    }
    if (!player.alive) continue;
    tickInvulnerability(player, dt); // post-revive i-frames
    const axes = inp.moveAxes(player.index);
    const moved = movePlayer(player, axes.dx, axes.dz, world.grid, dt);
    if (moved) {
      setAimDirection(player, axes.dx, axes.dz); // 8-way keyboard facing
    }
    // stationary: preserve last facing (already set)
    comboTick(player, dt);
    if (player.powerTimer > 0) player.powerTimer -= dt;
    if (player.spreeTimer > 0) {
      player.spreeTimer -= dt;
      if (player.spreeTimer <= 0) {
        player.spreeTimer = 0;
        player.speedMult = 1; // spree boost expired
      }
    }
    ensureWeaponUnlocked(player);

    const slot = inp.takeSlot();
    if (slot !== null) selectSlot(player, slot);
    const cycle = inp.takeCycle(player.index);
    if (cycle !== 0) cycleWeapon(player, cycle);

    // Update weapon mesh when weapon changes
    if (player.weapon !== player._lastWeaponId) {
      updateWeaponMesh(player.mesh, player.weapon);
      player._lastWeaponId = player.weapon;
    }

    decayRecoil(player, dt);
    syncActor(player);
    if (inp.shooting(player.index)) tryFire(player, nowMs);
  }

  // Downed teammates blink in place (the local downed player is handled above).
  if (isOnline) {
    for (const remote of remotePlayers) {
      if (remote.downed) tickOnlineDowned(remote, dt);
    }
  }

  cameraPlayers.length = 0;
  for (const player of players) cameraPlayers.push(player);
  for (const remote of remotePlayers) cameraPlayers.push(remote);
  cameraRig.update(cameraPlayers, dt);
  if (isOnline) publishPresence();

  // waves — spawn relative to the first alive player. Online, the room runs the
  // director and mirrors it into `director` + our one-shot `waveStart`/`waveClear`
  // events, so the local state machine is skipped entirely.
  if (!isOnline) {
    const anchor = players.find((p) => p.alive) ?? players[0];
    const events = updateDirector(
      director,
      dt,
      horde,
      world.scene,
      world.grid,
      anchor.x,
      anchor.z,
      zombieSpawnPoints
    );
    if (events.waveStarted !== null) {
      const label = waveEventLabel(director.event);
      if (director.wave === DIRECTOR_CONFIG.blackDevilWave) {
        announceBossWave(director.wave); // Wave 7: Black Devil encounter
      } else if (label) {
        showEventBanner(label); // themed banner for special waves
        audio.spree(); // dramatic sting
        toast(
          director.event === 'speedHorde'
            ? `ტალღა ${events.waveStarted} — SPEED HORDE · RUNNERS ×1.8!`
            : `ტალღა ${events.waveStarted} — BLACKOUT! · გამოიყენე ფარა!`,
          3
        );
      } else {
        toast(`ტალღა ${events.waveStarted}!`, 2);
      }
    }
    if (events.waveCleared !== null) {
      // wave completion: living players come back at FULL health (balance knob)
      for (const player of players) {
        if (WAVE_CONFIG.fullHpRestoreOnWaveEnd) healToFull(player);
        // refill any weapon that is below a full magazine (never reduces);
        // downed players stay downed — their revive timer keeps ticking.
        for (const [weaponId, ammo] of player.ammo) {
          const mag = getWeapon(weaponId).magSize;
          if (mag > 0 && ammo < mag) player.ammo.set(weaponId, mag);
        }
      }
      toast(`ტალღა ${events.waveCleared} გადალახული! · +100% HP RESTORED`, 3.5);
    }
  }

  // blackout / night-wave lighting: dim the arena, aim each player's flashlight
  nightMode.setActive(director.event === 'blackout');
  nightMode.update(dt, players);

  // Pulse the perimeter gate warning lamps while the wave is disgorging mobs.
  updateSpawnGateWarnings(world, dt, director.phase === 'spawning');

  // horde AI → per-player damage + any barrels the horde destroyed. Online the
  // room simulates the horde and forwards melee damage as `damagePlayer`.
  if (!isOnline) {
    const hordeEvents = updateHorde(horde, {
      dt,
      players,
      grid: world.grid,
      barricades,
      scene: world.scene,
      projectiles,
    });
    hordeEvents.playerDamage.forEach((amount, index) => {
      const player = players[index];
      if (player) applyDamage(player, amount);
    });
    for (const ruined of hordeEvents.destroyedBarrels) explodeAt(ruined.x, ruined.z, null);
    for (const wave of hordeEvents.shockwaves) {
      handleBossShockwave(wave.x, wave.z, wave.radius, wave.speed);
    }
    // Curse debuff: bleed ticking damage and let a teammate's 3 s hold cleanse
    // it. Online the room owns all of this (mirrored through the schema).
    updateLocalCurses(dt);
    if (phase !== 'playing') return; // game over mid-frame
  }

  // Black Devil telegraph/beam/ring FX read the (local or mirrored) boss state.
  bossFx.update(dt, horde.zombies);

  // player projectiles / fireballs / explosions
  const projectileEvents = updateProjectiles(
    world.scene,
    projectiles,
    flashes,
    dt,
    currentProjectileWorld()
  );
  if (isOnline) {
    // Fireballs are server-owned now; only our own projectile blasts are
    // reported, and the room resolves their damage, chains and kills.
    for (const explosion of projectileEvents.explosions) reportLocalExplosion(explosion);
  } else {
    projectileEvents.playerDamage.forEach((amount, index) => {
      const player = players[index];
      if (player) applyDamage(player, amount);
    });
    for (const explosion of projectileEvents.explosions) applyExplosion(explosion);
  }
  if (phase !== 'playing') return;

  updateMines();
  if (!isOnline) updateChainFuses(dt); // staggered barrel chain reactions (offline)

  // pickups — online the room grants the item (walk-over is only a request), and
  // the mirror animates the ground cubes; offline collection stays as before.
  if (isOnline) {
    const local = players[0];
    if (local && onlineLobby) onlineWorld.collectDrops(onlineLobby, local);
    onlineWorld.update(onlineContext(), dt);
  } else {
    for (const collected of updatePickups(world.scene, pickups, dt, players)) {
      const player = players[collected.playerIndex];
      audio.pickup();
      toast(`${player?.character ?? ''}: ${collected.message}`, 2);
    }
  }

  // HUD — one independent status card per player, re-bound every frame.
  toastTimer -= dt;
  const p1 = players[0];
  const p2 = players[1];
  scoreEl.textContent = String(score);
  waveEl.textContent = String(director.wave);

  // Black Devil boss bar — top-centre, one shared bar for every client. The
  // boss's hp is authoritative (server online, local AI offline) and mirrored
  // onto the same horde array either way.
  const boss = horde.zombies.find((zombie) => zombie.alive && zombie.kind === 'blackDevil');
  if (boss) {
    bossBar.hidden = false;
    const ratio = boss.maxHp > 0 ? Math.max(0, Math.min(1, boss.hp / boss.maxHp)) : 0;
    bossFill.style.width = `${ratio * 100}%`;
  } else {
    bossBar.hidden = true;
  }
  if (p1) {
    updatePlayerCard(card1, p1);
    multVal.textContent = String(p1.mult);
    multFill.style.width = `${Math.min(100, (p1.comboTimer / comboWindowSeconds()) * 100)}%`;
    // Bar colour climbs with the combo tier for instant readability.
    multFill.style.backgroundColor =
      p1.mult >= 25 ? '#ff6b6b' : p1.mult >= 10 ? '#ff9a3c' : p1.mult >= 4 ? '#ffd35c' : '#7ce7a2';
  }
  if (p2 && mode === 'duo') {
    updatePlayerCard(card2, p2);
    mult2.hidden = false;
    mult2.textContent = ` · P2 ×${p2.mult}`;
  } else {
    mult2.hidden = true;
  }
  const powered = players.some((p) => p.powerTimer > 0);
  powerupEl.hidden = !powered;
  if (powered) {
    powerTimeEl.textContent = String(Math.ceil(Math.max(...players.map((p) => p.powerTimer))));
  }

  // co-op revive countdown, pinned above the downed player's body
  const downed = players.find((p) => p.downed);
  if (downed) {
    REPROJECT.set(downed.x, 2.2, downed.z);
    world.camera.updateMatrixWorld();
    REPROJECT.project(world.camera);
    reviveLabelEl.hidden = false;
    reviveLabelEl.textContent =
      downed.reviveHold > 0
        ? `HIGH-FIVE! ${Math.max(1, Math.ceil(COOP_CONFIG.reviveHoldSeconds - downed.reviveHold))}s`
        : `REVIVING IN: ${Math.max(1, Math.ceil(downed.reviveTimer))}s`;
    reviveLabelEl.style.left = `${((REPROJECT.x * 0.5 + 0.5) * window.innerWidth).toFixed(1)}px`;
    reviveLabelEl.style.top = `${((-REPROJECT.y * 0.5 + 0.5) * window.innerHeight).toFixed(1)}px`;
  } else {
    reviveLabelEl.hidden = true;
  }
  updateMateLabels(); // respawn countdowns above downed teammates
  updateCurseVisuals(); // curse cleansing circles + progress labels

  // Minimal retro intermission countdown, pinned top-centre and hidden the
  // moment the wave starts spawning.
  if (director.phase === 'intermission') {
    waveTimerEl.hidden = false;
    waveTimerEl.textContent = `NEXT WAVE IN: ${Math.max(0, director.timer).toFixed(1)}s`;
  } else {
    waveTimerEl.hidden = true;
  }

  if (toastTimer > 0) {
    messageEl.textContent = toastText;
  } else if (director.phase === 'intermission') {
    messageEl.textContent = ''; // the top-centre wave timer owns the intermission readout
  } else {
    messageEl.textContent = `გადარჩე: ${horde.zombies.length} მტერი`;
  }
}

let lastTime = performance.now();
function frame(nowMs: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min((nowMs - lastTime) / 1000, 0.05);
  lastTime = nowMs;
  if (phase === 'playing') update(dt, nowMs);
  fx.update(dt);
  gibs.update(dt);
  world.renderer.render(world.scene, world.camera);
}

// Debug handle: read-only state for automated gameplay checks / console.
Object.defineProperty(globalThis, '__game_shoot', {
  value: {
    get phase(): Phase {
      return phase;
    },
    get mode(): GameMode {
      return mode;
    },
    /** True while the current match is an online room match. */
    get online(): boolean {
      return isOnline;
    },
    /** Number of network-driven peer actors currently rendered. */
    get remotes(): number {
      return remotePlayers.length;
    },
    get players(): Player[] {
      return players;
    },
    get horde(): Horde {
      return horde;
    },
    get director(): Director {
      return director;
    },
    /** Test hook: the live Black Devil boss (null when none is on the field). */
    get boss(): { hp: number; maxHp: number; attackState: string; x: number; z: number } | null {
      const boss = horde.zombies.find((zombie) => zombie.alive && zombie.kind === 'blackDevil');
      if (!boss) return null;
      return {
        hp: boss.hp,
        maxHp: boss.maxHp,
        attackState: boss.attackState,
        x: boss.x,
        z: boss.z,
      };
    },
    get world(): World {
      return world;
    },
    get score(): number {
      return score;
    },
    get barricades(): Barricade[] {
      return barricades;
    },
    get mines(): Mine[] {
      return mines;
    },
    get pickups(): Pickup[] {
      return pickups;
    },
    /** Test hook: how many entities the server-authoritative mirror renders. */
    get mirrored(): { enemies: number; props: number; drops: number } {
      return {
        enemies: onlineWorld.mirroredEnemies,
        props: onlineWorld.mirroredProps,
        drops: onlineWorld.mirroredDrops,
      };
    },
    /** Test hook: the exact server entity ids this client is rendering. */
    get mirroredIds(): { enemies: number[]; props: string[]; drops: number[] } {
      return {
        enemies: onlineWorld.enemyIds(),
        props: onlineWorld.propCells(),
        drops: onlineWorld.dropIds(),
      };
    },
    /** Test hook: every rendered drop with its server position. */
    get dropPoints(): { id: number; x: number; z: number }[] {
      return onlineWorld.dropPoints();
    },
    /**
     * Test hook: deploy a prop through the real online path when online (the
     * room validates + replicates it), or the local path otherwise.
     */
    placeProp(kind: 'barrel' | 'crate', cx: number, cz: number): void {
      if (isOnline && onlineLobby) onlineLobby.requestPlaceProp(kind, cx, cz);
      else placeBarricade(world.grid, world.scene, barricades, cx, cz, kind);
    },
    /** Test hook: damage a rendered mob (reported to the room when online). */
    hitEnemy(index: number, damage: number, weaponId: number): void {
      const zombie = horde.zombies[index];
      if (!zombie) return;
      if (isOnline) {
        const id = onlineWorld.enemyIdOf(zombie);
        if (id !== undefined) onlineLobby?.reportEnemyHit(id, damage, weaponId);
        return;
      }
      damageZombie(zombie, damage, players[0] ?? null, null);
    },
    /** Test hook: damage one specific server mob id (online only). */
    hitEnemyId(id: number, damage: number, weaponId: number): void {
      if (!isOnline) return;
      onlineLobby?.reportEnemyHit(id, damage, weaponId);
    },
    get projectiles(): Projectile[] {
      return projectiles;
    },
    /** Test hook: inject a zombie at a world position. */
    spawnZombie(kind: 'walker' | 'runner' | 'devil' | 'blackDevil', x: number, z: number): void {
      spawnZombie(horde, world.scene, kind, x, z);
    },
    /** Test hook: deal damage through the real rules (kills / combo / score). */
    damageZombie(index: number, amount: number, ownerIndex: number): void {
      const zombie = horde.zombies[index];
      if (zombie) damageZombie(zombie, amount, players[ownerIndex] ?? null, null);
    },
    /** Test hook: place an explosive barrel on a grid cell (blocks the cell). */
    placeBarrel(cx: number, cz: number): void {
      placeBarricade(world.grid, world.scene, barricades, cx, cz, 'barrel');
    },
    /** Test hook: place a wooden crate on a grid cell (blocks, never explodes). */
    placeCrate(cx: number, cz: number): void {
      placeBarricade(world.grid, world.scene, barricades, cx, cz, 'crate');
    },
    /** Test hook: the current special-wave event. */
    get waveEvent(): WaveEventKind {
      return director.event;
    },
    /** Test hook: whether the blackout lighting rig is engaged. */
    get blackout(): boolean {
      return nightMode.isActive;
    },
    /** Test hook: apply damage through the real rules (downed / game over). */
    damagePlayer(index: number, amount: number): void {
      const player = players[index];
      if (player) applyDamage(player, amount);
    },
    /** Test hook: inject a pickup at a world position. */
    spawnPickup(kind: PickupKind, x: number, z: number): void {
      spawnPickup(world.scene, pickups, x, z, kind);
    },
    /** Test hook: run the mob-drop roll `times` times, returns how many dropped. */
    rollDrop(times: number): number {
      let drops = 0;
      for (let i = 0; i < times; i++) if (rollDropKind()) drops++;
      return drops;
    },
    /** Active explosion flashes (test hook). */
    get flashes(): Flash[] {
      return flashes;
    },
  },
});

// The menu modal is the initial screen; the world renders behind it.
showMenu();
requestAnimationFrame(frame);
