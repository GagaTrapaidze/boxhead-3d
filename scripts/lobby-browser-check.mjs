// Online lobby browser check — drives the real client UI over CDP.
//
// Two tabs open the Vite client, one creates a room, the other joins by its
// 6-char code, the host starts the match, and both tabs must enter online play
// with a remote peer rendered.
//
// Requires:
//   · the Colyseus server on ws://localhost:2567  (npm run dev:server)
//   · the Vite client on http://localhost:5173    (npm run dev:client)
//   · a Chrome started with --remote-debugging-port=9333
//
//   node scripts/lobby-browser-check.mjs
const DEBUG = process.env.DEBUG_URL || 'http://localhost:9333';
const CLIENT = process.env.CLIENT_URL || 'http://localhost:5173/';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Opens a CDP tab for `url` and returns helpers to evaluate JS in it. */
async function connect(url) {
  const res = await fetch(`${DEBUG}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`target creation failed: ${res.status}`);
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const errors = [];

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(`EXCEPTION: ${message.params.exceptionDetails.text}`);
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('websocket failed'));
  });
  await send('Runtime.enable');
  await send('Page.enable');

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(`evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result.value;
  };

  // Poll an async expression returning JSON until `ok(obj)` is true.
  const poll = async (expression, ok, label, timeoutMs = 12000) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      const raw = await evaluate(expression);
      last = raw ? JSON.parse(raw) : null;
      if (last && ok(last)) return last;
      await sleep(200);
    }
    throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
  };

  const close = async () => {
    try {
      ws.close();
    } catch {}
    await fetch(`${DEBUG}/json/close/${target.id}`).catch(() => {});
  };

  return { evaluate, poll, errors, close };
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok — ${message}`);
}

const host = await connect(CLIENT);
const guest = await connect(CLIENT);

try {
  // Wait for both clients to boot the game.
  await host.poll(`JSON.stringify({ ready: !!globalThis.__game_shoot })`, (o) => o.ready, 'host boot');
  await guest.poll(`JSON.stringify({ ready: !!globalThis.__game_shoot })`, (o) => o.ready, 'guest boot');

  // --- actions run ONCE (polling only reads, never re-triggers) --------------

  // Host opens the online panel and creates a room.
  await host.evaluate(
    `(async () => {
      document.querySelector('.modeBtn[data-mode="online"]').click();
      await new Promise((r) => setTimeout(r, 100));
      document.getElementById('playerName').value = 'Hosty';
      document.getElementById('createRoom').click();
      return true;
    })()`
  );
  const created = await host.poll(
    `JSON.stringify({
      lobbyVisible: !document.getElementById('roomLobby').hidden,
      code: document.getElementById('roomCodeDisplay').textContent.trim(),
      note: document.getElementById('onlineNote').textContent,
    })`,
    (o) => o.lobbyVisible && /^[A-Z0-9]{6}$/.test(o.code),
    'room creation'
  );
  const code = created.code;
  console.log(`  room code: ${code}`);
  assert(/^[A-Z0-9]{6}$/.test(code), 'host created a 6-char room code');

  // Guest joins by code.
  await guest.evaluate(
    `(async () => {
      document.querySelector('.modeBtn[data-mode="online"]').click();
      await new Promise((r) => setTimeout(r, 100));
      document.getElementById('playerName').value = 'Guesty';
      const rc = document.getElementById('roomCode');
      rc.value = ${JSON.stringify(code)};
      rc.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('joinRoom').click();
      return true;
    })()`
  );
  await guest.poll(
    `JSON.stringify({
      inRoom: !document.getElementById('roomLobby').hidden &&
        document.getElementById('roomCodeDisplay').textContent.trim() === ${JSON.stringify(code)},
      note: document.getElementById('onlineNote').textContent,
    })`,
    (o) => o.inRoom,
    'guest join'
  );
  assert(true, 'guest joined the room by code');

  // Host sees exactly two players in the lobby.
  const roster = await host.poll(
    `JSON.stringify({ count: document.querySelectorAll('#roomPlayers li').length })`,
    (o) => o.count === 2,
    'lobby roster of 2'
  );
  assert(roster.count === 2, 'host sees both players in the lobby');

  await host.evaluate(`document.getElementById('startMatch').click()`);

  const playingExpr = `JSON.stringify({
    phase: globalThis.__game_shoot.phase,
    online: globalThis.__game_shoot.online,
    players: globalThis.__game_shoot.players.length,
    remotes: globalThis.__game_shoot.remotes,
  })`;
  const sceneHost = await host.poll(playingExpr, (o) => o.phase === 'playing', 'host enters play');
  let sceneGuest;
  try {
    sceneGuest = await guest.poll(playingExpr, (o) => o.phase === 'playing', 'guest enters play');
  } catch (error) {
    const diag = await guest.evaluate(`JSON.stringify({
      note: document.getElementById('onlineNote').textContent,
      lobbyHidden: document.getElementById('roomLobby').hidden,
      count: document.getElementById('roomCount').textContent,
      startHidden: document.getElementById('startMatch').hidden,
      overlayHidden: document.getElementById('overlay').hidden,
      hudHidden: document.getElementById('hud').hidden,
      game: Object.keys(globalThis.__game_shoot ?? {}),
    })`);
    throw new Error(`${error.message} | guest diag=${diag} | guest errors=${JSON.stringify(guest.errors)}`);
  }

  assert(sceneHost.online && sceneGuest.online, 'both clients are in online mode');
  assert(sceneHost.players === 1 && sceneGuest.players === 1, 'each client controls exactly one local player');
  assert(sceneHost.remotes === 1 && sceneGuest.remotes === 1, 'each client renders one remote peer');

  // --- downed → teammate countdown → 10 s respawn -------------------------
  await host.evaluate(`globalThis.__game_shoot.damagePlayer(0, 9999)`);
  const downed = await host.poll(
    `JSON.stringify({ phase: globalThis.__game_shoot.phase, downed: globalThis.__game_shoot.players[0].downed })`,
    (o) => o.downed === true,
    'local player downed'
  );
  assert(downed.phase === 'playing', 'room stays live while a teammate is alive');

  await guest.poll(
    `JSON.stringify({ labels: [...document.querySelectorAll('.mateLabel')]
      .filter((el) => !el.hidden).map((el) => el.textContent) })`,
    (o) => o.labels.some((text) => /REVIVING IN/.test(text)),
    'teammate respawn countdown'
  );
  assert(true, "downed player's countdown is visible to the teammate");

  const revived = await host.poll(
    `JSON.stringify({ alive: globalThis.__game_shoot.players[0].alive, hp: globalThis.__game_shoot.players[0].hp })`,
    (o) => o.alive === true,
    'respawn after 10s',
    15000
  );
  assert(revived.hp === 100, 'respawned at full health');

  // --- Game Over when every player is down at once ------------------------
  // Clear the post-respawn i-frames directly: headless throttles a background
  // tab's rAF, so relying on their 2 s decay would be flaky (not what we test).
  await host.evaluate(
    `globalThis.__game_shoot.players[0].invulnTimer = 0; globalThis.__game_shoot.damagePlayer(0, 9999)`
  );
  await guest.evaluate(
    `globalThis.__game_shoot.players[0].invulnTimer = 0; globalThis.__game_shoot.damagePlayer(0, 9999)`
  );
  await host.poll(`JSON.stringify({ phase: globalThis.__game_shoot.phase })`, (o) => o.phase === 'over', 'host game over');
  await guest.poll(`JSON.stringify({ phase: globalThis.__game_shoot.phase })`, (o) => o.phase === 'over', 'guest game over');
  assert(true, 'Game Over reached on every client');

  const overlay = JSON.parse(
    await host.evaluate(
      `JSON.stringify({ overlay: !document.getElementById('overlay').hidden, panel: !document.getElementById('gameOverPanel').hidden })`
    )
  );
  assert(overlay.overlay && overlay.panel, 'Game Over screen shown to the player');

  if (host.errors.length || guest.errors.length) {
    throw new Error(`console errors: host=${JSON.stringify(host.errors)} guest=${JSON.stringify(guest.errors)}`);
  }
  assert(true, 'no console errors on either client');

  console.log('[lobby-browser-check] PASS');
} catch (error) {
  console.error('[lobby-browser-check] FAIL:', error?.message ?? error);
  if (host.errors.length) console.error('  host errors:', host.errors);
  if (guest.errors.length) console.error('  guest errors:', guest.errors);
  process.exitCode = 1;
} finally {
  await host.close();
  await guest.close();
}
