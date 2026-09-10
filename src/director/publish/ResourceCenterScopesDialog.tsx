import { useMemo, useState } from 'react';
import type { DirectorState } from '../domain';
import { Button, Callout, Checkbox, CheckboxGroup, Dialog, DialogSection, RadioGroup } from '../components';
import { saveOrDownloadBytes } from '../reports/downloads';
import {
  buildCanonicalResourceCenterScopeSets,
  resourceCenterPresetScopeKeys,
  resourceCenterScopes,
  type ResourceCenterPreset,
} from '../reports/resourceCenterScopes';
import { errorNotice, warningNotice, type AnnounceInput } from '../notices';

const presetOptions: Array<{ value: ResourceCenterPreset; label: string; hint: string }> = [
  {
    value: 'recommended',
    label: 'Recommended for Resource Center',
    hint: 'Every phase plus combined, per current ACF guidance.',
  },
  { value: 'phases-only', label: 'Selected phases only', hint: 'Phase sets without the combined set.' },
  {
    value: 'combined-only',
    label: 'Combined only',
    hint: 'One tournament-wide set. Prefer the recommended preset when phases differ.',
  },
];

/**
 * Multi-phase Resource Center export: preset picker, per-set selection, and
 * pre-save diagnostics. The export itself is a pure function of Director
 * state, so the dialog previews the exact scope labels, set/file counts,
 * warnings, and blocking errors before anything is written.
 */
export function ResourceCenterScopesDialog({
  state,
  onAnnounce,
  onClose,
}: {
  state: DirectorState;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const scopes = useMemo(() => resourceCenterScopes(state), [state]);
  const [preset, setPreset] = useState<ResourceCenterPreset>('recommended');
  const [selected, setSelected] = useState<string[]>(() =>
    resourceCenterPresetScopeKeys(state, 'recommended'),
  );
  const generatedAt = useMemo(() => new Date().toISOString(), []);
  const preview = useMemo(
    () => buildCanonicalResourceCenterScopeSets(state, selected, generatedAt),
    [state, selected, generatedAt],
  );
  const [saving, setSaving] = useState(false);

  const applyPreset = (next: ResourceCenterPreset): void => {
    setPreset(next);
    setSelected(resourceCenterPresetScopeKeys(state, next));
  };

  const toggleScope = (key: string, checked: boolean): void => {
    setSelected((current) => {
      const next = checked ? [...current, key] : current.filter((entry) => entry !== key);
      return scopes.filter((scope) => next.includes(scope.key)).map((scope) => scope.key);
    });
  };

  const download = async (): Promise<void> => {
    if (preview.errors.length > 0 || preview.sets.length === 0) {
      onAnnounce(
        errorNotice(
          `Resource Center reports could not be exported. ${preview.errors.join(' ') || 'Select at least one report set.'}`,
        ),
      );
      return;
    }
    setSaving(true);
    try {
      await saveOrDownloadBytes(
        preview.bytes,
        preview.fileName,
        'application/zip',
        onAnnounce,
        `Resource Center reports exported (${preview.totalSets} sets, ${preview.totalFiles} files)`,
        'Resource Center reports save cancelled.',
      );
      for (const message of preview.warnings) onAnnounce(warningNotice(message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="Resource Center reports export"
      description="One upload-ready HTML set per phase plus a combined set, all from the canonical snapshot. Upload each set's files to its own stat report on hsquizbowl.org/db."
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
            disabled={selected.length === 0 || preview.errors.length > 0 || saving}
            onClick={() => void download()}
          >
            {saving ? 'Saving…' : `Download ${preview.fileName}`}
          </Button>
        </div>
      }
    >
      <DialogSection title="Preset">
        <RadioGroup<ResourceCenterPreset>
          legend="Scope preset"
          value={preset}
          options={presetOptions}
          onChange={applyPreset}
        />
      </DialogSection>
      <DialogSection title="Report sets">
        <CheckboxGroup
          legend="Included sets"
          hint="Each set produces standings, individuals, scoreboard, team detail, player detail, round report, and the stat-key companion."
        >
          {scopes.map((scope) => (
            <Checkbox
              key={scope.key}
              checked={selected.includes(scope.key)}
              onChange={(checked) => toggleScope(scope.key, checked)}
              label={`${scope.label} · ${scope.detail}`}
              hint={
                scope.divisions.length > 1
                  ? `Divisions: ${scope.divisions.join(', ')}`
                  : scope.kind === 'combined'
                    ? 'Entire tournament, each accepted game once'
                    : scope.baseName
              }
              ariaLabel={`Include ${scope.label}`}
            />
          ))}
        </CheckboxGroup>
      </DialogSection>
      <DialogSection title="Contents">
        <p className="director-text-meta">
          {preview.totalSets} report set{preview.totalSets === 1 ? '' : 's'} · {preview.totalFiles} files ·{' '}
          {preview.fileName}
        </p>
        {preview.sets.map((set) => (
          <p key={set.scopeKey} className="director-text-meta">
            {set.scopeLabel} · {set.gameCount} game{set.gameCount === 1 ? '' : 's'} · {set.teamCount} team
            {set.teamCount === 1 ? '' : 's'} · {set.baseName}
            {set.divisions.length > 1 ? ` · divisions: ${set.divisions.join(', ')}` : ''}
          </p>
        ))}
        {preview.warnings.map((message) => (
          <Callout key={message} tone="warning" title="Export warning">
            {message}
          </Callout>
        ))}
        {preview.errors.length > 0 && (
          <>
            <Callout tone="danger" title="Export blocked">
              This selection cannot be exported until the problems below are fixed. No file was written.
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
