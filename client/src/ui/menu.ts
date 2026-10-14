/**
 * Start-screen modal + game-over panel wiring (see index.html).
 * Also owns the pre-game map selector: it renders the `MAP_DEFINITIONS` cards
 * (name, pitch and a live mini-map preview) and hands the chosen map id to the
 * game when a mode is launched.
 */
import { DEFAULT_MAP_ID, MAP_DEFINITIONS } from '../../../shared/src/maps.ts';
import type { MapDefinition } from '../../../shared/src/maps.ts';
import { MAX_PLAYERS } from '../../../shared/src/constants.ts';
import { SERVER_URL } from '../network/serverUrl.ts';
import type { ConnectionState, RoomInfo } from '../network/lobby.ts';

export type StartMode = 'single' | 'duo';

export interface MenuHandlers {
  onStart: (mode: StartMode, mapId: string) => void;
  onRestart: () => void;
  onMenu: () => void;
  /** "Create Room" — host a new online room seeded with the chosen map. */
  onCreateRoom: (name: string, mapId: string) => void;
  /** "Join" — connect to an existing room by its 6-char code. */
  onJoinRoom: (code: string, name: string) => void;
  /** Host pressed "Start Match". */
  onStartOnline: () => void;
  /** The player left the online room. */
  onLeaveOnline: () => void;
}

/** One player's contribution, rendered as a column of the summary table. */
export interface PlayerSummary {
  /** Column header, e.g. `P1 (BAMBO)`. */
  label: string;
  kills: number;
  shotsFired: number;
  shotsHit: number;
  /** hits / shots, in 0..1 (0 when nothing was fired). */
  accuracy: number;
  bestCombo: number;
}

/** Full end-of-match summary model handed to `showMatchSummary`. */
export interface MatchSummary {
  players: PlayerSummary[];
  wave: number;
  score: number;
  bestWave: number;
  bestScore: number;
  newWaveRecord: boolean;
  newScoreRecord: boolean;
}

/** Currently highlighted arena (persists across menu visits). */
let selectedMapId: string = DEFAULT_MAP_ID;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
}

/**
 * Highlights the control-binding block(s) for the selected mode so the active
 * layout is obvious: Solo lights the single-player block; Local 2-Player lights
 * BOTH player blocks (P1 green / P2 blue layouts sit side by side).
 */
function setActiveLayout(mode: StartMode): void {
  byId('ctrlSingle').classList.toggle('active', mode === 'single');
  byId('ctrlP1').classList.toggle('active', mode === 'duo');
  byId('ctrlP2').classList.toggle('active', mode === 'duo');
}

/** Repaints the selected-state ring on every map card. */
function reflectSelectedMap(): void {
  document.querySelectorAll<HTMLButtonElement>('.mapCard').forEach((card) => {
    card.classList.toggle('active', card.dataset.mapId === selectedMapId);
  });
}

/** Draws a 1px-per-cell preview of a map's walls onto a small canvas. */
function drawMapPreview(canvas: HTMLCanvasElement, map: MapDefinition): void {
  canvas.width = map.width;
  canvas.height = map.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#16203a'; // walkable floor
  ctx.fillRect(0, 0, map.width, map.height);
  ctx.fillStyle = '#5a6a8a'; // solid cover
  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      if (map.grid[z][x] === 1) ctx.fillRect(x, z, 1, 1);
    }
  }
}

/** Builds the clickable map cards from the shared registry (data-driven). */
function buildMapCards(): void {
  const grid = byId('mapGrid');
  grid.innerHTML = '';
  for (const map of MAP_DEFINITIONS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'mapCard';
    card.dataset.mapId = map.id;

    const canvas = document.createElement('canvas');
    drawMapPreview(canvas, map);

    const text = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = map.name;
    const description = document.createElement('span');
    description.textContent = map.description;
    text.append(name, description);

    card.append(canvas, text);
    card.addEventListener('click', () => {
      selectedMapId = map.id;
      reflectSelectedMap();
    });
    grid.append(card);
  }
  reflectSelectedMap();
}

export function initMenu(handlers: MenuHandlers): void {
  buildMapCards();
  const onlinePanel = byId('onlinePanel');
  const onlineNote = byId('onlineNote');
  const playerName = byId<HTMLInputElement>('playerName');
  const roomCode = byId<HTMLInputElement>('roomCode');

  // Remember the player's display name across visits.
  const NAME_KEY = 'boxhead.playerName';
  const persistName = (): void => {
    try {
      window.localStorage.setItem(NAME_KEY, playerName.value.trim());
    } catch {
      /* storage unavailable — the name just won't persist */
    }
  };
  try {
    playerName.value = window.localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    /* storage unavailable */
  }
  const chosenName = (): string => playerName.value.trim() || 'Player';

  document.querySelectorAll<HTMLButtonElement>('.modeBtn').forEach((button) => {
    const mode = button.dataset.mode;
    // Hovering/focusing a mode previews its controls layout (live switching)
    if (mode === 'single' || mode === 'duo') {
      const preview = () => setActiveLayout(mode);
      button.addEventListener('mouseenter', preview);
      button.addEventListener('focus', preview);
    }
    button.addEventListener('click', () => {
      if (mode === 'single' || mode === 'duo') {
        setActiveLayout(mode);
        hideOverlay();
        handlers.onStart(mode, selectedMapId);
      } else {
        // "Online Multiplayer" — reveal the room/connection panel. Only reset
        // the status line when we're not already inside a room (the connect
        // controls are hidden once a room is joined).
        onlinePanel.hidden = !onlinePanel.hidden;
        if (!onlinePanel.hidden && !playerName.hidden) {
          setOnlineStatus('idle', `სერვერი: ${SERVER_URL}`);
        }
      }
    });
  });

  byId('createRoom').addEventListener('click', () => {
    persistName();
    handlers.onCreateRoom(chosenName(), selectedMapId);
  });
  byId('joinRoom').addEventListener('click', () => {
    persistName();
    handlers.onJoinRoom(roomCode.value.trim().toUpperCase(), chosenName());
  });
  // Room codes are uppercase A–Z / 2–9 (no ambiguous glyphs).
  roomCode.addEventListener('input', () => {
    roomCode.value = roomCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  roomCode.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') byId('joinRoom').click();
  });
  byId('startMatch').addEventListener('click', () => handlers.onStartOnline());
  byId('leaveRoom').addEventListener('click', () => handlers.onLeaveOnline());
  byId('copyCode').addEventListener('click', () => {
    const code = byId('roomCodeDisplay').textContent ?? '';
    navigator.clipboard?.writeText(code).then(
      () => setOnlineStatus('connected', `კოდი დაკოპირებულია: ${code}`),
      () => setOnlineStatus('connected', `ოთახის კოდი: ${code}`)
    );
  });

  byId('restartBtn').addEventListener('click', () => {
    hideOverlay();
    handlers.onRestart();
  });
  byId('menuBtn').addEventListener('click', () => {
    showMenu();
    handlers.onMenu();
  });
}

