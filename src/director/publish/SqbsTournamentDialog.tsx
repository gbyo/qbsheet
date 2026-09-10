import { useMemo, useState } from 'react';
import type { DirectorState } from '../domain';
import { Button, Callout, Dialog, DialogSection, Select, type SelectOption } from '../components';
import { exportSqbsTournament, sqbsTournamentFileName, sqbsTournamentScopes } from '../format/interchange';
import { saveOrDownloadBytes } from '../reports/downloads';
import { errorNotice, warningNotice, type AnnounceInput } from '../notices';

/**
 * Full SQBS tournament export: scope picker, pre-save diagnostics, download.
 *
 * The export itself is a pure function of Director state, so the dialog runs
 * it for the selected scope and previews the exact scope label, team/game
 * counts, warnings, and blocking errors before anything is written. A scope
 * with a blocking error cannot be downloaded; its errors are announced as an
 * error notice instead of a success message.
 */
export function SqbsTournamentDialog({
  state,
  onAnnounce,
  onClose,
}: {
  state: DirectorState;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const scopes = useMemo(() => sqbsTournamentScopes(state), [state]);
  const [scopeKey, setScopeKey] = useState(scopes[0]?.key ?? 'entire');
  const selected = scopes.find((option) => option.key === scopeKey) ?? scopes[0];
  const preview = useMemo(() => exportSqbsTournament(state, selected?.scope ?? {}), [state, selected]);
  const fileName = sqbsTournamentFileName(state, selected?.scope ?? {});
  const [saving, setSaving] = useState(false);

  const scopeOptions: SelectOption<string>[] = scopes.map((option) => ({
    value: option.key,
    label: option.label,
    detail: option.detail,
  }));

  const download = async (): Promise<void> => {
    if (!preview.ok) {
      onAnnounce(errorNotice(`SQBS tournament could not be exported. ${preview.errors.join(' ')}`));
      return;
    }
    setSaving(true);
    try {
      await saveOrDownloadBytes(
        new TextEncoder().encode(preview.text),
        fileName,
        'text/plain;charset=utf-8',
        onAnnounce,
        `SQBS tournament exported (${preview.scopeLabel})`,
        'SQBS tournament save cancelled.',
      );
      for (const message of preview.warnings) onAnnounce(warningNotice(message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="SQBS tournament export"
      description="Full tournament data file for SQBS: teams, players, games, scores, and detail stats. This is not the roster-only file."
      size="lg"
      onClose={onClose}
      footer={
        <div className="director-actions">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="download"
            disabled={!preview.ok || saving}
            onClick={() => void download()}
          >
            {saving ? 'Saving…' : `Download ${fileName}`}
          </Button>
        </div>
      }
    >
      {scopes.length > 1 && (
        <DialogSection title="Scope">
          <p className="director-text-meta">
            SQBS divisions describe one stage. Exporting the entire multi-stage tournament drops pool
            assignments; export each stage separately to keep them.
          </p>
          <Select
            ariaLabel="Export scope"
            value={selected?.key ?? 'entire'}
            options={scopeOptions}
            onChange={setScopeKey}
          />
        </DialogSection>
      )}
      <DialogSection title="Contents">
        <p className="director-text-meta">
          {preview.scopeLabel} · {preview.teamCount} teams · {preview.gameCount} games · {fileName}
        </p>
        {preview.warnings.map((message) => (
          <Callout key={message} tone="warning" title="Export warning">
            {message}
          </Callout>
        ))}
        {!preview.ok && (
          <>
            <Callout tone="danger" title="Export blocked">
              This scope cannot be exported until the problems below are fixed. No file was written.
            </Callout>
            {preview.errors.map((message) => (
              <Callout key={message} tone="danger">
                {message}
              </Callout>
            ))}
          </>
        )}
      </DialogSection>
    </Dialog>
  );
}
