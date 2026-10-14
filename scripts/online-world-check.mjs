/**
 * Authoritative-world check — verifies the Colyseus CoopRoom owns the shared
 * world (mobs, barrels/crates, drops) and that every client observes the same
 * entities and the same one-shot events.
 *
 * Requires a running server (default ws://localhost:2567, override with
 * LOBBY_URL). Run it with:
 *
 *   PORT=2599 node --experimental-strip-types server/src/index.ts   # terminal 1
 *   LOBBY_URL=ws://localhost:2599 node scripts/online-world-check.mjs
 *
 * Asserts:
 *  - the room spawns mobs with stable ids, positions, health and targets, and
 *    both clients see the identical set;
 *  - `placeProp` deploys a barrel/crate that every client observes;
 *  - `damageProp` destroys a barrel → `propDestroyed` + `explosion` broadcast to
 *    both clients and the prop removed from state (crates splinter without a
 *    blast);
 *  - `damageEnemy` kills → `enemyKilled` broadcast (with the killer's id) and the
 *    mob removed from state for everyone;
 *  - kills roll loot into `state.drops`, and `pickupItem` grants + removes it for
 *    both clients;
 *  - the wave director is mirrored into the room state.
 */
import { Client } from 'colyseus.js';

const URL = process.env.LOBBY_URL || 'ws://localhost:2567';
const ROOM = 'coop';
/** Barrel wire code 0 / crate 1 (shared/src/loot.ts PROP_KINDS order). */
const PROP_BARREL = 0;
const PROP_CRATE = 1;

function waitFor(room, predicate, label, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const safe = (state) => {
      try {
        return predicate(state);
      } catch {
        return false;
      }
    };
    const handler = (state) => {
      if (safe(state)) {
        clearTimeout(timer);
        room.onStateChange.remove(handler);
        resolve(state);
      }
    };
    const timer = setTimeout(() => {
      room.onStateChange.remove(handler);
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);
    if (safe(room.state)) {
      clearTimeout(timer);
      resolve(room.state);
      return;
    }
    room.onStateChange(handler);
  });
}

