import { useCallback, useEffect, useRef, useState } from 'react';
import useLogoSecret from './useLogoSecret';
import { discoverSecret, loadSecrets, SecretCommand, SecretId } from './secretState';

export default function useScorerSecrets() {
  const [surface, setSurface] = useState<Exclude<SecretCommand, 'dvd'> | 'commands' | null>(null);
  const [dvd, setDvd] = useState(false);
  const [discoveries, setDiscoveries] = useState(loadSecrets);
  const [microReaction, setMicroReaction] = useState(0);
  const interactionCount = useRef(0);
  const known = useRef(discoveries);
  const origin = useRef<HTMLButtonElement>(null);
  const discover = useCallback((id: SecretId) => {
    known.current = discoverSecret(id, known.current);
    setDiscoveries(known.current);
  }, []);
  const close = useCallback(() => setSurface(null), []);
  const closeDvd = useCallback(() => setDvd(false), []);
  const corner = useCallback(() => discover('dvd-corner'), [discover]);
  const unlock = useCallback(() => {
    discover('rainbow-logo');
    setDvd(false);
    setSurface('stats');
  }, [discover]);
  const logo = useLogoSecret(unlock);
  useEffect(() => {
    if (microReaction === 0) return;
    const timer = window.setTimeout(() => setMicroReaction(0), 420);
    return () => window.clearTimeout(timer);
  }, [microReaction]);
  const interaction = useCallback(() => {
    if (document.hidden || document.activeElement?.matches('input, textarea, [contenteditable="true"]'))
      return;
    interactionCount.current += 1;
    // Evaluated only after accepted scorer actions. Roughly twice per long match, never on a timer.
    if (interactionCount.current % 47 === 0) setMicroReaction(interactionCount.current);
  }, []);
  const openCommands = useCallback(() => {
    setDvd(false);
    setSurface('commands');
  }, []);
  const command = useCallback(
    (value: SecretCommand) => {
      setSurface(null);
      if (value === 'dvd') {
        discover('dvd');
        setDvd(true);
      } else {
        if (value === 'snake' || value === 'qbbird') discover(`${value}-command`);
        setSurface(value);
      }
    },
    [discover],
  );
  return {
    surface,
    dvd,
    discoveries,
    origin,
    logo: { ...logo, reaction: logo.reaction + microReaction, micro: microReaction > 0 },
    close,
    closeDvd,
    corner,
    openCommands,
    command,
    interaction,
  };
}
