/**
 * Input manager — keyboard-only directional combat (Boxhead style).
 *
 * Everything is matched on `event.code` (physical key positions), so keyboard
 * layout (QWERTZ/AZERTY/etc.) can never create conflicts between the two
 * players sharing one keyboard.
 *
 * single: move/aim = Arrows or WASD (8-way), shoot = Space,
 *         weapons = digits 1–6 (direct slot) or Q/E (cycle)
 * duo:    P1 = Arrows, shoot Slash / Enter, cycle ',' '.'
 *         P2 = WASD,   shoot Space,        cycle 'Q' 'E'
 * All players aim in their movement/facing direction — no mouse.
 */
export type GameMode = 'single' | 'duo';

const GAME_CODES = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'Space', 'Slash', 'Enter', 'Comma', 'Period', 'KeyQ', 'KeyE',
  'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4',
  'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
]);

export interface MoveAxes {
  dx: number;
  dz: number;
}

export class InputManager {
  readonly mode: GameMode;
  private readonly keys = new Set<string>();
  private readonly pendingCycle = [0, 0];
  private pendingSlot: number | null = null;

  constructor(mode: GameMode) {
    this.mode = mode;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.keys.clear();
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (GAME_CODES.has(event.code)) event.preventDefault();
    if (event.repeat) return;
    this.keys.add(event.code);

    if (this.mode === 'single') {
      if (event.code.startsWith('Digit')) {
        const slot = Number(event.code.slice(5));
        this.pendingSlot = slot;
      } else if (event.code === 'KeyQ') {
        this.pendingCycle[0] -= 1;
      } else if (event.code === 'KeyE') {
        this.pendingCycle[0] += 1;
      }
    } else {
      // duo: P1 cycles with ',' '.' ; P2 with 'Q' 'E'. Movement/shoot codes are
      // read per-player below, so both players can act on the same frame.
      if (event.code === 'Comma') this.pendingCycle[0] -= 1;
      else if (event.code === 'Period') this.pendingCycle[0] += 1;
      else if (event.code === 'KeyQ') this.pendingCycle[1] -= 1;
      else if (event.code === 'KeyE') this.pendingCycle[1] += 1;
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private onBlur = (): void => {
    this.keys.clear();
  };

  /** Normalized movement intent for player 0 (single) or the duo pair. */
  moveAxes(playerIndex: number): MoveAxes {
    let dx = 0;
    let dz = 0;
    if (this.mode === 'single') {
      if (this.keys.has('ArrowLeft') || this.keys.has('KeyA')) dx -= 1;
      if (this.keys.has('ArrowRight') || this.keys.has('KeyD')) dx += 1;
      if (this.keys.has('ArrowUp') || this.keys.has('KeyW')) dz -= 1;
      if (this.keys.has('ArrowDown') || this.keys.has('KeyS')) dz += 1;
    } else if (playerIndex === 0) {
      if (this.keys.has('ArrowLeft')) dx -= 1;
      if (this.keys.has('ArrowRight')) dx += 1;
      if (this.keys.has('ArrowUp')) dz -= 1;
      if (this.keys.has('ArrowDown')) dz += 1;
    } else {
      if (this.keys.has('KeyA')) dx -= 1;
      if (this.keys.has('KeyD')) dx += 1;
      if (this.keys.has('KeyW')) dz -= 1;
      if (this.keys.has('KeyS')) dz += 1;
    }
    return { dx, dz };
  }

  /**
   * Whether the shoot key is held for a player (fires along their facing).
   *
   * single → Space; duo P1 → Slash or Enter; duo P2 → Space. The two duo
   * players never share a shoot key, so both can fire on the same frame.
   */
  shooting(playerIndex: number): boolean {
    if (this.mode === 'single') return this.keys.has('Space');
    if (playerIndex === 0) {
      return this.keys.has('Slash') || this.keys.has('Enter');
    }
    return this.keys.has('Space');
  }

  /** Pending weapon-cycle delta for a player (consumed on read). */
  takeCycle(playerIndex: number): number {
    const delta = this.pendingCycle[playerIndex];
    this.pendingCycle[playerIndex] = 0;
    return delta;
  }

  /** Direct digit slot pick (single player; consumed on read). */
  takeSlot(): number | null {
    const slot = this.pendingSlot;
    this.pendingSlot = null;
    return slot;
  }
}
