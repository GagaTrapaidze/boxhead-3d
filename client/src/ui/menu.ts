/**
 * Start-screen modal + game-over panel wiring (see index.html).
 * Also owns the pre-game map selector: it renders the `MAP_DEFINITIONS` cards
 * (name, pitch and a live mini-map preview) and hands the chosen map id to the
 * game when a mode is launched.
 */
import { DEFAULT_MAP_ID, MAP_DEFINITIONS } from '../../../shared/src/maps.ts';
import type { MapDefinition } from '../../../shared/src/maps.ts';
import { SERVER_URL } from '../network/serverUrl.ts';

export type StartMode = 'single' | 'duo';

export interface MenuHandlers {
  onStart: (mode: StartMode, mapId: string) => void;
  onRestart: () => void;
  onMenu: () => void;
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
        // "Online Multiplayer" — reveal the room-code panel (server is Phase 2)
        onlinePanel.hidden = !onlinePanel.hidden;
      }
    });
  });

  byId('joinRoom').addEventListener('click', () => {
    byId('onlineNote').textContent =
      `ონლაინი ჯერ არ მუშაობს — სერვერი/ლობი დაემატება Phase 2-ში (ოთახის კოდით). სერვერი: ${SERVER_URL}`;
  });
  byId('createRoom').addEventListener('click', () => {
    byId('onlineNote').textContent =
      `ოთახის შქმნა სერვერს საჭიროებს — დაელოდე Phase 2-ს (Colyseus ლობი). სერვერი: ${SERVER_URL}`;
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