/**
 * Renders the connection status line and toggles the connect buttons while a
 * connection attempt is in flight. Called by main.ts from the Lobby handlers.
 */
export function setOnlineStatus(state: ConnectionState, message: string): void {
  const note = byId('onlineNote');
  note.textContent = message || `სერვერი: ${SERVER_URL}`;
  note.classList.toggle('error', state === 'error');
  const busy = state === 'connecting';
  byId<HTMLButtonElement>('createRoom').disabled = busy;
  byId<HTMLButtonElement>('joinRoom').disabled = busy;
}

/**
 * Renders the online room lobby from a synchronized room snapshot (or hides it
 * and restores the connect controls when `info` is null).
 */
export function setRoomInfo(info: RoomInfo | null): void {
  const showConnect = info === null;
  byId('playerName').hidden = !showConnect;
  byId('roomCode').hidden = !showConnect;
  byId('joinRoom').hidden = !showConnect;
  byId('createRoom').hidden = !showConnect;

  byId('roomLobby').hidden = info === null;
  if (!info) return;

  byId('roomCodeDisplay').textContent = info.code;
  byId('roomCount').textContent = `${info.players.length}/${MAX_PLAYERS}`;

  const startBtn = byId<HTMLButtonElement>('startMatch');
  startBtn.hidden = !info.isHost;
  startBtn.disabled = info.phase !== 'lobby';

  const list = byId('roomPlayers');
  list.innerHTML = '';
  if (info.players.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'მოთამაშეები ჯერ არ არიან';
    list.append(empty);
    return;
  }
  for (const player of info.players) {
    const item = document.createElement('li');
    if (player.sessionId === info.hostId) item.classList.add('host');
    if (!player.connected) item.classList.add('away');

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = `${player.seat + 1}. ${player.name}`;

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent =
      player.sessionId === info.selfId
        ? 'შენ'
        : player.sessionId === info.hostId
          ? 'ჰოსტი'
          : player.connected
            ? ''
            : 'კავშირი გაწყდა';

    item.append(who, tag);
    list.append(item);
  }
}

export function hideOverlay(): void {
  byId('overlay').hidden = true;
}

export function showMenu(mode: StartMode = 'single'): void {
  setActiveLayout(mode); // highlight the controls layout for the chosen mode
  reflectSelectedMap(); // keep the last-picked arena highlighted
  byId('menuPanel').hidden = false;
  byId('gameOverPanel').hidden = true;
  byId('overlay').hidden = false;
}

/** Escapes text before it is injected via innerHTML. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
  );
}

/**
 * Renders the retro end-game summary: a P1-vs-P2 comparison table plus the
 * wave/score totals and an all-time-record badge.
 */
export function showMatchSummary(summary: MatchSummary): void {
  const headCells = [
    '<th>MATCH STATS</th>',
    ...summary.players.map((p, i) => `<th class="p${i + 1}col">${escapeHtml(p.label)}</th>`),
  ].join('');
  const row = (label: string, cell: (p: PlayerSummary) => string): string =>
    `<tr><td>${label}</td>${summary.players
      .map((p) => `<td>${cell(p)}</td>`)
      .join('')}</tr>`;

  const rows = [
    row('Kills', (p) => String(p.kills)),
    row('Shots fired', (p) => String(p.shotsFired)),
    row(
      'Accuracy',
      (p) =>
        `${Math.round(p.accuracy * 100)}% <span style="opacity:.65">(${p.shotsHit}/${p.shotsFired})</span>`
    ),
    row('Highest combo', (p) => `×${p.bestCombo}`),
  ].join('');

  const table = `<table class="summaryTable"><thead><tr>${headCells}</tr></thead><tbody>${rows}</tbody></table>`;
  const waveTag = summary.newWaveRecord ? ' <span class="p1col">NEW!</span>' : '';
  const scoreTag = summary.newScoreRecord ? ' <span class="p1col">NEW!</span>' : '';
  const totals = `<div class="summaryTotals">
      Wave reached: <b>${summary.wave}</b>${waveTag} · All-time best: <b>${summary.bestWave}</b><br/>
      Total score: <b>${summary.score}</b>${scoreTag} · All-time best: <b>${summary.bestScore}</b>
    </div>`;

  byId('summaryWrap').innerHTML = table + totals;
  const badge = byId('recordBadge');
  badge.hidden = !(summary.newWaveRecord || summary.newScoreRecord);
  byId('menuPanel').hidden = true;
  byId('gameOverPanel').hidden = false;
  byId('overlay').hidden = false;
}
