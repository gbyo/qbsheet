import { RefObject, useEffect, useRef, useState } from 'react';
import BrandLogo from '../../BrandLogo';
import { prefersReducedMotion } from '../LineupMotion';
import { advanceDvd } from './dvdPhysics';

export default function DvdOverlay({
  origin,
  onClose,
  onCorner,
}: {
  origin: RefObject<HTMLButtonElement>;
  onClose: () => void;
  onCorner: () => void;
}) {
  const logo = useRef<HTMLButtonElement>(null);
  const pointerOver = useRef(false);
  const [corner, setCorner] = useState(false);
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(prefersReducedMotion());
    query?.addEventListener('change', change);
    return () => query?.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const element = logo.current;
    if (!element) return;
    const start = origin.current?.getBoundingClientRect();
    let position = { x: start?.left ?? 16, y: start?.top ?? 16, vx: 73, vy: 47 };
    let width = 0;
    let height = 0;
    let frame = 0;
    let previous: number | null = null;
    let hue = 210;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const draw = () => {
      element.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
    };
    const resize = () => {
      width = Math.max(0, window.innerWidth - element.offsetWidth - 8);
      height = Math.max(0, window.innerHeight - element.offsetHeight - 8);
      position.x = Math.min(width, position.x);
      position.y = Math.min(height, position.y);
      draw();
    };
    const tick = (now: number) => {
      if (pointerOver.current) {
        previous = now;
        frame = requestAnimationFrame(tick);
        return;
      }
      const next = advanceDvd(position, width, height, previous === null ? 0 : (now - previous) / 1000);
      previous = now;
      position = next.position;
      if (next.collisions) {
        hue = (hue + 67) % 360;
        element.style.setProperty('--dvd-hue', String(hue));
      }
      if (next.corner) {
        setCorner(true);
        onCorner();
        clearTimeout(timer);
        timer = setTimeout(() => setCorner(false), 1000);
      }
      draw();
      frame = requestAnimationFrame(tick);
    };
    const visibility = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      setCorner(false);
      previous = null;
      if (!document.hidden && !reduced) frame = requestAnimationFrame(tick);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
      onClose();
      // Leave an input's own Escape behavior alone.
    };
    resize();
    visibility();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('keydown', escape);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('keydown', escape);
    };
  }, [onClose, onCorner, origin, reduced]);
  return (
    <div className="dvd-overlay" data-reduced-motion={reduced}>
      <button
        type="button"
        ref={logo}
        className={`dvd-logo${corner ? ' is-corner' : ''}`}
        aria-label="Exit DVD mode"
        title="Exit DVD mode (Escape)"
        tabIndex={-1}
        onPointerDown={(event) => event.preventDefault()}
        onPointerEnter={() => {
          pointerOver.current = true;
        }}
        onPointerLeave={() => {
          pointerOver.current = false;
        }}
        onClick={onClose}
      >
        <BrandLogo className="dvd-wordmark" />
        {corner && (
          <span className="dvd-corner" aria-hidden="true">
            CORNER!
          </span>
        )}
        {reduced && (
          <span className="dvd-static-label" aria-hidden="true">
            DVD · Esc to return
          </span>
        )}
      </button>
    </div>
  );
}
