// Secret character "LIZI" check — drives the real client UI over CDP.
//
// Guards the refactored, picker-free character flow:
//   1. there is NO standard character picker — only a discreet "Secret" button;
//   2. default characters are auto-assigned (duo: P1 → first skin, P2 → second);
//   3. the Secret button opens the code modal; a wrong code is rejected and
//      "  MOON  " (trimmed, case-insensitive) overrides the character with LIZI;
//   4. NOTHING is persisted (no localStorage/sessionStorage/cookies), so a
//      reload resets the player to their auto-assigned default;
//   5. the override spawns LIZI with her model + LIZI_STATS (150 HP, ×1.3);
//   6. the LIZI-only 'G' mode grants all weapons + infinite ammo and reverts on
//      toggle-off — and is ignored for default characters.
//
// Requires the Vite client on http://localhost:5173 and a Chrome on
// --remote-debugging-port=9333:
//   node scripts/lizi-check.mjs
const DEBUG = process.env.DEBUG_URL || 'http://localhost:9333';
const CLIENT = process.env.CLIENT_URL || 'http://localhost:5173/';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  await send('Page.bringToFront');

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result.value;
  };

  const poll = async (expression, ok, label, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        const raw = await evaluate(expression);
        last = raw ? JSON.parse(raw) : null;
        if (last && ok(last)) return last;
      } catch {
        // execution context destroyed mid-navigation — retry
      }
      await sleep(150);
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

// The discreet Secret button + modal state, read from the DOM.
const secretProbe = `JSON.stringify((() => {
  const btn = document.getElementById('secretBtn');
  if (!btn) return { present: false };
  return {
    present: true,
    hidden: btn.hidden,
    active: btn.classList.contains('active'),
    label: btn.textContent.trim(),
    modalOpen: !document.getElementById('liziModal').hidden,
    err: document.getElementById('liziError').textContent,
    storedUnlock: window.localStorage.getItem('lizi_unlocked'),
    storedChar: window.localStorage.getItem('boxhead.character'),
    cookie: document.cookie,
    pickerExists: !!document.getElementById('charGrid'),
    pickerCards: document.querySelectorAll('#charGrid .charCard').length,
  };
})())`;

/** Types a code into the modal and submits it. */
const submitCode = (code) => `(() => {
  const input = document.getElementById('liziCode');
  input.value = ${JSON.stringify(code)};
  document.getElementById('liziSubmit').click();
  return true;
})()`;

