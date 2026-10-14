/**
 * Lobby smoke test — exercises the Colyseus CoopRoom end-to-end.
 *
 * Requires a running server (default ws://localhost:2567, override with
 * LOBBY_URL). Run it with:
 *
 *   npm run dev:server            # in one terminal
 *   node scripts/lobby-check.mjs  # in another
 *
 * Asserts: a room can be created, a second client joins by its 6-char code,
 * presence relay reaches the peer, and the host can start the match.
 */
import { Client } from 'colyseus.js';

const URL = process.env.LOBBY_URL || 'ws://localhost:2567';

/** Resolves once the room state satisfies `predicate`, checking the current
 *  state first and re-checking on every patch; rejects after `timeoutMs`. */
function waitFor(room, predicate, label, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const finish = (state) => {
      clearTimeout(timer);
      room.onStateChange.remove(handler);
      resolve(state);
    };
    const safe = (state) => {
      try {
        return predicate(state);
      } catch {
        return false; // state not fully synced yet
      }
    };
    const handler = (state) => {
      if (safe(state)) finish(state);
    };
    const timer = setTimeout(() => {
      room.onStateChange.remove(handler);
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);
    if (safe(room.state)) {
      finish(room.state);
      return;
    }
    room.onStateChange(handler);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok — ${message}`);
}

const host = new Client(URL);
const guest = new Client(URL);

let hostRoom;
let guestRoom;

try {
  console.log(`[lobby-check] connecting to ${URL}`);
  hostRoom = await host.create('coop', { name: 'Hosty' });
  await waitFor(hostRoom, (s) => s.players.size >= 1, 'host initial state');
  assert(hostRoom.roomId.length === 6, `room code is 6 chars (${hostRoom.roomId})`);
  assert(hostRoom.state.code === hostRoom.roomId, 'state.code mirrors roomId');

  guestRoom = await guest.joinById(hostRoom.roomId, { name: 'Guesty' });
  await waitFor(hostRoom, (s) => s.players.size === 2, 'host sees guest');
  await waitFor(guestRoom, (s) => s.players.size === 2, 'guest state');
  assert(hostRoom.state.players.size === 2, 'both players present in host state');
  assert(guestRoom.state.code === hostRoom.roomId, 'guest sees the same room code');

  const hostId = hostRoom.state.hostId;
  assert(!!hostId, 'a host was elected');

  // Presence relay: host reports a position, guest should observe it.
  const seatHost = hostRoom.state.players.get(hostId);
  assert(seatHost.name === 'Hosty', 'host name round-tripped');

  // Non-host cannot start.
  guestRoom.send('start');
  await new Promise((r) => setTimeout(r, 250));
  assert(hostRoom.state.phase === 'lobby', 'non-host start is ignored');

  // Host starts the match.
  hostRoom.send('start');
  await waitFor(guestRoom, (s) => s.phase === 'playing', 'match start');
  assert(guestRoom.state.phase === 'playing', 'guest observes match start');

  // Presence only relays once playing.
  const guestId = [...guestRoom.state.players.keys()].find((id) => id !== hostId);
  hostRoom.send('presence', { x: 12.5, z: -3.25, aimX: 1, aimZ: 0, hp: 80, weapon: 2 });
  await waitFor(guestRoom, (s) => s.players.get(hostId)?.x === 12.5, 'presence relay');
  const relayed = guestRoom.state.players.get(hostId);
  assert(relayed.x === 12.5 && relayed.hp === 80 && relayed.weapon === 2, 'presence relayed to peer');
  assert(guestId !== undefined, 'guest has a distinct session id');

  console.log('[lobby-check] PASS');
} catch (error) {
  console.error('[lobby-check] FAIL:', error?.message ?? error);
  process.exitCode = 1;
} finally {
  await hostRoom?.leave(true).catch(() => {});
  await guestRoom?.leave(true).catch(() => {});
}
