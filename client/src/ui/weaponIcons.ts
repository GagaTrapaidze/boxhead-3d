/**
 * Tiny inline SVG silhouettes for the HUD weapon slots, one per `WeaponId`.
 *
 * They are deliberately simple filled shapes (viewBox 40×24) so the HUD card
 * can render a recognizable weapon at a glance without shipping image assets.
 * The fill colour is inherited from CSS (`fill: currentColor` is set on the
 * svg via the `.wicon svg` rule), letting each player card tint its own icon.
 */

const ICONS: Record<number, string> = {
  // 0 — Pistol: short frame + grip.
  0: '<rect x="7" y="9" width="23" height="5" rx="1"/><rect x="11" y="14" width="6" height="8" rx="1"/>',
  // 1 — Shotgun: long double barrel + stock.
  1: '<rect x="4" y="8" width="32" height="4" rx="1"/><rect x="4" y="12" width="32" height="3" rx="1"/><rect x="2" y="15" width="8" height="4" rx="1"/>',
  // 2 — Uzi: stubby body + magazine.
  2: '<rect x="6" y="8" width="22" height="6" rx="1"/><rect x="14" y="14" width="6" height="9" rx="1"/><rect x="26" y="9" width="7" height="3" rx="1"/>',
  // 3 — Grenade: body + fuse.
  3: '<ellipse cx="20" cy="14" rx="7" ry="8"/><rect x="19" y="2" width="2" height="5" rx="1"/>',
  // 4 — Explosive barrel: drum.
  4: '<rect x="12" y="3" width="16" height="18" rx="5"/><rect x="14" y="2" width="12" height="2" rx="1"/>',
  // 5 — Mine: disc + trigger.
  5: '<ellipse cx="20" cy="14" rx="11" ry="6"/><rect x="18" y="4" width="4" height="3" rx="1"/>',
  // 6 — Rocket launcher: tube + warhead.
  6: '<rect x="6" y="10" width="25" height="5" rx="1"/><path d="M31 9.5 L38 12.5 L31 15.5 Z"/>',
  // 7 — Railgun: twin rails + muzzle.
  7: '<rect x="4" y="9" width="31" height="3" rx="1"/><rect x="4" y="13" width="31" height="3" rx="1"/><rect x="33" y="8" width="4" height="9" rx="1"/>',
  // 8 — Wooden crate: box with cross planks.
  8: '<rect x="7" y="4" width="26" height="17" rx="1"/><path d="M7 4 L33 21 M33 4 L7 21" fill="none" stroke="currentColor" stroke-width="2.5"/>',
};

/** Returns the SVG markup for a weapon id (falls back to the pistol). */
export function weaponIconSvg(weaponId: number): string {
  const body = ICONS[weaponId] ?? ICONS[0];
  return `<svg viewBox="0 0 40 24" aria-hidden="true" focusable="false">${body}</svg>`;
}
