/**
 * One canvas, two coordinate systems, and the rule that the game never sees the second one.
 *
 * # Why the world is a fixed size
 *
 * Because gravity is measured in pixels and a dialog is not a fixed number of them. If the game's
 * coordinates were the canvas's own, a bird would fall faster on a Chromebook than on a phone, the
 * gap between two obstacles would be passable on one and not the other, and a scorekeeper resizing a
 * window mid-flight would change the physics under their hands. So each game declares a world it is
 * designed in — 320 by 440, say — plays entirely in those units, and this file scales the drawing to
 * whatever the layout gave it. The stylesheet holds the box to the world's aspect ratio, so the
 * scale is the same in both directions and nothing is stretched.
 *
 * # Why the backing store is resized on every frame
 *
 * It is only *written* when it is wrong, which is the frame after a resize, a rotation, or a window
 * moving to a display with a different pixel ratio. Reading the box is cheap; guessing about it and
 * being wrong is a game drawn at half resolution on the one device — a school Chromebook plugged
 * into a projector — where somebody else is watching.
 */

export interface IArcadeWorld {
  width: number;
  height: number;
}

/**
 * The context for this frame, sized and scaled, or null if this browser has no 2D canvas.
 *
 * The transform is set rather than accumulated, so a frame that threw halfway through the previous
 * one still starts from a known state.
 */
export function prepareFrame(
  canvas: HTMLCanvasElement,
  world: IArcadeWorld,
): CanvasRenderingContext2D | null {
  const context = canvas.getContext('2d');
  if (context === null) return null;

  const box = canvas.getBoundingClientRect();
  // A layout that has not happened yet — jsdom, or a canvas in a dialog that has not been painted.
  // The world's own size is the honest answer, and it keeps the scale at 1.
  const cssWidth = box.width > 0 ? box.width : world.width;
  const cssHeight = box.height > 0 ? box.height : world.height;
  const ratio = typeof window === 'undefined' ? 1 : (window.devicePixelRatio ?? 1);

  const pixelWidth = Math.max(1, Math.round(cssWidth * ratio));
  const pixelHeight = Math.max(1, Math.round(cssHeight * ratio));
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

  context.setTransform(pixelWidth / world.width, 0, 0, pixelHeight / world.height, 0, 0);
  return context;
}

/** A rounded rectangle, which is every panel either game draws. */
export function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const limit = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + limit, y);
  context.lineTo(x + width - limit, y);
  context.quadraticCurveTo(x + width, y, x + width, y + limit);
  context.lineTo(x + width, y + height - limit);
  context.quadraticCurveTo(x + width, y + height, x + width - limit, y + height);
  context.lineTo(x + limit, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - limit);
  context.lineTo(x, y + limit);
  context.quadraticCurveTo(x, y, x + limit, y);
  context.closePath();
}
