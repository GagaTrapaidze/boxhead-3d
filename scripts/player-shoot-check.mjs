/**
 * Remote-shot FX check — verifies the Colyseus CoopRoom relay that makes a
 * player's firing visuals (tracer + muzzle flash + gunshot) visible to the
 * OTHER players.
 *
 * Requires a running server (default ws://localhost:2567, override with
 * LOBBY_URL). Run it with:
 *
 *   PORT=2599 node --experimental-strip-types server/src/index.ts   # terminal 1
 *   LOBBY_URL=ws://localhost:2599 node scripts/player-shoot-check.mjs
 *
 * Asserts:
 *  - a `playerShoot` sent by one client is relayed to every OTHER client with
 *    the shooter's origin, aim direction and weapon id intact;
 *  - the shooter never receives its own shot back (`{ except: client }`);
 *  - a shot with no direction is dropped by the room (nothing to draw);
 *  - the relay spawns no server entity — the shared world is untouched, so fast
 *    bullets stay pure client-side tracers (performance requirement).
 */
import { Client } from 'colyseus.js';

const URL = process.env.LOBBY_URL || 'ws://localhost:2567';
const ROOM = 'coop';

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

/** Collects every `type` message a room receives (for negative assertions too). */
function collect(room, type) {
  const messages = [];
  room.onMessage(type, (msg) => messages.push(msg));
  return messages;
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
let presenceTimer;

try {
  console.log(`[player-shoot-check] connecting to ${URL}`);
  hostRoom = await host.create(ROOM, { name: 'Hosty' });
  await waitFor(hostRoom, (s) => s.players.size >= 1, 'host initial state');
  guestRoom = await guest.joinById(hostRoom.roomId, { name: 'Guesty' });
  await waitFor(hostRoom, (s) => s.players.size === 2, 'host sees guest');

  hostRoom.send('start');
  await waitFor(guestRoom, (s) => s.phase === 'playing', 'match start');
  console.log('  match started');

  // Park both players so the world keeps simulating around them.
  presenceTimer = setInterval(() => {
    hostRoom.send('presence', { x: 20, z: 20, aimX: 1, aimZ: 0, hp: 100, weapon: 0, mult: 1 });
    guestRoom.send('presence', { x: 21, z: 20, aimX: -1, aimZ: 0, hp: 100, weapon: 0, mult: 1 });
  }, 100);

  // Listeners are attached before firing so nothing is missed.
  const hostShots = collect(hostRoom, 'playerShoot');
  const guestShots = collect(guestRoom, 'playerShoot');

  console.log('\n[1] a shot reaches the OTHER client with the payload intact');
  hostRoom.send('playerShoot', {
    origin: { x: 20, y: 0.7, z: 20 },
    direction: { x: 1, y: 0, z: 0 },
    weaponType: 2, // Uzi
  });
  await waitFor(guestRoom, () => guestShots.length > 0, 'guest receives the shot', 4000);
  const shot = guestShots[0];
  assert(shot.weaponType === 2, `weapon id relayed intact (${shot.weaponType})`);
  assert(Math.abs(shot.origin.x - 20) < 0.01 && Math.abs(shot.origin.z - 20) < 0.01, 'origin relayed');
  assert(Math.abs(shot.origin.y - 0.7) < 0.01, 'origin height relayed');
  assert(shot.direction.x > 0.99 && Math.abs(shot.direction.z) < 0.01, 'aim direction relayed');

  console.log('\n[2] the shooter never receives its own shot');
  await sleep(250);
  assert(hostShots.length === 0, 'no self-echo (broadcast used { except: client })');

  console.log('\n[3] a directionless shot is dropped by the room');
  const guestBefore = guestShots.length;
  hostRoom.send('playerShoot', {
    origin: { x: 20, y: 0.7, z: 20 },
    direction: { x: 0, y: 0, z: 0 },
    weaponType: 0,
  });
  await sleep(250);
  assert(guestShots.length === guestBefore, 'zero-direction shot produced no relay');

  console.log('\n[4] the relay spawns no server entity');
  const enemiesBefore = hostRoom.state.enemies.size;
  const propsBefore = hostRoom.state.props.size;
  await sleep(300);
  assert(
    hostRoom.state.enemies.size === enemiesBefore && hostRoom.state.props.size === propsBefore,
    `world untouched by the relay (enemies ${enemiesBefore}, props ${propsBefore})`
  );

  console.log('\n[player-shoot-check] PASS — remote shots are relayed to peers only, as pure visuals');
} catch (error) {
  console.error(`\n[player-shoot-check] ${error.message}`);
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
