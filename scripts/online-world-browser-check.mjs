// Authoritative-world browser check — drives two real client tabs over CDP.
//
// Two tabs open the Vite client, one creates a room, the other joins by its
// 6-char code, the host starts the match. Both tabs must then render the *same*
// server-authored world: the identical mob ids, the barrels/crates the room
// replicated, and the loot the room spawned — with a mob the host kills
// disappearing from both tabs (and crediting the shared team score shown on
// BOTH HUDs). Walking one player onto a drop must also clear it from both tabs
// and raise both scores together.
//
// Requires:
//   · the Colyseus server on ws://localhost:2567  (npm run dev:server)
//   · the Vite client on http://localhost:5173    (npm run dev:client)
//   · a Chrome started with --remote-debugging-port=9333
//
//   node scripts/online-world-browser-check.mjs
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

  const poll = async (expression, ok, label, timeoutMs = 15000) => {
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

  /**
   * Brings this tab to the front. Headless Chrome pauses requestAnimationFrame
   * in background tabs, and the HUD (plus the walk-over pickup scan) is drawn by
   * the render loop — so read the DOM only from a focused tab.
   */
  const focus = () => send('Page.bringToFront');

  return { evaluate, poll, errors, focus, close };
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok — ${message}`);
}

const host = await connect(CLIENT);
const guest = await connect(CLIENT);

try {
  await host.poll(`JSON.stringify({ ready: !!globalThis.__game_shoot })`, (o) => o.ready, 'host boot');
  await guest.poll(`JSON.stringify({ ready: !!globalThis.__game_shoot })`, (o) => o.ready, 'guest boot');

  // --- create + join + start ------------------------------------------------
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
    })`,
    (o) => o.lobbyVisible && /^[A-Z0-9]{6}$/.test(o.code),
    'room creation'
  );
  const code = created.code;
  console.log(`  room code: ${code}`);

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
    })`,
    (o) => o.inRoom,
    'guest join'
  );

  await host.poll(
    `JSON.stringify({ count: document.querySelectorAll('#roomPlayers li').length })`,
    (o) => o.count === 2,
    'lobby roster of 2'
  );
  await host.evaluate(`document.getElementById('startMatch').click()`);

  const playing = `JSON.stringify({ phase: globalThis.__game_shoot.phase, online: globalThis.__game_shoot.online })`;
  await host.poll(playing, (o) => o.phase === 'playing' && o.online, 'host enters online play');
  await guest.poll(playing, (o) => o.phase === 'playing' && o.online, 'guest enters online play');
  assert(true, 'both tabs entered online play');

  // --- 1. identical server mobs on both clients -----------------------------
  console.log('\n[1] mobs are server-authored and identical on both clients');
  const worldExpr = `JSON.stringify({
    ids: globalThis.__game_shoot.mirroredIds,
    score: globalThis.__game_shoot.score,
    wave: globalThis.__game_shoot.director.wave,
  })`;
  const hostWorld = await host.poll(worldExpr, (o) => o.ids.enemies.length > 0, 'host renders mobs', 20000);
  const guestWorld = await guest.poll(worldExpr, (o) => o.ids.enemies.length > 0, 'guest renders mobs', 20000);
  assert(
    hostWorld.ids.enemies.join() === guestWorld.ids.enemies.join(),
    `both tabs render the identical mob ids (${hostWorld.ids.enemies.length} mobs)`
  );
  assert(hostWorld.wave >= 1 && guestWorld.wave === hostWorld.wave, `same wave on both clients (${hostWorld.wave})`);

  // --- 2. server-replicated props ------------------------------------------
  console.log('\n[2] props replicate to both clients');
  await host.evaluate(`globalThis.__game_shoot.placeProp('barrel', 20, 30)`);
  await host.evaluate(`globalThis.__game_shoot.placeProp('crate', 34, 20)`);
  const propExpr = `JSON.stringify({ props: globalThis.__game_shoot.mirroredIds.props })`;
  const hostProps = await host.poll(propExpr, (o) => o.props.includes('20,30') && o.props.includes('34,20'), 'host renders props');
  const guestProps = await guest.poll(propExpr, (o) => o.props.includes('20,30') && o.props.includes('34,20'), 'guest renders props');
  assert(hostProps.props.join() === guestProps.props.join(), `both tabs render the same props (${hostProps.props.join(' | ')})`);

  // --- 3. a kill by the host disappears on both clients (unison destruction) --
  console.log('\n[3] destruction is broadcast to every client');
  const victimId = JSON.parse(
    await host.evaluate(`JSON.stringify(globalThis.__game_shoot.mirroredIds.enemies[0])`)
  );
  await host.evaluate(`globalThis.__game_shoot.hitEnemyId(${victimId}, 10000, 0)`);
  const goneExpr = `JSON.stringify({ gone: !globalThis.__game_shoot.mirroredIds.enemies.includes(${victimId}) })`;
  await host.poll(goneExpr, (o) => o.gone, `host drops mob ${victimId}`, 8000);
  await guest.poll(goneExpr, (o) => o.gone, `guest drops mob ${victimId}`, 8000);
  assert(true, `the mob the host killed (id ${victimId}) left both clients' world`);
  const scored = await host.poll(
    `JSON.stringify({ score: globalThis.__game_shoot.score })`,
    (o) => o.score > hostWorld.score,
    'host score credit',
    8000
  );
  assert(
    scored.score > hostWorld.score,
    `the kill credited the shooter (${hostWorld.score} → ${scored.score})`
  );

  // --- 4. loot is server-spawned and mirrored on both clients ---------------
  console.log('\n[4] loot is server-spawned and mirrored');
  let hostLoot = [];
  for (let round = 0; round < 30 && hostLoot.length === 0; round++) {
    const count = JSON.parse(
      await host.evaluate(`JSON.stringify(globalThis.__game_shoot.mirroredIds.enemies.length)`)
    );
    // Kill from the top down so the mirror's indices stay stable while firing.
    for (let index = Math.min(count, 6) - 1; index >= 0; index--) {
      await host.evaluate(`globalThis.__game_shoot.hitEnemy(${index}, 10000, 0)`);
    }
    await sleep(500);
    hostLoot = JSON.parse(await host.evaluate(`JSON.stringify(globalThis.__game_shoot.mirroredIds.drops)`));
  }
  assert(hostLoot.length > 0, `the room dropped loot the client renders (${hostLoot.join(', ')})`);
  const wanted = JSON.stringify(hostLoot);
  const guestLoot = await guest.poll(
    `JSON.stringify({ drops: globalThis.__game_shoot.mirroredIds.drops })`,
    (o) => JSON.parse(wanted).every((id) => o.drops.includes(id)),
    'guest renders the same loot',
    10000
  );
  assert(
    JSON.parse(wanted).every((id) => guestLoot.drops.includes(id)),
    `both clients render the identical drops (${hostLoot.join(', ')})`
  );

  // --- 5. one shared team score + shared loot on both HUDs -------------------
  console.log('\n[5] both HUDs show the same shared team score');
  const scoreExpr = `JSON.stringify({
    score: globalThis.__game_shoot.score,
    hud: document.getElementById('score').textContent.trim(),
    label: document.getElementById('scoreLabel').textContent.trim(),
  })`;
  await host.focus();
  const hostScore = await host.poll(scoreExpr, (o) => o.score > 0, 'host HUD score');
  assert(
    hostScore.hud === String(hostScore.score),
    `the host HUD renders the score number (${hostScore.hud})`
  );
  assert(/TEAM/.test(hostScore.label), `the HUD labels it as the shared pool ("${hostScore.label}")`);
  // The guest landed none of those kills, yet its HUD carries the same total.
  await guest.focus();
  const guestScore = await guest.poll(scoreExpr, (o) => o.score === hostScore.score, 'guest mirrors score');
  assert(
    guestScore.hud === String(guestScore.score) && guestScore.score === hostScore.score,
    `both tabs display the same score (${hostScore.hud} / ${guestScore.hud})`
  );

  // Walking the host onto a drop must grant it (shared benefit) and credit the
  // shared pool on BOTH clients, and the cube must vanish from both worlds.
  await host.focus();
  const drop = JSON.parse(await host.evaluate(`JSON.stringify(globalThis.__game_shoot.dropPoints[0])`));
  assert(!!drop, `the host renders a drop to walk onto (id ${drop?.id})`);
  const beforePickup = guestScore.score;
  await host.evaluate(
    `(() => { const p = globalThis.__game_shoot.players[0]; p.x = ${drop.x}; p.z = ${drop.z}; return true; })()`
  );
  const goneDrop = `JSON.stringify({ gone: !globalThis.__game_shoot.mirroredIds.drops.includes(${drop.id}) })`;
  await host.poll(goneDrop, (o) => o.gone, 'the walked-over drop left the host world', 8000);
  await guest.poll(goneDrop, (o) => o.gone, 'the walked-over drop left the guest world', 8000);
  assert(true, `the loot the host walked over (id ${drop.id}) is gone for BOTH clients`);
  const hostAfter = await host.poll(scoreExpr, (o) => o.score > beforePickup, 'host pickup score', 8000);
  assert(
    hostAfter.score > beforePickup,
    `the shared team score rose on pickup (${beforePickup} → ${hostAfter.score})`
  );
  // Focus the guest so its render loop (and therefore its HUD) is live, then wait
  // for its score number to catch up with the host's.
  await guest.focus();
  const guestAfter = await guest.poll(
    scoreExpr,
    (o) => o.score === hostAfter.score && o.hud === String(o.score),
    'guest HUD mirrors the pickup score',
    8000
  );
  assert(
    guestAfter.hud === String(hostAfter.score),
    `the guest HUD shows the updated shared score too (${guestAfter.hud})`
  );

  if (host.errors.length || guest.errors.length) {
    throw new Error(`console errors: host=${JSON.stringify(host.errors)} guest=${JSON.stringify(guest.errors)}`);
  }
  assert(true, 'no console errors on either client');

  console.log('\n[online-world-browser-check] PASS — both clients render the same server world and score');
} catch (error) {
  console.error('[online-world-browser-check] FAIL:', error?.message ?? error);
  if (host.errors.length) console.error('  host errors:', host.errors);
  if (guest.errors.length) console.error('  guest errors:', guest.errors);
  process.exitCode = 1;
} finally {
  await host.close();
  await guest.close();
}
