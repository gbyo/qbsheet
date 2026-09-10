import { useMemo, useState } from 'react';
import type { DirectorState } from '../domain';
import type { SectionId } from '../app/navigation';
import {
  Button,
  Callout,
  Checkbox,
  CheckboxGroup,
  DataTable,
  Dialog,
  DialogSection,
  Field,
  RadioGroup,
  TextInput,
} from '../components';
import { isNativeDirector } from '../platform/native';
import { saveOrDownloadBytes } from '../reports/downloads';
import {
  buildCanonicalResourceCenterScopeSets,
  resourceCenterPresetScopeKeys,
  resourceCenterScopes,
  type ResourceCenterPreset,
} from '../reports/resourceCenterScopes';
import { errorNotice, warningNotice, type AnnounceInput } from '../notices';
import {
  HSQB_MANUAL_UPLOAD_STEPS,
  HSQB_RESOURCE_CENTER_URL,
  hsqbFixDestination,
  hsqbSetStatus,
  hsqbUploadFieldMapping,
} from './hsqbPrepareWorkflow';

const presetOptions: Array<{ value: ResourceCenterPreset; label: string; hint: string }> = [
  {
    value: 'recommended',
    label: 'Recommended for Resource Center',
    hint: 'Played phases plus combined; future empty phases stay unselected.',
  },
  { value: 'phases-only', label: 'Selected phases only', hint: 'Phase sets without the combined set.' },
  {
    value: 'combined-only',
    label: 'Combined only',
    hint: 'One tournament-wide set. Prefer the recommended preset when phases differ.',
  },
];

/**
 * "Prepare for HSQuizbowl" publishing workflow (issue #766, epic #760).
 *
 * One dialog ties the merged #761–#764/#767 pieces into an operator flow a
 * director can run under time pressure: choose report sets, review preflight
 * (ready-to-save / warnings / fix-required, each blocker linking at its fix
 * where a fix exists), save the files, and hand off to the Resource Center
 * upload form with a per-set field mapping. Generation here is preparation
 * only — nothing in this dialog marks a report published or uploaded.
 */