const page = await connect(CLIENT);
try {
  await page.poll(`JSON.stringify({ ready: !!globalThis.__game_shoot })`, (o) => o.ready, 'boot');

  // Start from a clean slate so the "nothing persisted" check is meaningful.
  await page.evaluate(`window.localStorage.clear(); document.cookie = 'lizi_unlocked=; Max-Age=0; path=/'; true`);
  await page.evaluate(`location.reload(); true`);
  await sleep(1200);
  await page.poll(
    `JSON.stringify({ ready: !!globalThis.__game_shoot })`,
    (o) => o.ready,
    'reboot after clearing storage'
  );

  // 1. No standard picker — just the discreet Secret button, starting locked.
  const start = await page.poll(secretProbe, (o) => o.present && !o.hidden, 'the Secret button renders');
  assert(start.pickerExists === false && start.pickerCards === 0,
    'the standard character picker is gone');
  assert(!start.active && /secret/i.test(start.label),
    `the discreet button starts locked (label "${start.label}")`);

  // 2. Clicking "Secret" opens the code modal.
  await page.evaluate(`document.getElementById('secretBtn').click(); true`);
  const modal = await page.poll(secretProbe, (o) => o.modalOpen, 'the code modal opens');
  assert(modal.modalOpen, 'clicking "Secret" opens the password modal');

  // 3. A wrong code is rejected.
  await page.evaluate(submitCode('wrong'));
  const wrong = await page.poll(secretProbe, (o) => o.err.length > 0, 'the wrong code errors');
  assert(!wrong.active, 'a wrong code leaves the character unchanged');
  assert(/WRONG/i.test(wrong.err), 'the wrong code shows a rejection message');

  // 4. "  MOON  " (trimmed + case-insensitive) overrides the character with LIZI.
  await page.evaluate(submitCode('  MOON  '));
  const unlocked = await page.poll(secretProbe, (o) => o.active, 'LIZI unlocks');
  assert(unlocked.active && /LIZI/i.test(unlocked.label),
    `the secret character is unlocked and the button reflects it (label "${unlocked.label}")`);
  assert(!unlocked.modalOpen, 'the modal closes on success');
  assert(unlocked.storedUnlock === null, 'no localStorage key is written for the unlock');
  assert(unlocked.storedChar === null, 'no localStorage key is written for the character');
  assert(!/lizi/i.test(unlocked.cookie), 'no cookie is written for the unlock');

  // 5. A reload resets to the default (the override is session-only).
  await page.evaluate(`location.reload(); true`);
  await sleep(1200);
  const reloaded = await page.poll(secretProbe, (o) => o.present && !o.hidden, 'grid rebuilt after reload');
  assert(!reloaded.active && /secret/i.test(reloaded.label),
    'a reload resets the character back to the default (session-only override)');
  assert(reloaded.storedUnlock === null, 'the reload wrote no unlock storage either');

  // 6. Defaults are auto-assigned and the mode is LIZI-only (fresh second page).
  const other = await connect(CLIENT);
  try {
    await other.poll(`JSON.stringify({ ready: !!globalThis.__game_shoot })`, (o) => o.ready, 'second page boot');
    await other.evaluate(
      `(async () => {
        document.querySelector('.modeBtn[data-mode="duo"]').click();
        await new Promise((r) => setTimeout(r, 300));
        const g = globalThis.__game_shoot;
        g.director.timer = 1e9; g.horde.zombies.length = 0;
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', bubbles: true }));
        await new Promise((r) => setTimeout(r, 250)); // let a few frames process it
        return true;
      })()`
    );
    const duo = await other.poll(
      `JSON.stringify((() => {
         const g = globalThis.__game_shoot;
         return {
           count: g.players.length,
           chars: g.players.map((p) => p.character),
           nameplates: g.players.map((p) => p.mesh.children.some((c) => c.type === 'Sprite')),
           modes: g.players.map((p) => p.liziMode),
           chipHidden: document.getElementById('liziMode').hidden,
         };
       })())`,
      (o) => o.count === 2,
      'a duo match starts'
    );
    assert(duo.chars[0] === 'bambo' && duo.chars[1] === 'bon',
      `standard characters are auto-assigned (P1 → ${duo.chars[0]}, P2 → ${duo.chars[1]})`);
    assert(duo.nameplates[0] === false && duo.nameplates[1] === false,
      'default characters carry no LIZI nameplate');
    assert(duo.modes[0] === false && duo.modes[1] === false,
      "'G' does nothing without the secret unlock");
    assert(duo.chipHidden === true, 'the LIZI mode chip stays hidden for default characters');
  } finally {
    await other.close();
  }

  // 7. Re-unlock, then verify the override + LIZI_STATS in a real match.
  await page.evaluate(`document.getElementById('secretBtn').click(); true`);
  await page.evaluate(submitCode('moon'));
  await page.poll(secretProbe, (o) => o.active, 're-unlock for the match');

  await page.evaluate(
    `(async () => {
      document.querySelector('.modeBtn[data-mode="single"]').click();
      await new Promise((r) => setTimeout(r, 250));
      const g = globalThis.__game_shoot;
      g.director.timer = 1e9; g.horde.zombies.length = 0;
      return true;
    })()`
  );
  const lizi = await page.poll(
    `JSON.stringify((() => {
       const p = globalThis.__game_shoot.players[0];
       return p
         ? { character: p.character, hp: p.hp, maxHp: p.maxHp, damageMult: p.damageMult,
             speedBase: p.speedBase, meshChildren: p.mesh ? p.mesh.children.length : 0,
             nameplate: !!(p.mesh && p.mesh.children.some((c) => c.type === 'Sprite')) }
         : null;
     })())`,
    (o) => o && o.character === 'lizi',
    'a solo match spawns LIZI'
  );
  assert(lizi.character === 'lizi', 'the override spawns the player as LIZI');
  assert(lizi.meshChildren > 10, `LIZI has a full blocky model (${lizi.meshChildren} parts)`);
  assert(lizi.nameplate === true, 'her model carries the "LIZI" nameplate');
  assert(lizi.maxHp === 150 && lizi.hp === 150, 'LIZI starts at LIZI_STATS.MAX_HP = 150');
  assert(Math.abs(lizi.damageMult - 1.3) < 1e-9, 'LIZI_STATS.DAMAGE_MULTIPLIER = 1.3 applied');
  assert(Math.abs(lizi.speedBase - 1.0) < 1e-9, 'LIZI_STATS.SPEED_MULTIPLIER = 1.0 applied');

  // 8. Firing a real shot applies DAMAGE_MULTIPLIER to outgoing damage.
  //    Pistol base damage is 25 with 15% falloff over 24 u, so at 1.5 u a
  //    standard character deals ~24.77; LIZI must deal ~1.3× that (~32.2).
  const shot = JSON.parse(
    await page.evaluate(`(async () => {
      const g = globalThis.__game_shoot;
      const p = g.players[0];
      const grid = g.world.grid;
      g.horde.zombies.length = 0;
      g.director.timer = 1e9;
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      let dir = null;
      for (const cand of dirs) {
        const mx = p.x + cand[0] * 1.5, mz = p.z + cand[1] * 1.5;
        if (!grid.isBlockedWorld(mx, mz) && !grid.isBlockedWorld(p.x + cand[0], p.z + cand[1])) { dir = cand; break; }
      }
      if (!dir) return JSON.stringify({ ok: false, reason: 'no clear shooting lane' });
      p.aimX = dir[0]; p.aimZ = dir[1]; p.facing = Math.atan2(dir[0], dir[1]);
      g.spawnZombie('walker', p.x + dir[0] * 1.5, p.z + dir[1] * 1.5);
      const zombie = g.horde.zombies[g.horde.zombies.length - 1];
      const before = zombie.hp;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
      return JSON.stringify({ ok: true, before, after: zombie.hp, dealt: before - zombie.hp });
    })()`)
  );
  assert(shot.ok, `a clear shooting lane exists (${shot.reason ?? 'ok'})`);
  assert(shot.dealt > 30 && shot.dealt < 33,
    `a LIZI pistol shot deals ~32 (×1.3) damage, got ${shot.dealt?.toFixed(2)}`);

  // 9. God-mode speed slider: shown for LIZI, bounded by the config, and it
  //    drives the live movement multiplier (verified by real displacement).
  const slider = JSON.parse(
    await page.evaluate(`JSON.stringify((() => {
      const wrap = document.getElementById('speedSliderWrap');
      const el = document.getElementById('speedSlider');
      return { visible: !wrap.hidden, type: el.type,
               min: parseFloat(el.min), max: parseFloat(el.max), step: parseFloat(el.step),
               value: parseFloat(el.value),
               label: document.querySelector('.speedSliderLabel').textContent.replace(/\\s+/g, ' ').trim() };
    })())`)
  );
  assert(slider.visible, 'the speed slider is shown while playing as LIZI');
  assert(slider.type === 'range', 'the speed control is an <input type="range">');
  assert(slider.min === 1 && slider.max === 3.5 && slider.step === 0.1,
    `slider bounds match LIZI_SPEED_SLIDER (min ${slider.min}, max ${slider.max}, step ${slider.step})`);
  assert(slider.value === 1 && /Speed: 1\.0x/.test(slider.label),
    `it starts at the default readout ("${slider.label}")`);

  // Moving the slider updates the player's multiplier + readout in real time.
  await page.evaluate(`(() => {
    const el = document.getElementById('speedSlider');
    el.value = '2.5';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const movedSlider = await page.poll(
    `JSON.stringify((() => {
       const p = globalThis.__game_shoot.players[0];
       return { speedMultiplier: p.speedMultiplier,
                label: document.querySelector('.speedSliderLabel').textContent.replace(/\\s+/g, ' ').trim() };
     })())`,
    (o) => o.speedMultiplier === 2.5,
    'the slider drives player.speedMultiplier'
  );
  assert(movedSlider.speedMultiplier === 2.5,
    'dragging the slider updates player.speedMultiplier in real time');
  assert(/Speed: 2\.5x/.test(movedSlider.label), `the readout tracks the slider ("${movedSlider.label}")`);

  // The multiplier reaches the movement math: 3x really moves ~3x further.
  const move = JSON.parse(
    await page.evaluate(`(async () => {
      const g = globalThis.__game_shoot;
      const p = g.players[0];
      const grid = g.world.grid;
      g.horde.zombies.length = 0; g.director.timer = 1e9;
      p.speedMult = 1; // no spree boost, isolate the slider
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const keys = { '1,0': 'ArrowRight', '-1,0': 'ArrowLeft', '0,1': 'ArrowDown', '0,-1': 'ArrowUp' };
      let dir = null, best = -1;
      for (const d of dirs) {
        const clear = grid.raycastDistance(p.x, p.z, d[0], d[1], 14);
        if (clear > best) { best = clear; dir = d; }
      }
      const key = keys[dir.join(',')];
      const sx = p.x, sz = p.z;
      const run = async (mult) => {
        p.speedMultiplier = mult;
        p.x = sx; p.z = sz;
        window.dispatchEvent(new KeyboardEvent('keydown', { code: key, bubbles: true }));
        await new Promise((r) => setTimeout(r, 160));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: key, bubbles: true }));
        return Math.hypot(p.x - sx, p.z - sz);
      };
      const slow = await run(1);
      const fast = await run(3);
      return JSON.stringify({ slow, fast, clearance: best, key });
    })()`)
  );
  assert(move.clearance > 5, `a clear runway exists to measure movement (${move.clearance.toFixed(1)} u)`);
  assert(move.fast > move.slow * 2,
    `3x speed really moves faster (${move.slow.toFixed(2)} u vs ${move.fast.toFixed(2)} u)`);

  // The slider swallows its own events so it can't interrupt gameplay inputs.
  const gulped = JSON.parse(
    await page.evaluate(`(async () => {
      const seen = [];
      const spy = (e) => seen.push(e.type + (e.code ? ':' + e.code : ''));
      window.addEventListener('keydown', spy);
      window.addEventListener('pointerdown', spy);
      window.addEventListener('mousedown', spy);
      window.addEventListener('click', spy);
      const slider = document.getElementById('speedSlider');
      slider.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true }));
      slider.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', bubbles: true }));
      slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      slider.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      slider.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      window.removeEventListener('keydown', spy);
      window.removeEventListener('pointerdown', spy);
      window.removeEventListener('mousedown', spy);
      window.removeEventListener('click', spy);
      return JSON.stringify({ seen });
    })()`)
  );
  assert(gulped.seen.length === 0,
    `slider events never reach the game's window listeners (saw ${JSON.stringify(gulped.seen)})`);

  // Back to the default before the god-mode section.
  await page.evaluate(`(() => {
    const el = document.getElementById('speedSlider');
    el.value = '1';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  // 10. LIZI GOD MODE: 'G' grants invulnerability + every weapon + infinite ammo.
  await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', bubbles: true })); true`);
  const on = await page.poll(
    `JSON.stringify((() => {
       const p = globalThis.__game_shoot.players[0];
       const chip = document.getElementById('liziMode');
       return { mode: p.liziMode, grantedSize: p.granted.size, granted: [...p.granted],
                chipHidden: chip.hidden, chipActive: chip.classList.contains('active'),
                chipText: chip.textContent };
     })())`,
    (o) => o.mode === true,
    'LIZI mode engages'
  );
  assert(on.mode, "pressing 'G' activates LIZI god mode");
  assert(on.grantedSize === 9, `every weapon is unlocked (${on.grantedSize} slots: pistol…crate)`);
  assert(
    [1, 2, 3, 6, 7].every((id) => on.granted.includes(id)),
    'shotgun / uzi / grenade / rocket / railgun are all in the weapon wheel'
  );
  assert(!on.chipHidden && on.chipActive, 'the HUD badge shows the active state');
  assert(/LIZI GOD MODE: ACTIVE/.test(on.chipText),
    `the badge reads "LIZI GOD MODE: ACTIVE" (got "${on.chipText}")`);

  // 10b. Invulnerability: no source can damage her and HP stays pegged at max.
  const god = JSON.parse(
    await page.evaluate(`(async () => {
      const g = globalThis.__game_shoot;
      const p = g.players[0];
      g.damagePlayer(0, 9999); // every in-game source funnels through applyDamage
      g.damagePlayer(0, 9999);
      await new Promise((r) => setTimeout(r, 150));
      return JSON.stringify({ hp: p.hp, maxHp: p.maxHp, alive: p.alive, downed: p.downed,
                              sliderVisible: !document.getElementById('speedSliderWrap').hidden });
    })()`)
  );
  assert(god.hp === god.maxHp && god.hp === 150,
    `god mode takes 0 damage and HP stays pegged at max (hp ${god.hp})`);
  assert(god.alive === true && god.downed === false, 'god mode never goes down');
  assert(god.sliderVisible === true, 'the speed slider stays visible in god mode');

  // 11. Firing a limited weapon consumes no ammo while the mode is active.
  const ammo = JSON.parse(
    await page.evaluate(`(async () => {
      const g = globalThis.__game_shoot;
      const p = g.players[0];
      g.horde.zombies.length = 0; g.director.timer = 1e9;
      p.weapon = 1;        // shotgun (a limited magazine)
      p.lastFireMs = -1e9;
      p.ammo.set(1, 3);    // seed a small reserve so a spend would be visible
      const before = p.ammo.get(1);
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
      await new Promise((r) => setTimeout(r, 250));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
      return JSON.stringify({ before, after: p.ammo.get(1), weapon: p.weapon });
    })()`)
  );
  assert(ammo.weapon === 1, 'the shotgun stays equipped while the mode is active');
  assert(ammo.before === 3 && ammo.after === 3,
    `firing consumes no ammo in LIZI mode (${ammo.before} → ${ammo.after})`);

  // 12. Toggling off (via the F8 hotkey) reverts everything to standard rules.
  await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F8', bubbles: true })); true`);
  const off = await page.poll(
    `JSON.stringify((() => {
       const p = globalThis.__game_shoot.players[0];
       const chip = document.getElementById('liziMode');
       return { mode: p.liziMode, grantedSize: p.granted.size, weapon: p.weapon,
                speedMultiplier: p.speedMultiplier, sliderValue: parseFloat(document.getElementById('speedSlider').value),
                chipActive: chip.classList.contains('active'), chipHidden: chip.hidden, chipText: chip.textContent };
     })())`,
    (o) => o.mode === false,
    'LIZI god mode disengages'
  );
  assert(off.grantedSize === 0, 'toggling off reverts the granted weapons to the standard set');
  assert(off.weapon === 0, 'toggling off restores the pre-mode weapon (pistol)');
  assert(!off.chipActive && !off.chipHidden && /GOD MODE: OFF/.test(off.chipText),
    'the badge drops back to the inactive state');
  assert(off.speedMultiplier === 1 && off.sliderValue === 1,
    'toggling off resets the speed slider back to the 1.0x default');

  // 12b. Damage is received normally again once god mode is off.
  const mortal = JSON.parse(
    await page.evaluate(`(async () => {
      const g = globalThis.__game_shoot;
      const p = g.players[0];
      const before = p.hp;
      g.damagePlayer(0, 20);
      await new Promise((r) => setTimeout(r, 150));
      return JSON.stringify({ before, after: p.hp });
    })()`)
  );
  assert(mortal.after === mortal.before - 20,
    `damage is received again after god mode (${mortal.before} → ${mortal.after})`);

  assert(
    page.errors.length === 0,
    `no console errors${page.errors.length ? ` (${JSON.stringify(page.errors)})` : ''}`
  );

  console.log('[lizi-check] PASS');
} catch (error) {
  console.error('[lizi-check] FAIL:', error?.message ?? error);
  if (page.errors.length) console.error('  errors:', page.errors);
  process.exitCode = 1;
} finally {
  await page.close();
}