/** Collects `type` messages on a room and resolves on the next one. */
function nextMessage(room, type, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for '${type}' message`)), timeoutMs);
    room.onMessage(type, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok — ${message}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const host = new Client(URL);
const guest = new Client(URL);

let hostRoom;
let guestRoom;
/** Keeps both players parked mid-arena at full HP so targeting stays stable. */
let presenceTimer;

try {
  console.log(`[online-world-check] connecting to ${URL}`);
  hostRoom = await host.create(ROOM, { name: 'Hosty' });
  await waitFor(hostRoom, (s) => s.players.size >= 1, 'host initial state');
  guestRoom = await guest.joinById(hostRoom.roomId, { name: 'Guesty' });
  await waitFor(hostRoom, (s) => s.players.size === 2, 'host sees guest');

  hostRoom.send('start');
  await waitFor(guestRoom, (s) => s.phase === 'playing', 'match start');
  console.log('  match started');

  // Park both players in the arena's open plaza so mobs have a real target.
  presenceTimer = setInterval(() => {
    hostRoom.send('presence', { x: 20, z: 20, aimX: 1, aimZ: 0, hp: 100, weapon: 0 });
    guestRoom.send('presence', { x: 21, z: 20, aimX: -1, aimZ: 0, hp: 100, weapon: 0 });
  }, 100);

  // --- 1. server-authored mobs -------------------------------------------
  console.log('\n[1] server-authoritative mobs');
  await waitFor(hostRoom, (s) => s.enemies.size > 0, 'enemies spawned', 12000);
  assert(hostRoom.state.enemies.size > 0, `host sees ${hostRoom.state.enemies.size} server mobs`);

  const firstEnemy = [...hostRoom.state.enemies.values()][0];
  assert(typeof firstEnemy.id === 'number', `mob carries a server id (${firstEnemy.id})`);
  assert(
    [...hostRoom.state.enemies.keys()].includes(String(firstEnemy.id)),
    'the map key is the server mob id'
  );
  assert(
    Number.isFinite(firstEnemy.x) && Number.isFinite(firstEnemy.z),
    `mob has a server position (${firstEnemy.x.toFixed(1)}, ${firstEnemy.z.toFixed(1)})`
  );
  assert(firstEnemy.hp > 0 && firstEnemy.maxHp >= firstEnemy.hp, 'mob reports health');
  assert(firstEnemy.target.length > 0, `mob is chasing a player (${firstEnemy.target.slice(0, 6)}…)`);

  await waitFor(guestRoom, (s) => s.enemies.size > 0, 'guest sees mobs', 12000);
  const hostIds = [...hostRoom.state.enemies.keys()].sort();
  const guestIds = [...guestRoom.state.enemies.keys()].sort();
  assert(
    hostIds.join() === guestIds.join(),
    `both clients see the same mobs (${hostIds.length} entities)`
  );

  assert(hostRoom.state.wave >= 1, `wave director mirrored into state (wave ${hostRoom.state.wave})`);
  assert(
    typeof hostRoom.state.directorPhase === 'string',
    `director phase mirrored (${hostRoom.state.directorPhase})`
  );

  // --- 2. server-owned props --------------------------------------------
  console.log('\n[2] server-authoritative props');
  hostRoom.send('placeProp', { kind: PROP_BARREL, cx: 20, cz: 30 });
  hostRoom.send('placeProp', { kind: PROP_CRATE, cx: 34, cz: 20 });
  await waitFor(guestRoom, (s) => s.props.get('20,30') && s.props.get('34,20'), 'guest sees props');
  const barrel = guestRoom.state.props.get('20,30');
  assert(barrel.kind === PROP_BARREL, 'barrel placement replicated to the peer');
  assert(guestRoom.state.props.get('34,20').kind === PROP_CRATE, 'crate placement replicated');
  assert(barrel.hp > 0 && barrel.maxHp === 150, `barrel starts at full durability (${barrel.maxHp})`);

  // Shooting a barrel destroys it → blast broadcast to everyone.
  const barrelExplosion = nextMessage(guestRoom, 'explosion');
  const barrelDestroyed = nextMessage(guestRoom, 'propDestroyed');
  hostRoom.send('damageProp', { cx: 20, cz: 30, damage: 1000 });
  const blast = await barrelExplosion;
  const ruin = await barrelDestroyed;
  assert(blast.radius > 0, `explosion broadcast to the peer (radius ${blast.radius})`);
  assert(ruin.kind === PROP_BARREL, 'propDestroyed names the barrel');
  await waitFor(hostRoom, (s) => !s.props.get('20,30'), 'barrel removed from state');
  assert(!hostRoom.state.props.get('20,30'), 'destroyed barrel left the state for every client');

  // A crate splinters without a blast.
  let sawCrateBlast = false;
  const crateWatch = (msg) => {
    sawCrateBlast = true;
    console.log('    (unexpected crate blast)', msg);
  };
  hostRoom.onMessage('explosion', crateWatch);
  const crateDestroyed = nextMessage(hostRoom, 'propDestroyed');
  hostRoom.send('damageProp', { cx: 34, cz: 20, damage: 1000 });
  const crateRuin = await crateDestroyed;
  assert(crateRuin.kind === PROP_CRATE, 'crate destroyed without detonating');
  assert(!sawCrateBlast, 'a crate never sends an explosion event');

  // --- 3. mob death + loot ----------------------------------------------
  console.log('\n[3] mob death and loot');
  const victimId = [...hostRoom.state.enemies.values()][0].id;
  const killMessage = nextMessage(guestRoom, 'enemyKilled');
  hostRoom.send('damageEnemy', { id: victimId, damage: 10000, weaponId: 0 });
  const killed = await killMessage;
  assert(killed.id === victimId, `peer observes the kill of mob ${victimId}`);
  assert(killed.killer === hostRoom.sessionId, 'the kill is credited to the shooter');
  await waitFor(hostRoom, (s) => !s.enemies.get(String(victimId)), 'mob removed from state');
  assert(!hostRoom.state.enemies.get(String(victimId)), 'dead mob left the state for every client');

  // Keep killing until the loot table produces a drop.
  for (let round = 0; round < 40 && hostRoom.state.drops.size === 0; round++) {
    const ids = [...hostRoom.state.enemies.values()].map((enemy) => enemy.id);
    if (ids.length === 0) {
      await waitFor(hostRoom, (s) => s.enemies.size > 0, 'next spawn batch', 8000);
      continue;
    }
    for (const id of ids.slice(0, 6)) {
      hostRoom.send('damageEnemy', { id, damage: 10000, weaponId: 0 });
    }
    await sleep(120);
  }
  await waitFor(hostRoom, (s) => s.drops.size > 0, 'loot dropped', 12000);
  assert(hostRoom.state.drops.size > 0, `loot exists in the shared state (${hostRoom.state.drops.size})`);
  const drop = [...hostRoom.state.drops.values()][0];
  assert(
    Number.isFinite(drop.x) && Number.isFinite(drop.z) && typeof drop.kind === 'number',
    `drop carries type + position (kind ${drop.kind} at ${drop.x.toFixed(1)}, ${drop.z.toFixed(1)})`
  );
  assert(drop.ttl > 0 && drop.ttl <= 15, `drop has a server despawn timer (${drop.ttl.toFixed(1)}s)`);

  await waitFor(guestRoom, (s) => s.drops.get(String(drop.id)), 'guest sees the drop');
  assert(guestRoom.state.drops.get(String(drop.id)).kind === drop.kind, 'drop replicated to the peer');

  // Walk the host onto the drop, then ask the room to grant it. The presence
  // pump is stopped first so it cannot drag the player back off the drop.
  clearInterval(presenceTimer);
  presenceTimer = null;
  hostRoom.send('presence', { x: drop.x, z: drop.z, aimX: 1, aimZ: 0, hp: 100, weapon: 0 });
  await sleep(200);
  const granted = nextMessage(hostRoom, 'granted');
  hostRoom.send('pickupItem', { id: drop.id, x: drop.x, z: drop.z });
  const award = await granted;
  assert(typeof award.kind === 'number', `pickup granted (kind ${award.kind})`);
  await waitFor(guestRoom, (s) => !s.drops.get(String(drop.id)), 'drop removed for the peer');
  assert(
    !guestRoom.state.drops.get(String(drop.id)),
    'collected drop left the state for every client'
  );

  console.log('\n[online-world-check] PASS — server owns mobs, props and drops');
} catch (error) {
  console.error(`\n[online-world-check] ${error.message}`);
  process.exitCode = 1;
} finally {
  clearInterval(presenceTimer);
  try {
    hostRoom?.leave(true);
    guestRoom?.leave(true);
  } catch {
    /* already closed */
  }
}
