/**
 * Secret character unlock — a single, discreet "Secret" button on the main menu.
 *
 * There is no standard character picker: default characters are auto-assigned by
 * `main.ts` (P1 the first skin, P2 the second, seats in online play). This module
 * only owns the optional session override — entering the secret code swaps the
 * local player's character for "LIZI" until the page is reloaded.
 *
 * The unlock is SESSION-ONLY: it lives purely in module memory. Nothing is ever
 * written to localStorage, sessionStorage, cookies or any other permanent store,
 * so refreshing/restarting resets the player to their default character.
 */
import { CHARACTERS } from '../game/actors.ts';
import type { CharacterId } from '../game/actors.ts';

/** The secret code that unlocks LIZI (matched case-insensitively). */
export const LIZI_SECRET_CODE = 'moon';

/** The secret character's id. */
const SECRET_ID: CharacterId = 'lizi';

/**
 * SESSION-ONLY override (module memory — deliberately never persisted): the
 * character forced for the local player, or null for their auto-assigned default.
 */
let override: CharacterId | null = null;

/** The character override to apply on spawn (null = use the default skin). */
export function getCharacterOverride(): CharacterId | null {
  return override;
}

/** True once LIZI has been unlocked this session (resets on reload). */
export function isSecretUnlocked(): boolean {
  return override !== null;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
}

// ── Secret-code modal ────────────────────────────────────────────────────────

function openModal(): void {
  const error = byId('liziError');
  error.textContent = '';
  const input = byId<HTMLInputElement>('liziCode');
  input.value = '';
  byId('liziModal').hidden = false;
  input.focus();
}

function closeModal(): void {
  byId('liziModal').hidden = true;
}

function showModalError(message: string): void {
  const error = byId('liziError');
  error.textContent = message;
  const card = document.querySelector<HTMLElement>('.liziCard');
  if (card) {
    card.classList.remove('shake');
    void card.offsetWidth; // force reflow so the animation restarts
    card.classList.add('shake');
  }
}

/** Reflects the current unlock state on the discreet menu button. */
function reflectButton(): void {
  const button = byId<HTMLButtonElement>('secretBtn');
  const unlocked = override !== null;
  button.classList.toggle('active', unlocked);
  button.textContent = unlocked ? `🕵 ${CHARACTERS[SECRET_ID].name}` : '🔒 Secret';
  button.title = unlocked
    ? `${CHARACTERS[SECRET_ID].name} unlocked — click to re-enter the code`
    : 'Secret character';
}

/** Validates the entered code and overrides the character on an exact match. */
function submitCode(): void {
  const input = byId<HTMLInputElement>('liziCode');
  // The secret check: trimmed, case-insensitive comparison against "moon".
  if (input.value.trim().toLowerCase() !== LIZI_SECRET_CODE) {
    showModalError('WRONG CODE — try again');
    return;
  }
  override = SECRET_ID; // session-only: memory flag, never written to storage
  reflectButton();
  closeModal();
}

/**
 * Wires the discreet "Secret" button + the unlock modal. Called once at startup.
 * The session always begins locked — no stored state is ever read.
 */
export function initSecretCharacter(): void {
  byId('secretBtn').addEventListener('click', openModal);
  byId('liziSubmit').addEventListener('click', submitCode);
  byId('liziCancel').addEventListener('click', closeModal);
  byId<HTMLInputElement>('liziCode').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitCode();
  });
  byId('liziModal').addEventListener('click', (event) => {
    if (event.target === byId('liziModal')) closeModal(); // click the backdrop
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !byId('liziModal').hidden) closeModal();
  });

  reflectButton();
}
