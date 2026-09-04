export interface DvdPosition {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Time-of-impact integration. A corner means both walls arrive within 2 ms, not merely one frame. */
export function advanceDvd(position: DvdPosition, width: number, height: number, seconds: number) {
  let { x, y, vx, vy } = position;
  x = Math.max(0, Math.min(width, x));
  y = Math.max(0, Math.min(height, y));
  let remaining = Math.min(Math.max(seconds, 0), 0.05);
  let collisions = 0;
  let corner = false;
  if (width <= 0 || height <= 0) return { position: { x: 0, y: 0, vx, vy }, collisions, corner };
  while (remaining > 0) {
    const tx = vx > 0 ? (width - x) / vx : vx < 0 ? -x / vx : Infinity;
    const ty = vy > 0 ? (height - y) / vy : vy < 0 ? -y / vy : Infinity;
    const impact = Math.min(tx, ty);
    if (impact > remaining) {
      x += vx * remaining;
      y += vy * remaining;
      break;
    }
    x += vx * impact;
    y += vy * impact;
    remaining -= impact;
    const hitCorner = Math.abs(tx - ty) <= 0.002;
    if (tx <= ty || hitCorner) {
      x = vx > 0 ? width : 0;
      vx = -vx;
    }
    if (ty <= tx || hitCorner) {
      y = vy > 0 ? height : 0;
      vy = -vy;
    }
    collisions += 1;
    corner ||= hitCorner;
    // Degenerate, subpixel viewports should never spin in the animation loop.
    if (collisions >= 4) break;
  }
  return { position: { x, y, vx, vy }, collisions, corner };
}
