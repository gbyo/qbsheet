import { useState } from 'react';
import BrandLogo from '../BrandLogo';
import ManualGameEditor from '../app/ManualGameEditor';
import {
  clearManualGameDraft,
  emptyInput,
  hasManualInput,
  readManualGamePresets,
} from '../app/ManualGameDraft';
import { useManualGameDraft } from '../app/useManualGameDraft';
import { PortableGameSummary } from '../app/PortableGameReview';
import { encodePortableGameSetup, PortableSetupEncodeResult } from '../game/PortableGameSetup';

export const gamePackageCreatorDraftKey = 'qbsheet.game-package-creator-draft.v1';

export default function GamePackageCreator() {
  const { input, setInput, draftSaveState } = useManualGameDraft(gamePackageCreatorDraftKey);
  const [presets] = useState(readManualGamePresets);
  const [generated, setGenerated] = useState<Extract<PortableSetupEncodeResult, { ok: true }> | null>(null);
  const [error, setError] = useState('');
  return (
    <main className="shell manual-shell game-package-creator">
      <header className="shell-header">
        <BrandLogo />
        <h1 className="shell-title">Game package creator</h1>
        <p className="shell-subtitle">
          Create a portable QR code with teams, players, and game settings. It does not connect to tournament
          control. Scan it in QBSheet, review the setup, then start or edit the game.
        </p>
      </header>
      {generated ? (
        <section className="game-package-output" aria-label="Generated game package">
          <img
            className="game-package-qr"
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(generated.svg)}`}
            alt="Game setup QR code"
          />
          <p>
            QR version {generated.version} · {generated.moduleCount}×{generated.moduleCount} modules · error
            correction M
          </p>
          <PortableGameSummary input={input} />
          <div className="shell-actions package-controls">
            <button type="button" className="shell-button" onClick={() => window.print()}>
              Print
            </button>
            <a
              className="shell-button"
              href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(generated.svg)}`}
              download="qbsheet-game-setup.svg"
            >
              Download SVG
            </a>
            <button type="button" className="shell-button" onClick={() => setGenerated(null)}>
              Edit setup
            </button>
          </div>
        </section>
      ) : (
        <>
          <ManualGameEditor
            input={input}
            setInput={setInput}
            presets={presets}
            draftSaveState={draftSaveState}
            primaryLabel="Generate package"
            pendingLabel="Generating…"
            submitErrorMessage="This package could not be generated. Your setup is still here."
            onSubmit={(submitted) => {
              const encoded = encodePortableGameSetup(submitted);
              setError(encoded.ok ? '' : encoded.message);
              setGenerated(encoded.ok ? encoded : null);
            }}
            onCancel={() => {
              if (hasManualInput(input) && !window.confirm('Discard this game setup?')) return;
              clearManualGameDraft(gamePackageCreatorDraftKey);
              setInput(emptyInput());
              setError('');
            }}
          />
          {error && (
            <p className="shell-warning" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </main>
  );
}
