import { useCallback, useEffect, useRef, useState } from 'react';
import { buildLabel } from '../pwa/BuildVersion';
import {
  discoverSecret,
  loadRainbow,
  loadSecrets,
  logoClickSequence,
  rainbowChangeEvent,
  saveRainbow,
} from '../scorer/secrets/secretState';
import { logoHoldDurationMs } from '../scorer/secrets/useLogoSecret';
import NativeDialog from './NativeDialog';
import './homepage-secrets.css';

const homepageLogoSelector = '.welcome-shell .shell-brand-logo';

function homepageLogoFromTarget(target: EventTarget | null): SVGSVGElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest(homepageLogoSelector) as SVGSVGElement | null;
}

/**
 * The homepage copy of the scorer's logo secret.
 *
 * The welcome screen intentionally keeps its wordmark as presentation-only markup, so this listens
 * at the document boundary instead of turning the product mark into ordinary navigation. Only the
 * logo inside `.welcome-shell` participates; identical marks in recovery, room setup, Director, and
 * the scorer retain their own behaviour.
 */
export default function HomepageSecrets() {
  const [rainbow, setRainbow] = useState(loadRainbow);
  const [open, setOpen] = useState(false);
  const [discoveries, setDiscoveries] = useState(loadSecrets);
  const clicks = useRef<number[]>([]);
  const holdTimer = useRef<number | null>(null);
  const popTimer = useRef<number | null>(null);

  const clearHold = useCallback(() => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }, []);

  const popLogo = useCallback(() => {
    const logo = document.querySelector<SVGSVGElement>(homepageLogoSelector);
    if (!logo) return;
    logo.dataset.homeSecretPop = 'true';
    if (popTimer.current !== null) window.clearTimeout(popTimer.current);
    popTimer.current = window.setTimeout(() => {
      delete logo.dataset.homeSecretPop;
      popTimer.current = null;
    }, 500);
  }, []);

  const unlock = useCallback(() => {
    clicks.current = [];
    saveRainbow();
    setRainbow(true);
    setDiscoveries((current) => discoverSecret('rainbow-logo', current));
    setOpen(true);
    popLogo();
  }, [popLogo]);

  useEffect(() => {
    const onRainbowChange = () => setRainbow(loadRainbow());
    window.addEventListener(rainbowChangeEvent, onRainbowChange);
    return () => window.removeEventListener(rainbowChangeEvent, onRainbowChange);
  }, []);

  useEffect(() => {
    const syncLogo = () => {
      const logo = document.querySelector<SVGSVGElement>(homepageLogoSelector);
      if (!logo) return;
      if (rainbow) logo.dataset.homeRainbow = 'true';
      else delete logo.dataset.homeRainbow;
    };

    syncLogo();
    if (!rainbow) return undefined;

    const root = document.getElementById('root');
    if (!root) return undefined;
    const observer = new MutationObserver(syncLogo);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      const logo = document.querySelector<SVGSVGElement>(homepageLogoSelector);
      if (logo) delete logo.dataset.homeRainbow;
    };
  }, [rainbow]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!homepageLogoFromTarget(event.target)) return;
      clearHold();
      holdTimer.current = window.setTimeout(unlock, logoHoldDurationMs);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (holdTimer.current === null) return;
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (!homepageLogoFromTarget(target)) clearHold();
    };
    const onPointerEnd = () => clearHold();
    const onClick = (event: MouseEvent) => {
      if (!homepageLogoFromTarget(event.target)) return;
      const next = logoClickSequence(clicks.current, Date.now());
      clicks.current = next.clicks;
      if (next.unlocked) unlock();
    };
    const onContextMenu = (event: MouseEvent) => {
      if (homepageLogoFromTarget(event.target)) event.preventDefault();
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerEnd);
    document.addEventListener('pointercancel', onPointerEnd);
    document.addEventListener('click', onClick);
    document.addEventListener('contextmenu', onContextMenu);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerEnd);
      document.removeEventListener('pointercancel', onPointerEnd);
      document.removeEventListener('click', onClick);
      document.removeEventListener('contextmenu', onContextMenu);
      clearHold();
      if (popTimer.current !== null) window.clearTimeout(popTimer.current);
      popTimer.current = null;
    };
  }, [clearHold, unlock]);

  return (
    <>
      <svg className="homepage-secret-defs" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient
            id="homepage-secret-rainbow"
            x1="0"
            x2="626"
            y1="0"
            y2="155"
            gradientUnits="userSpaceOnUse"
          >
            <stop className="homepage-secret-rainbow-stop" offset="0%" />
            <stop className="homepage-secret-rainbow-stop" offset="50%" />
            <stop className="homepage-secret-rainbow-stop" offset="100%" />
          </linearGradient>
        </defs>
      </svg>
      {open && (
        <NativeDialog title="You found it." onClose={() => setOpen(false)}>
          <p className="homepage-secret-note">
            A little curiosity goes a long way. So does a good scorekeeper.
          </p>
          <dl className="homepage-secret-stats">
            <div>
              <dt>Secrets discovered on this device</dt>
              <dd>{discoveries.length} / ?</dd>
            </div>
            <div>
              <dt>QBSheet version</dt>
              <dd>{buildLabel()}</dd>
            </div>
          </dl>
        </NativeDialog>
      )}
    </>
  );
}