export function PrepareHsqbDialog({
  state,
  onAnnounce,
  onClose,
  onNavigate,
}: {
  state: DirectorState;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
  onNavigate?: (section: SectionId) => void;
}) {
  const scopes = useMemo(() => resourceCenterScopes(state), [state]);
  const multiScope = scopes.length > 1;
  const [preset, setPreset] = useState<ResourceCenterPreset>('recommended');
  const [selected, setSelected] = useState<string[]>(() =>
    resourceCenterPresetScopeKeys(state, 'recommended'),
  );
  const [labels, setLabels] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(scopes.map((scope) => [scope.key, scope.label] as const)),
  );
  // Package timestamp, fixed when the dialog opens. A correction made while the
  // dialog is open refreshes the numbers live (the preview follows `state`);
  // the content-derived revision below is what distinguishes the corrected
  // package from a stale one within the session.
  const [generatedAt] = useState(() => new Date().toISOString());
  const preview = useMemo(
    () => buildCanonicalResourceCenterScopeSets(state, selected, generatedAt, undefined, labels),
    [state, selected, generatedAt, labels],
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ fileName: string; revision: string } | null>(null);
  const native = isNativeDirector();

  const blocked = preview.errors.length > 0 || preview.sets.length === 0;
  const warningCount = preview.warnings.length;
  // Package-level warnings (duplicate report names) live only on the whole
  // operation, not on any one set — render them alongside the per-set lists
  // so they are visible before the save and stay visible after it.
  const perSetWarningMessages = useMemo(
    () =>
      new Set(preview.sets.flatMap((set) => set.warnings.map((warning) => `${set.scopeLabel}: ${warning}`))),
    [preview],
  );
  const packageWarnings = preview.warnings.filter((warning) => !perSetWarningMessages.has(warning));
  const duplicateKeys = useMemo(() => {
    const seen = new Map<string, string>();
    const dupes = new Set<string>();
    for (const set of preview.sets) {
      const folded = set.scopeLabel.trim().toLocaleLowerCase();
      if (seen.has(folded)) dupes.add(set.scopeKey);
      else seen.set(folded, set.scopeKey);
    }
    return dupes;
  }, [preview]);

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

  const save = async (): Promise<void> => {
    if (blocked) {
      onAnnounce(
        errorNotice(
          `Resource Center reports could not be saved. ${preview.errors.join(' ') || 'Select at least one report set.'}`,
        ),
      );
      return;
    }
    setSaving(true);
    try {
      const setWord = preview.totalSets === 1 ? 'set' : 'sets';
      const outcome = await saveOrDownloadBytes(
        preview.bytes,
        preview.fileName,
        'application/zip',
        onAnnounce,
        `Resource Center reports saved (${preview.totalSets} ${setWord}, ${preview.totalFiles} files). Not yet published`,
        'Resource Center reports save cancelled.',
      );
      if (outcome.status !== 'saved') return;
      setSaved({ fileName: preview.fileName, revision: preview.revision });
      for (const message of preview.warnings) onAnnounce(warningNotice(message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="Prepare for HSQuizbowl"
      description="Check the report, save the correct upload files, and continue to the Resource Center upload page. Saving files here does not publish them."
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
            disabled={selected.length === 0 || blocked || saving}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : `${native ? 'Save' : 'Download'} ${preview.fileName}`}
          </Button>
        </div>
      }
    >
      <DialogSection title="1 · Report sets">
        {multiScope ? (
          <>
            <RadioGroup<ResourceCenterPreset>
              legend="Scope preset"
              value={preset}
              options={presetOptions}
              onChange={applyPreset}
            />
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
          </>
        ) : (
          <p className="director-text-meta">
            One report set — no configuration needed:{' '}
            {scopes[0]
              ? `${scopes[0].label} · ${scopes[0].detail} · files start with ${scopes[0].baseName}`
              : 'no tournament open'}
            .
          </p>
        )}
      </DialogSection>

      {preview.sets.length > 0 && (
        <DialogSection title="2 · Report names">
          <p className="director-text-meta">
            The display label is what each stat report is called on the Resource Center; filenames stay
            filesystem-safe automatically.
          </p>
          {preview.sets.map((set) => (
            <Field
              key={set.scopeKey}
              label={`Report name for ${set.baseName}`}
              hint={`Files start with ${set.baseName}`}
              error={
                duplicateKeys.has(set.scopeKey)
                  ? `Another set already uses the name “${set.scopeLabel}”. Rename one.`
                  : null
              }
            >
              <TextInput
                value={labels[set.scopeKey] ?? set.scopeLabel}
                onChange={(event) =>
                  setLabels((current) => ({ ...current, [set.scopeKey]: event.target.value }))
                }
              />
            </Field>
          ))}
        </DialogSection>
      )}

      <DialogSection title="3 · Preflight">
        {blocked ? (
          <Callout tone="danger" title="Not ready — fixes required">
            This selection cannot be saved until the problems below are fixed. No file was written.
          </Callout>
        ) : warningCount > 0 ? (
          <Callout tone="warning" title="Ready to save with warnings">
            {warningCount} warning{warningCount === 1 ? '' : 's'} to review before saving. Warnings do not
            block the save and stay visible afterwards. Saving is preparation — the manual upload below is
            what puts the report online.
          </Callout>
        ) : (
          <Callout tone="success" title="Ready to save">
            Preflight passed with no blockers and no warnings. Saving is preparation — the manual upload below
            is what puts the report online.
          </Callout>
        )}
        {packageWarnings.map((message) => (
          <Callout key={message} tone="warning" title="Warning">
            {message}
          </Callout>
        ))}
        {preview.sets.map((set) => {
          const status = hsqbSetStatus(set.blocking.length, set.warnings.length);
          const extraErrors = set.errors.filter(
            (message) => !set.blocking.some((entry) => entry.message === message),
          );
          return (
            <div key={set.scopeKey}>
              <p className="director-text-meta">
                <span title={set.scopeLabel}>{set.scopeLabel}</span> ·{' '}
                {status === 'blocked'
                  ? `needs fixes (${set.blocking.length + extraErrors.length})`
                  : status === 'warnings'
                    ? `ready to save with warnings (${set.warnings.length})`
                    : 'ready to save'}{' '}
                · {set.gameCount} game{set.gameCount === 1 ? '' : 's'} · {set.teamCount} team
                {set.teamCount === 1 ? '' : 's'} · revision {set.revision}
              </p>
              {set.blocking.map((entry) => {
                const fix = hsqbFixDestination(entry.code);
                return (
                  <Callout
                    key={`${entry.code}:${entry.path}`}
                    tone="danger"
                    title="Must fix before saving"
                    actions={
                      fix && onNavigate ? (
                        <Button variant="secondary" onClick={() => onNavigate(fix.section)}>
                          {fix.label}
                        </Button>
                      ) : undefined
                    }
                  >
                    {entry.message}
                  </Callout>
                );
              })}
              {extraErrors.map((message) => (
                <Callout key={message} tone="danger" title="Must fix before saving">
                  {message}
                </Callout>
              ))}
              {set.warnings.map((message) => (
                <Callout key={`${set.scopeKey}:${message}`} tone="warning" title="Warning">
                  {message}
                </Callout>
              ))}
            </div>
          );
        })}
      </DialogSection>

      <DialogSection title="4 · Save files">
        <p className="director-text-meta">
          {preview.totalSets} report set{preview.totalSets === 1 ? '' : 's'} · {preview.totalFiles} files ·{' '}
          {preview.fileName} · revision {preview.revision}
        </p>
        {preview.sets.map((set) => (
          <p key={set.scopeKey} className="director-text-meta">
            <span title={set.scopeLabel}>{set.scopeLabel}</span> · {set.gameCount} game
            {set.gameCount === 1 ? '' : 's'} · {set.teamCount} team{set.teamCount === 1 ? '' : 's'} · files
            start with {set.baseName}
            {set.divisions.length > 1 ? ` · divisions: ${set.divisions.join(', ')}` : ''}
          </p>
        ))}
        {native ? (
          <Callout tone="info" title="Native save">
            The app saves one ZIP file. Extract it, then choose each HTML file below in the Resource
            Center&apos;s Add stat report form — the Resource Center takes separate HTML files, not the ZIP.
          </Callout>
        ) : (
          <Callout tone="info" title="Browser download">
            The browser downloads one ZIP for transport. Extract it first, then choose each HTML file below in
            the Resource Center&apos;s Add stat report form — the Resource Center takes separate HTML files,
            not the ZIP.
          </Callout>
        )}
        {saved && saved.fileName === preview.fileName && saved.revision === preview.revision && (
          <Callout tone="success" title="Saved — not yet published">
            {saved.fileName} (revision {saved.revision}) is on this device only. The report is not online
            until it is uploaded through the Resource Center form below.
          </Callout>
        )}
      </DialogSection>

      <DialogSection title="5 · Upload to the Resource Center">
        <p className="director-text-meta">
          Only the forum account that owns the tournament entry can post its statistics. Upload one stat
          report per set below.
        </p>
        <ol className="director-text-meta">
          {HSQB_MANUAL_UPLOAD_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {preview.sets.map((set) => (
          <div key={set.scopeKey}>
            <p className="director-text-meta">
              <span title={set.scopeLabel}>{set.scopeLabel}</span> — choose each file in its matching upload
              field:
            </p>
            <DataTable
              dense
              caption={
                <span title={set.scopeLabel}>
                  {set.scopeLabel} upload mapping — choose each file in its matching field
                </span>
              }
              items={hsqbUploadFieldMapping(set.files)}
              rowKey={(row) => row.kind}
              columns={[
                {
                  key: 'field',
                  header: 'Resource Center field',
                  priority: 1,
                  render: (row) => (
                    <span>
                      {row.field}
                      {row.attested ? '' : ' *'}
                    </span>
                  ),
                },
                {
                  key: 'file',
                  header: 'File to choose',
                  priority: 2,
                  render: (row) => <span title={row.fileName}>{row.fileName}</span>,
                },
              ]}
            />
            <p className="director-text-meta">
              * Field names follow the report roles; only the Scoreboard →{' '}
              <span title={set.baseName}>_games.html</span> mapping is attested by a public walkthrough. The
              Stat Key companion (
              {set.files.find((file) => file.kind === 'statKey')?.fileName ?? 'not generated'}) is optional
              and has no upload field.
            </p>
          </div>
        ))}
        <p>
          <a href={HSQB_RESOURCE_CENTER_URL} target="_blank" rel="noopener noreferrer">
            Open Quizbowl Resource Center<span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        </p>
      </DialogSection>
    </Dialog>
  );
}
