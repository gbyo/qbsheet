import { useState } from 'react';
import {
  currentPhase,
  formatGenerationAvailability,
  previewAdvancement,
  scoringRulePresets,
  type AdvancementRule,
  type DirectorState,
  type PhaseKind,
} from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import {
  ActionMenu,
  AdvancedSection,
  Button,
  Callout,
  Checkbox,
  CheckboxGroup,
  Dialog,
  DialogSection,
  EmptyState,
  Field,
  FieldGrid,
  FormActions,
  FormErrors,
  MenuItem,
  MultiSelect,
  NumberInput,
  Page,
  PageHeader,
  Panel,
  ReorderHandle,
  ReorderNotice,
  ReorderToggle,
  Select,
  SaveState,
  StateLabel,
  SummaryItem,
  SummaryList,
  TextInput,
  useConfirm,
  useDirtyForms,
  useFormState,
  useReorderMode,
  type SelectOption,
} from '../components';
import type { SectionId } from '../app/navigation';
import { poolName, recommendPoolSizes } from '@qbsheet/tournament-core';
import { errorNotice, type AnnounceInput } from '../notices';
import { RecommendedPlan } from './RecommendedPlan';
import { AdvancementCommit } from './AdvancementCommit';

export function FormatView({
  state,
  controller,
  onNavigate,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  onNavigate: (section: SectionId) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const formatId = state.tournament?.formatId;
  const format = formatId ? state.formats.find((entry) => entry.id === formatId) : undefined;
  const phase = currentPhase(state);
  const visiblePhases = state.phases.filter((entry) => !entry.archived);
  const singleStage = visiblePhases.length <= 1;
  const [scoringOpen, setScoringOpen] = useState(false);
  const [addPhaseOpen, setAddPhaseOpen] = useState(false);

  if (!format) {
    return (
      <Page>
        <PageHeader
          title="Format"
          description="A tournament is required before its format can be configured."
        />
        <EmptyState title="No tournament format" description="Create a tournament from Overview first." />
      </Page>
    );
  }

  const confirmedTeams = state.teams.filter((team) => team.status === 'confirmed').length;
  const acceptedResultCount = state.games.filter((game) => game.status === 'accepted').length;
  const generation = formatGenerationAvailability(state);
  return (
    <Page>
      <PageHeader
        title="Format"
        description={`${format.name} · ${confirmedTeams} confirmed team${confirmedTeams === 1 ? '' : 's'}`}
        actions={
          <Button variant="secondary" icon="chevron" onClick={() => onNavigate('schedule')}>
            Open tournament day
          </Button>
        }
      />

      <RecommendedPlan
        state={state}
        controller={controller}
        onNavigate={onNavigate}
        onAnnounce={onAnnounce}
      />

      <FormatBasics
        state={state}
        format={format}
        controller={controller}
        generationMessage={generation.message}
        generationSupported={generation.supported}
        onAnnounce={onAnnounce}
      />

      <Panel
        title="Scoring"
        description={scoringSummary(state)}
        actions={
          <Button variant="secondary" icon="edit" onClick={() => setScoringOpen(true)}>
            Edit scoring rules
          </Button>
        }
      >
        {acceptedResultCount > 0 && (
          <Callout tone="info" title="Core scoring values are locked">
            {acceptedResultCount} accepted result{acceptedResultCount === 1 ? '' : 's'} already use these
            values. Overtime, timers, lightning, bouncebacks, and tiebreakers remain editable.
          </Callout>
        )}
      </Panel>

      {format.kind === 'pools' || format.kind === 'playoff-pools'
        ? phase && (
            <PoolConfiguration state={state} phase={phase} controller={controller} onAnnounce={onAnnounce} />
          )
        : null}

      {(format.kind === 'custom' || format.kind === 'swiss') && phase && (
        <AdvancedSection
          label={format.kind === 'swiss' ? 'Manual power-pairing override' : 'Manual round builder'}
          hint="Use when the format intentionally requires director-controlled pairings."
          icon="settings"
        >
          <ManualRoundBuilder
            state={state}
            controller={controller}
            mode={format.kind}
            onNavigate={onNavigate}
            onAnnounce={onAnnounce}
          />
        </AdvancedSection>
      )}

      <AdvancedSection
        label={singleStage ? 'Stages & advancement' : `Stages & advancement · ${visiblePhases.length} stages`}
        hint={
          singleStage
            ? 'A one-stage tournament does not need stage concepts unless the field later splits.'
            : 'Configure the selected stage, advancement, carryover, and stage sequence.'
        }
        icon="format"
        defaultOpen={!singleStage}
      >
        <div className="director-stack">
          {phase && !singleStage && (
            <PhaseConfiguration state={state} phase={phase} controller={controller} onAnnounce={onAnnounce} />
          )}
          <StageSequence
            state={state}
            controller={controller}
            singleStage={singleStage}
            onAdd={() => setAddPhaseOpen(true)}
            onAnnounce={onAnnounce}
          />
        </div>
      </AdvancedSection>

      {state.tournament?.rules && (
        <AdvancedSection
          label="Standings & tiebreakers"
          hint="The ordered criteria used for standings and advancement."
          icon="standings"
        >
          <TiebreakerConfiguration
            rules={state.tournament.rules}
            controller={controller}
            onAnnounce={onAnnounce}
          />
        </AdvancedSection>
      )}

      {scoringOpen && state.tournament?.rules && (
        <ScoringRulesDialog
          rules={state.tournament.rules}
          controller={controller}
          acceptedResultCount={acceptedResultCount}
          onAnnounce={onAnnounce}
          onClose={() => setScoringOpen(false)}
        />
      )}
      {addPhaseOpen && (
        <AddPhaseDialog
          nextIndex={state.phases.length + 1}
          playoffDefault={singleStage}
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => setAddPhaseOpen(false)}
        />
      )}
    </Page>
  );
}

function FormatBasics({
  state,
  format,
  controller,
  generationMessage,
  generationSupported,
  onAnnounce,
}: {
  state: DirectorState;
  format: DirectorState['formats'][number];
  controller: DirectorController;
  generationMessage: string;
  generationSupported: boolean;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const locked = state.rounds.length > 0;
  const form = useFormState({
    initial: {
      kind: format.kind,
      roundsPerTeam: format.roundsPerTeam?.toString() ?? '',
      avoidRematches: format.avoidRematches,
      avoidSameOrganization: format.avoidSameOrganization,
      allowByes: format.allowByes,
    },
    validate: (draft) => {
      const raw = draft.roundsPerTeam.trim();
      const rounds = raw === '' ? null : Number(raw);
      return rounds === null || (Number.isInteger(rounds) && rounds >= 1 && rounds <= 99)
        ? {}
        : {
            roundsPerTeam:
              'Rounds per team must be a whole number from 1 to 99, or blank for no fixed limit.',
          };
    },
    onSubmit: (draft) => {
      const raw = draft.roundsPerTeam.trim();
      const rounds = raw === '' ? null : Number(raw);
      const saved = controller.updateFormat({
        kind: draft.kind,
        name: formatName(draft.kind),
        roundsPerTeam: rounds,
        avoidRematches: draft.avoidRematches,
        avoidSameOrganization: draft.avoidSameOrganization,
        allowByes: draft.allowByes,
      });
      onAnnounce(
        saved
          ? `${formatName(draft.kind)} settings saved.`
          : errorNotice('Format settings were not saved; review the Director error.'),
      );
      return saved;
    },
    formId: `format-basics-${format.id}`,
    formLabel: 'Tournament structure',
  });

  const formatOptions: SelectOption<typeof format.kind>[] = [
    { value: 'round-robin', label: 'Round robin', detail: 'Everyone meets on a deterministic rotation.' },
    {
      value: 'double-round-robin',
      label: 'Double round robin',
      detail: 'The rotation repeats with rematch tracking.',
    },
    { value: 'pools', label: 'Preliminary pools', detail: 'Divide the field into preliminary groups.' },
    { value: 'playoff-pools', label: 'Playoff pools', detail: 'Group qualifiers for a later stage.' },
    {
      value: 'single-elimination',
      label: 'Single elimination',
      detail: 'One loss removes a team from the bracket.',
    },
    { value: 'swiss', label: 'Swiss / power matching', detail: 'Pair teams with similar records.' },
    { value: 'custom', label: 'Custom / manual', detail: 'The director controls pairings.' },
  ];

  return (
    <Panel
      title="Tournament structure"
      description={`${formatDescription(format.kind)}. Changes here affect future rounds only.`}
      actions={
        <StateLabel
          state={format.editable ? 'ready' : 'warning'}
          label={format.editable ? 'Editable' : 'Imported'}
        />
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          form.submit();
        }}
      >
        <FieldGrid>
          <Field
            label="Format"
            hint={locked ? 'Format type is locked after the first generated round.' : undefined}
            render={({ id, labelId, describedBy }) => (
              <Select
                id={id}
                ariaLabelledBy={labelId}
                ariaDescribedBy={describedBy}
                value={form.draft.kind}
                options={formatOptions}
                disabled={locked || !format.editable}
                onChange={(kind) => form.set('kind', kind)}
              />
            )}
          />
          <Field
            label="Rounds per team"
            hint="Leave blank for no fixed limit."
            error={form.errorFor('roundsPerTeam')}
          >
            <NumberInput
              min={1}
              max={99}
              value={form.draft.roundsPerTeam}
              invalid={Boolean(form.errorFor('roundsPerTeam'))}
              disabled={!format.editable}
              onChange={(event) => form.set('roundsPerTeam', event.target.value)}
            />
          </Field>
        </FieldGrid>
        <CheckboxGroup
          legend="Pairing preferences"
          hint="Director applies these when possible; hard schedule constraints still win."
        >
          <Checkbox
            checked={form.draft.avoidRematches}
            disabled={!format.editable}
            label="Avoid rematches when possible"
            onChange={(value) => form.set('avoidRematches', value)}
          />
          <Checkbox
            checked={form.draft.avoidSameOrganization}
            disabled={!format.editable}
            label="Avoid same-school pairings when possible"
            onChange={(value) => form.set('avoidSameOrganization', value)}
          />
          <Checkbox
            checked={form.draft.allowByes}
            disabled={!format.editable}
            label="Allow explicit byes for odd fields"
            onChange={(value) => form.set('allowByes', value)}
          />
        </CheckboxGroup>
        <FormErrors errors={form.formErrors} />
        <FormActions state={<SaveState state={form.saveState} />}>
          {form.dirty && (
            <Button variant="secondary" onClick={() => form.reset()}>
              Discard changes
            </Button>
          )}
          <span className={generationSupported ? 'director-text-meta' : 'director-text-warning'}>
            {generationMessage}
          </span>
          <Button variant="primary" type="submit" disabled={!format.editable || !form.dirty}>
            Save format
          </Button>
        </FormActions>
      </form>
    </Panel>
  );
}

function ScoringRulesDialog({
  rules,
  controller,
  acceptedResultCount,
  onAnnounce,
  onClose,
}: {
  rules: NonNullable<DirectorState['tournament']>['rules'];
  controller: DirectorController;
  acceptedResultCount: number;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const locked = acceptedResultCount > 0;
  const [values, setValues] = useState(() => scoringRuleDraftsFor(rules));
  const [booleans, setBooleans] = useState(() => ({
    useBonuses: rules.useBonuses,
    bouncebacks: rules.bouncebacks,
    overtime: rules.overtime,
    overtimeBonuses: rules.overtimeBonuses,
    timed: rules.timed,
    lightning: rules.lightning,
  }));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ScoringRuleKey, string>>>({});

  const setValue = (key: ScoringRuleKey, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => (current[key] ? { ...current, [key]: undefined } : current));
  };
  const nullable = new Set<ScoringRuleKey>([
    'superpowerValue',
    'powerValue',
    'negValue',
    'maximumTossupCount',
    'minimumBonusParts',
    'maximumBonusScore',
    'bonusDivisor',
  ]);
  /*
   * Validation lands on the field, not in a toast.
   *
   * A toast names the problem somewhere else on screen, marks nothing, and is
   * gone by the time the operator looks down at the input it was about. The
   * failures are collected instead and shown against the fields that caused
   * them, cleared as soon as the value changes.
   */
  const parse = (
    key: ScoringRuleKey,
    label: string,
    failures: Partial<Record<ScoringRuleKey, string>>,
  ): number | null | undefined => {
    const raw = values[key].trim();
    if (!raw) {
      if (nullable.has(key)) return null;
      failures[key] = `${label} must be a number.`;
      return undefined;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      failures[key] = `${label} must be a finite number.`;
      return undefined;
    }
    return value;
  };

  const save = () => {
    const labels: Record<ScoringRuleKey, string> = {
      tossupValue: 'Tossup value',
      superpowerValue: 'Superpower value',
      powerValue: 'Power value',
      negValue: 'Neg value',
      bonusValue: 'Bonus value',
      tossupCount: 'Tossups',
      maximumTossupCount: 'Maximum tossups',
      bonusParts: 'Bonus parts',
      minimumBonusParts: 'Minimum bonus parts',
      maximumBonusScore: 'Maximum bonus score',
      bonusDivisor: 'Bonus divisor',
      overtimeTossupCount: 'Overtime tossups',
      lightningCountPerTeam: 'Lightning rounds per team',
      lightningDivisor: 'Lightning divisor',
      maximumActivePlayers: 'Maximum active players',
    };
    const failures: Partial<Record<ScoringRuleKey, string>> = {};
    const parsed = {} as Record<ScoringRuleKey, number | null>;
    for (const key of Object.keys(labels) as ScoringRuleKey[]) {
      const value = parse(key, labels[key], failures);
      if (value !== undefined) parsed[key] = value;
    }
    if (Object.keys(failures).length > 0) {
      setFieldErrors(failures);
      return;
    }
    setFieldErrors({});
    const changes: Partial<typeof rules> = {
      overtimeTossupCount: parsed.overtimeTossupCount as number,
      lightningCountPerTeam: parsed.lightningCountPerTeam as number,
      lightningDivisor: parsed.lightningDivisor as number,
      bouncebacks: booleans.bouncebacks,
      overtime: booleans.overtime,
      overtimeBonuses: booleans.overtimeBonuses,
      timed: booleans.timed,
      lightning: booleans.lightning,
    };
    if (!locked) {
      Object.assign(changes, {
        tossupValue: parsed.tossupValue,
        superpowerValue: parsed.superpowerValue,
        powerValue: parsed.powerValue,
        negValue: parsed.negValue,
        bonusValue: parsed.bonusValue,
        tossupCount: parsed.tossupCount,
        maximumTossupCount: parsed.maximumTossupCount,
        bonusParts: parsed.bonusParts,
        minimumBonusParts: parsed.minimumBonusParts,
        maximumBonusScore: parsed.maximumBonusScore,
        bonusDivisor: parsed.bonusDivisor,
        maximumActivePlayers: parsed.maximumActivePlayers,
        useBonuses: booleans.useBonuses,
      });
    }
    if (!controller.updateRules(changes)) {
      onAnnounce(errorNotice('Scoring rules were not saved; review the Director error.'));
      return;
    }
    onAnnounce('Scoring rules saved.');
    onClose();
  };

  const applyPreset = (preset: (typeof scoringRulePresets)[number]) => {
    const merged = { ...rules, ...preset.rules };
    setValues(scoringRuleDraftsFor(merged));
    setBooleans({
      useBonuses: merged.useBonuses,
      bouncebacks: merged.bouncebacks,
      overtime: merged.overtime,
      overtimeBonuses: merged.overtimeBonuses,
      timed: merged.timed,
      lightning: merged.lightning,
    });
  };

  return (
    <Dialog
      title="Scoring rules"
      description="Choose a preset or edit the values. Nothing changes until Save."
      size="xl"
      onClose={onClose}
      onSubmit={save}
      submitLabel="Save scoring rules"
    >
      {locked && (
        <Callout tone="info" title="Core values are locked">
          Accepted results already use the tournament&apos;s tossup, bonus, and roster-size values.
          Operational options remain editable.
        </Callout>
      )}
      <DialogSection title="Preset">
        <div className="director-actions">
          {scoringRulePresets.map((preset) => (
            <Button
              key={preset.id}
              variant="secondary"
              disabled={locked}
              onClick={() => applyPreset(preset)}
              title={preset.description}
            >
              {preset.name}
            </Button>
          ))}
        </div>
      </DialogSection>
      <DialogSection title="Core scoring">
        <FieldGrid>
          <NumberRule
            label="Tossup value"
            value={values.tossupValue}
            disabled={locked}
            error={fieldErrors.tossupValue}
            onChange={(value) => setValue('tossupValue', value)}
          />
          <NumberRule
            label="Power value"
            hint="Blank means no power mark."
            value={values.powerValue}
            disabled={locked}
            error={fieldErrors.powerValue}
            onChange={(value) => setValue('powerValue', value)}
          />
          <NumberRule
            label="Neg value"
            hint="Blank means no interrupt penalty."
            value={values.negValue}
            disabled={locked}
            error={fieldErrors.negValue}
            onChange={(value) => setValue('negValue', value)}
          />
          <NumberRule
            label="Bonus value"
            value={values.bonusValue}
            disabled={locked}
            error={fieldErrors.bonusValue}
            onChange={(value) => setValue('bonusValue', value)}
          />
          <NumberRule
            label="Tossups"
            value={values.tossupCount}
            disabled={locked}
            error={fieldErrors.tossupCount}
            onChange={(value) => setValue('tossupCount', value)}
          />
          <NumberRule
            label="Bonus parts"
            value={values.bonusParts}
            disabled={locked}
            error={fieldErrors.bonusParts}
            onChange={(value) => setValue('bonusParts', value)}
          />
          <NumberRule
            label="Maximum active players"
            value={values.maximumActivePlayers}
            disabled={locked}
            error={fieldErrors.maximumActivePlayers}
            onChange={(value) => setValue('maximumActivePlayers', value)}
          />
        </FieldGrid>
        <Checkbox
          checked={booleans.useBonuses}
          disabled={locked}
          label="Use bonuses"
          onChange={(useBonuses) => setBooleans((current) => ({ ...current, useBonuses }))}
        />
      </DialogSection>
      <DialogSection title="Game flow">
        <CheckboxGroup legend="Options" columns>
          <Checkbox
            checked={booleans.bouncebacks}
            label="Allow bouncebacks"
            onChange={(bouncebacks) => setBooleans((current) => ({ ...current, bouncebacks }))}
          />
          <Checkbox
            checked={booleans.overtime}
            label="Use overtime when tied"
            onChange={(overtime) => setBooleans((current) => ({ ...current, overtime }))}
          />
          <Checkbox
            checked={booleans.overtimeBonuses}
            label="Overtime tossups earn bonuses"
            onChange={(overtimeBonuses) => setBooleans((current) => ({ ...current, overtimeBonuses }))}
          />
          <Checkbox
            checked={booleans.timed}
            label="Use timed regulation"
            onChange={(timed) => setBooleans((current) => ({ ...current, timed }))}
          />
          <Checkbox
            checked={booleans.lightning}
            label="Enable lightning"
            onChange={(lightning) => setBooleans((current) => ({ ...current, lightning }))}
          />
        </CheckboxGroup>
        <FieldGrid>
          <NumberRule
            label="Overtime tossups"
            value={values.overtimeTossupCount}
            error={fieldErrors.overtimeTossupCount}
            onChange={(value) => setValue('overtimeTossupCount', value)}
          />
          <NumberRule
            label="Lightning rounds per team"
            value={values.lightningCountPerTeam}
            error={fieldErrors.lightningCountPerTeam}
            onChange={(value) => setValue('lightningCountPerTeam', value)}
          />
          <NumberRule
            label="Lightning divisor"
            value={values.lightningDivisor}
            error={fieldErrors.lightningDivisor}
            onChange={(value) => setValue('lightningDivisor', value)}
          />
        </FieldGrid>
      </DialogSection>
      <Button variant="quiet" onClick={() => setShowAdvanced((value) => !value)}>
        {showAdvanced ? 'Hide uncommon scoring fields' : 'Show uncommon scoring fields'}
      </Button>
      {showAdvanced && (
        <DialogSection title="Uncommon scoring fields">
          <FieldGrid>
            <NumberRule
              label="Superpower value"
              hint="Blank means no second tier."
              value={values.superpowerValue}
              disabled={locked}
              error={fieldErrors.superpowerValue}
              onChange={(value) => setValue('superpowerValue', value)}
            />
            <NumberRule
              label="Maximum tossups"
              hint="Blank means regulation ends at Tossups."
              value={values.maximumTossupCount}
              disabled={locked}
              error={fieldErrors.maximumTossupCount}
              onChange={(value) => setValue('maximumTossupCount', value)}
            />
            <NumberRule
              label="Minimum bonus parts"
              value={values.minimumBonusParts}
              disabled={locked}
              error={fieldErrors.minimumBonusParts}
              onChange={(value) => setValue('minimumBonusParts', value)}
            />
            <NumberRule
              label="Maximum bonus score"
              value={values.maximumBonusScore}
              disabled={locked}
              error={fieldErrors.maximumBonusScore}
              onChange={(value) => setValue('maximumBonusScore', value)}
            />
            <NumberRule
              label="Bonus divisor"
              value={values.bonusDivisor}
              disabled={locked}
              error={fieldErrors.bonusDivisor}
              onChange={(value) => setValue('bonusDivisor', value)}
            />
          </FieldGrid>
        </DialogSection>
      )}
    </Dialog>
  );
}

function NumberRule({
  label,
  hint,
  value,
  disabled = false,
  error,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  disabled?: boolean;
  error?: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} hint={hint} error={error}>
      <NumberInput
        value={value}
        disabled={disabled}
        invalid={Boolean(error)}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function AddPhaseDialog({
  nextIndex,
  playoffDefault,
  controller,
  onAnnounce,
  onClose,
}: {
  nextIndex: number;
  playoffDefault: boolean;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(playoffDefault ? 'Playoffs' : `Stage ${nextIndex}`);
  const [kind, setKind] = useState<PhaseKind>('playoff');
  return (
    <Dialog
      title={playoffDefault ? 'Add playoff stage' : 'Add stage'}
      description="A second stage is only needed when the field or rules change."
      onClose={onClose}
      onSubmit={() => {
        controller.addPhase(name.trim() || (playoffDefault ? 'Playoffs' : `Stage ${nextIndex}`), kind);
        onAnnounce('Stage added locally; saving now.');
        onClose();
      }}
      submitLabel="Add stage"
    >
      <Field label="Stage name">
        <TextInput value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field
        label="Stage type"
        render={({ id, describedBy }) => (
          <Select<PhaseKind>
            id={id}
            ariaDescribedBy={describedBy}
            value={kind}
            options={phaseKindOptions}
            onChange={setKind}
          />
        )}
      />
    </Dialog>
  );
}

function StageSequence({
  state,
  controller,
  singleStage,
  onAdd,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  singleStage: boolean;
  onAdd: () => void;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const confirmAction = useConfirm();
  const dirtyForms = useDirtyForms();
  const phases = [...state.phases].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
  return (
    <Panel
      title={singleStage ? 'Tournament stage' : 'Stage sequence'}
      description={
        singleStage
          ? `${state.rounds.length} round${state.rounds.length === 1 ? '' : 's'}. Add a stage only when the field later splits.`
          : 'Select the stage whose future rounds you are configuring.'
      }
      actions={
        <Button variant="secondary" icon="plus" onClick={onAdd}>
          {singleStage ? 'Add playoff stage' : 'Add stage'}
        </Button>
      }
      flush
    >
      <SummaryList ariaLabel="Tournament stages">
        {phases.map((entry) => (
          <SummaryItem
            key={entry.id}
            title={<strong>{entry.name}</strong>}
            status={
              <StateLabel
                state={entry.archived ? 'archived' : entry.status}
                label={entry.archived ? 'Archived' : entry.status}
              />
            }
            summary={`${phaseKindLabel(entry.kind)} · ${state.rounds.filter((round) => entry.roundIds.includes(round.id)).length} generated round${state.rounds.filter((round) => entry.roundIds.includes(round.id)).length === 1 ? '' : 's'}`}
            actions={
              <div className="director-actions">
                <Button
                  variant={entry.id === state.tournament?.currentPhaseId ? 'secondary' : 'quiet'}
                  disabled={entry.archived}
                  onClick={() => {
                    const select = () => {
                      controller.selectPhase(entry.id);
                      onAnnounce(
                        entry.status === 'complete'
                          ? `${entry.name} selected for review; it is complete.`
                          : `${entry.name} selected for future configuration.`,
                      );
                    };
                    if (entry.id === state.tournament?.currentPhaseId) {
                      select();
                      return;
                    }
                    const dirty = dirtyForms.filter((form) => form.dirty);
                    if (!dirty.length) {
                      select();
                      return;
                    }
                    void confirmAction({
                      title: 'Discard unsaved format changes?',
                      body: `You have unsaved changes in ${dirty.map((form) => form.label).join(' and ')}.`,
                      consequence: 'Selecting another stage will discard those drafts.',
                      confirmLabel: 'Discard changes',
                      cancelLabel: 'Keep editing',
                      tone: 'warning',
                    }).then((confirmed) => {
                      if (!confirmed) return;
                      dirty.forEach((form) => form.discard());
                      select();
                    });
                  }}
                >
                  {entry.status === 'complete'
                    ? 'Review'
                    : entry.id === state.tournament?.currentPhaseId
                      ? 'Current'
                      : 'Select'}
                </Button>
                <ActionMenu label={`${entry.name} actions`} triggerLabel={`${entry.name} actions`}>
                  {(close) => (
                    <MenuItem
                      icon={entry.archived ? 'undo' : 'trash'}
                      tone={entry.archived ? 'default' : 'danger'}
                      onSelect={() => {
                        close();
                        void (async () => {
                          if (!entry.archived) {
                            const approved = await confirmAction({
                              title: `Archive ${entry.name}?`,
                              consequence:
                                'Its rounds and results remain historical, but the stage will no longer be used for future scheduling.',
                              confirmLabel: 'Archive stage',
                              tone: 'danger',
                            });
                            if (!approved) return;
                          }
                          if (controller.setPhaseArchived(entry.id, !entry.archived)) {
                            onAnnounce(
                              `${entry.name} ${entry.archived ? 'reopened' : 'archived'}; history was retained.`,
                            );
                          } else
                            onAnnounce(
                              errorNotice(`${entry.name} was not changed; review the Director error.`),
                            );
                        })();
                      }}
                    >
                      {entry.archived ? 'Reopen stage' : 'Archive stage…'}
                    </MenuItem>
                  )}
                </ActionMenu>
              </div>
            }
          />
        ))}
      </SummaryList>
    </Panel>
  );
}

function PhaseConfiguration({
  state,
  phase,
  controller,
  onAnnounce,
}: {
  state: DirectorState;
  phase: DirectorState['phases'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const rules = state.tournament?.rules;
  const form = useFormState<PhaseFormValues>({
    initial: phaseDraftFor(phase),
    validate: (draft) => {
      if (!draft.advancementEnabled) return {};
      const errors: Partial<Record<keyof PhaseFormValues, string>> & { _form?: string[] } = {};
      const qualifiers = Number(draft.qualifiersPerPool);
      const wildcardCount = draft.wildcards.trim() === '' ? 0 : Number(draft.wildcards);
      if (!Number.isInteger(qualifiers) || qualifiers < 1) {
        errors.qualifiersPerPool = 'Qualifiers must be a positive whole number.';
      }
      if (!Number.isInteger(wildcardCount) || wildcardCount < 0) {
        errors.wildcards = 'Wildcards must be zero or a positive whole number.';
      }
      if (!rules?.tiebreakers.length && !phase.advancementRule?.tiebreakers.length) {
        errors._form = ['Configure at least one standings tiebreaker before enabling advancement.'];
      }
      return errors;
    },
    onSubmit: (draft) => {
      const advancementRule: AdvancementRule | null = draft.advancementEnabled
        ? {
            qualifiersPerPool: Number(draft.qualifiersPerPool),
            wildcards: draft.wildcards.trim() === '' ? 0 : Number(draft.wildcards),
            tiebreakers: [...(phase.advancementRule?.tiebreakers ?? rules?.tiebreakers ?? [])],
            manualOverrideAllowed: draft.manualOverrideAllowed,
          }
        : null;
      const updated = controller.updatePhase(phase.id, {
        name: draft.name.trim(),
        kind: draft.kind,
        carryover: draft.carryover,
        advancementRule,
      });
      if (!updated) {
        onAnnounce(errorNotice('Stage changes were not saved; review the Director error.'));
        return false;
      }
      onAnnounce(`${draft.name.trim()} stage settings updated.`);
      return true;
    },
    formId: `format-phase-${phase.id}`,
    formLabel: `${phase.name} stage settings`,
  });
  const acceptedResults = state.games.some(
    (game) => game.roundId && phase.roundIds.includes(game.roundId) && game.status === 'accepted',
  );
  const preview = phase.advancementRule && acceptedResults ? previewAdvancement(state, phase) : null;

  return (
    <Panel
      title={`Selected stage · ${phase.name}`}
      description="These settings apply only when a tournament has multiple stages."
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          form.submit();
        }}
      >
        <FieldGrid>
          <Field label="Stage name">
            <TextInput value={form.draft.name} onChange={(event) => form.set('name', event.target.value)} />
          </Field>
          <Field
            label="Stage type"
            hint={phase.roundIds.length > 0 ? 'Locked after the first generated round.' : undefined}
            render={({ id, describedBy }) => (
              <Select<PhaseKind>
                id={id}
                ariaDescribedBy={describedBy}
                value={form.draft.kind}
                options={phaseKindOptions}
                disabled={phase.roundIds.length > 0}
                onChange={(kind) => form.set('kind', kind)}
              />
            )}
          />
        </FieldGrid>
        <Checkbox
          checked={form.draft.carryover}
          label="Carry over prior-stage results"
          onChange={(carryover) => form.set('carryover', carryover)}
        />
        <Checkbox
          checked={form.draft.advancementEnabled}
          label="Use an advancement rule"
          hint="Director previews the qualifiers before they are committed to the next stage."
          onChange={(advancementEnabled) => form.set('advancementEnabled', advancementEnabled)}
        />
        {form.draft.advancementEnabled && (
          <div className="director-inset">
            <FieldGrid>
              <Field label={phase.poolIds.length > 0 ? 'Qualifiers per pool' : 'Qualifiers from stage'}>
                <NumberInput
                  min={1}
                  value={form.draft.qualifiersPerPool}
                  onChange={(event) => form.set('qualifiersPerPool', event.target.value)}
                />
              </Field>
              {phase.poolIds.length > 0 && (
                <Field label="Best remaining teams" hint="Wildcards across pools.">
                  <NumberInput
                    min={0}
                    value={form.draft.wildcards}
                    onChange={(event) => form.set('wildcards', event.target.value)}
                  />
                </Field>
              )}
            </FieldGrid>
            <Checkbox
              checked={form.draft.manualOverrideAllowed}
              label="Allow director override for unresolved ties"
              onChange={(manualOverrideAllowed) => form.set('manualOverrideAllowed', manualOverrideAllowed)}
            />
          </div>
        )}
        {preview && (
          <Callout
            tone={preview.unresolved.length > 0 ? 'warning' : 'info'}
            title={`${preview.qualifiers.length} proposed qualifier${preview.qualifiers.length === 1 ? '' : 's'}`}
          >
            {preview.qualifiers.map((team) => team.displayName).join(' · ')}
          </Callout>
        )}
        {preview && (
          <AdvancementCommit
            state={state}
            sourcePhaseId={phase.id}
            preview={preview}
            controller={controller}
            onAnnounce={onAnnounce}
          />
        )}
        {phase.advancementRule && !acceptedResults && (
          <p className="director-text-meta">
            Accept at least one result in this stage to populate the advancement preview.
          </p>
        )}
        <FormErrors errors={form.formErrors} />
        <FormActions state={<SaveState state={form.saveState} />}>
          {form.dirty && (
            <Button variant="secondary" onClick={() => form.reset()}>
              Discard changes
            </Button>
          )}
          <Button variant="primary" type="submit" disabled={!form.dirty}>
            Save stage settings
          </Button>
        </FormActions>
      </form>
    </Panel>
  );
}

function TiebreakerConfiguration({
  rules,
  controller,
  onAnnounce,
}: {
  rules: NonNullable<DirectorState['tournament']>['rules'];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const reorder = useReorderMode();
  const move = (index: number, delta: number) => {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= rules.tiebreakers.length) return;
    const next = [...rules.tiebreakers];
    const current = next[index];
    const target = next[targetIndex];
    if (!current || !target) return;
    next[index] = target;
    next[targetIndex] = current;
    if (controller.updateRules({ tiebreakers: next })) {
      onAnnounce(
        `${tiebreakerLabel(current)} moved ${delta < 0 ? 'earlier' : 'later'} in the standings order.`,
      );
    } else onAnnounce(errorNotice('The tiebreaker order was not saved; review the Director error.'));
  };
  return (
    <Panel
      title="Tiebreaker order"
      description="The first criterion that separates tied teams wins."
      actions={
        <ReorderToggle
          active={reorder.active}
          onToggle={reorder.toggle}
          label="Reorder criteria"
          disabled={rules.tiebreakers.length < 2}
        />
      }
      flush
    >
      {reorder.active && <ReorderNotice />}
      <SummaryList ariaLabel="Tiebreaker order">
        {rules.tiebreakers.map((tiebreaker, index) => (
          <SummaryItem
            key={tiebreaker}
            title={
              <strong>
                {index + 1}. {tiebreakerLabel(tiebreaker)}
              </strong>
            }
            summary={tiebreakerDescription(tiebreaker)}
            actions={
              reorder.active ? (
                <ReorderHandle
                  label={tiebreakerLabel(tiebreaker)}
                  index={index}
                  count={rules.tiebreakers.length}
                  onMove={(delta) => move(index, delta)}
                />
              ) : undefined
            }
          />
        ))}
      </SummaryList>
      {rules.tiebreakers.includes('playoff') && (
        <p className="director-text-meta">
          Playoff results stay in the audit trail but are not ranked automatically yet.
        </p>
      )}
    </Panel>
  );
}

function ManualRoundBuilder({
  state,
  controller,
  mode,
  onNavigate,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  mode: 'custom' | 'swiss';
  onNavigate: (section: SectionId) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const teams = state.teams
    .filter((team) => team.status === 'confirmed')
    .sort(
      (left, right) =>
        (left.seed ?? 9999) - (right.seed ?? 9999) || left.displayName.localeCompare(right.displayName),
    );
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>(() => teams.map((team) => team.id));
  const [byeTeamId, setByeTeamId] = useState('');
  const [roundName, setRoundName] = useState('');
  const [packetId, setPacketId] = useState(state.tournament?.currentPacketId ?? '');
  const selected = teams.filter((team) => selectedTeamIds.includes(team.id));
  const pairable = selected.filter((team) => team.id !== byeTeamId);
  const oddNeedsBye = pairable.length % 2 === 1;
  const createRound = () => {
    if (mode === 'swiss' && selected.length !== teams.length) {
      onAnnounce(
        errorNotice(
          'Swiss manual override must account for every confirmed team; drop teams instead of omitting them.',
        ),
      );
      return;
    }
    if (selected.length < 2) {
      onAnnounce(errorNotice('Select at least two confirmed teams.'));
      return;
    }
    if (byeTeamId && !selectedTeamIds.includes(byeTeamId)) {
      onAnnounce(errorNotice('Choose a bye team from the selected field.'));
      return;
    }
    if (oddNeedsBye) {
      onAnnounce(errorNotice('This selected field is odd; choose the team receiving the bye.'));
      return;
    }
    const pairings: Array<{ leftTeamId: string; rightTeamId: string | null }> = [];
    for (let index = 0; index < pairable.length; index += 2) {
      const left = pairable[index];
      const right = pairable[index + 1];
      if (left && right) pairings.push({ leftTeamId: left.id, rightTeamId: right.id });
    }
    if (byeTeamId) pairings.push({ leftTeamId: byeTeamId, rightTeamId: null });
    const result = controller.generateSchedule({
      roundName: roundName.trim() || undefined,
      packetId: packetId || null,
      manualPairings: pairings,
    });
    if (!result.generated) {
      onAnnounce(errorNotice(result.conflicts.join(' ') || 'The manual round was not valid.'));
      return;
    }
    onAnnounce(
      mode === 'swiss'
        ? 'Manual Swiss override created; review it on Tournament day.'
        : 'Manual round created; review it on Tournament day.',
    );
    onNavigate('schedule');
  };
  return (
    <Panel
      title={mode === 'swiss' ? 'Power-pairing override' : 'Manual pairings'}
      description="This is an advanced escape hatch; ordinary rounds are generated from Tournament day."
    >
      <FieldGrid>
        <Field label="Round name" optional>
          <TextInput
            value={roundName}
            onChange={(event) => setRoundName(event.target.value)}
            placeholder="Round 1"
          />
        </Field>
        <Field
          label="Packet"
          render={({ id, labelId, describedBy }) => (
            <Select
              id={id}
              ariaLabelledBy={labelId}
              ariaDescribedBy={describedBy}
              value={packetId}
              options={[
                { value: '', label: 'No packet selected' },
                ...state.packets
                  .filter((packet) => !packet.retired)
                  .map((packet) => ({ value: packet.id, label: packet.name })),
              ]}
              onChange={setPacketId}
            />
          )}
        />
      </FieldGrid>
      <Field
        label="Teams"
        hint={
          mode === 'swiss'
            ? 'Every confirmed team must be included.'
            : 'Choose the teams playing this manual round.'
        }
        render={({ id, labelId, describedBy }) => (
          <MultiSelect
            id={id}
            ariaLabelledBy={labelId}
            ariaDescribedBy={describedBy}
            values={selectedTeamIds}
            options={teams.map((team) => ({ value: team.id, label: team.displayName }))}
            onChange={(values) => {
              setSelectedTeamIds(values);
              if (byeTeamId && !values.includes(byeTeamId)) setByeTeamId('');
            }}
            allLabel="All confirmed teams"
            searchPlaceholder="Filter teams…"
          />
        )}
      />
      <Field
        label="Bye"
        hint="Required when the selected field is odd."
        render={({ id, labelId, describedBy }) => (
          <Select
            id={id}
            ariaLabelledBy={labelId}
            ariaDescribedBy={describedBy}
            value={byeTeamId}
            options={[
              { value: '', label: 'No bye' },
              ...selected.map((team) => ({ value: team.id, label: team.displayName })),
            ]}
            onChange={setByeTeamId}
          />
        )}
      />
      <div className="director-form-actions">
        <Button variant="primary" onClick={createRound} disabled={teams.length < 2}>
          Create manual round
        </Button>
      </div>
    </Panel>
  );
}

function PoolConfiguration({
  state,
  phase,
  controller,
  onAnnounce,
}: {
  state: DirectorState;
  phase: DirectorState['phases'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const pools = state.pools
    .filter((pool) => phase.poolIds.includes(pool.id))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const activePools = pools.filter((pool) => !pool.archived);
  const confirmedTeams = state.teams
    .filter((team) => team.status === 'confirmed')
    .sort(
      (left, right) =>
        (left.seed ?? 9999) - (right.seed ?? 9999) || left.displayName.localeCompare(right.displayName),
    );
  const [poolCount, setPoolCount] = useState(() =>
    String(Math.max(1, Math.min(3, Math.ceil(Math.max(1, confirmedTeams.length) / 6)))),
  );
  const [newPoolName, setNewPoolName] = useState('');
  const locked = phase.roundIds.length > 0;
  const playoffPools = formatForPhase(state, phase)?.kind === 'playoff-pools';
  const assignedTeamIds = new Set(activePools.flatMap((pool) => pool.teamIds));
  const unassignedCount = playoffPools
    ? 0
    : confirmedTeams.filter((team) => !assignedTeamIds.has(team.id)).length;
  const poolGeneration = formatGenerationAvailability(state);
  const createPools = () => {
    if (locked) {
      onAnnounce(
        errorNotice('Pool membership is locked after a round has been generated; add a new stage instead.'),
      );
      return;
    }
    const count = Number(poolCount);
    if (!Number.isInteger(count) || count < 1 || count > confirmedTeams.length) {
      onAnnounce(errorNotice(`Choose between 1 and ${confirmedTeams.length || 1} pools.`));
      return;
    }
    const sizes = playoffPools
      ? Array.from({ length: count }, () => 0)
      : recommendPoolSizes(confirmedTeams.length, count);
    let offset = 0;
    for (let index = 0; index < sizes.length; index += 1) {
      const teamIds = confirmedTeams.slice(offset, offset + (sizes[index] ?? 0)).map((team) => team.id);
      if (!controller.addPool({ phaseId: phase.id, name: poolName(index), teamIds })) {
        onAnnounce(errorNotice('Pool creation stopped; review the Director error before trying again.'));
        return;
      }
      offset += sizes[index] ?? 0;
    }
    onAnnounce(
      playoffPools
        ? `${count} playoff pool${count === 1 ? '' : 's'} created; assign advancing teams.`
        : `${count} pool${count === 1 ? '' : 's'} created and teams distributed.`,
    );
  };
  const addPool = () => {
    if (locked) return;
    const name = newPoolName.trim() || poolName(pools.length);
    if (!controller.addPool({ phaseId: phase.id, name })) {
      onAnnounce(errorNotice(`${name} was not added; review the Director error.`));
      return;
    }
    setNewPoolName('');
    onAnnounce(`${name} added.`);
  };
  return (
    <Panel
      title="Pools"
      description={
        playoffPools
          ? 'Assign only the advancing field to these playoff pools.'
          : 'Every confirmed team belongs to exactly one preliminary pool.'
      }
      actions={
        <StateLabel
          state={locked ? 'finished' : poolGeneration.supported ? 'ready' : 'warning'}
          label={locked ? 'Locked' : poolGeneration.supported ? 'Ready' : 'Needs setup'}
        />
      }
    >
      {pools.length === 0 ? (
        <div className="director-stack">
          <Field
            label="Number of pools"
            hint={
              playoffPools
                ? 'Creates empty pools for advancing teams.'
                : 'Teams are distributed by seed, with larger pools first.'
            }
          >
            <NumberInput
              min={1}
              max={Math.max(1, confirmedTeams.length)}
              value={poolCount}
              disabled={locked || confirmedTeams.length === 0}
              onChange={(event) => setPoolCount(event.target.value)}
            />
          </Field>
          <Button variant="primary" disabled={locked || confirmedTeams.length === 0} onClick={createPools}>
            {playoffPools ? 'Create playoff pools' : 'Create and distribute pools'}
          </Button>
        </div>
      ) : (
        <div className="director-stack">
          {!playoffPools && unassignedCount > 0 && (
            <Callout tone="warning">
              {unassignedCount} confirmed team{unassignedCount === 1 ? '' : 's'} still need a pool.
            </Callout>
          )}
          {pools.map((pool) => (
            <PoolEditor
              key={pool.id}
              pool={pool}
              pools={pools}
              teams={confirmedTeams}
              locked={locked}
              controller={controller}
              onAnnounce={onAnnounce}
            />
          ))}
          <div className="director-inline-edit">
            <Field label="Add another pool">
              <TextInput
                value={newPoolName}
                disabled={locked}
                onChange={(event) => setNewPoolName(event.target.value)}
                placeholder={poolName(pools.length)}
              />
            </Field>
            <Button variant="secondary" disabled={locked} onClick={addPool}>
              Add pool
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

function PoolEditor({
  pool,
  pools,
  teams,
  locked,
  controller,
  onAnnounce,
}: {
  pool: DirectorState['pools'][number];
  pools: DirectorState['pools'];
  teams: DirectorState['teams'];
  locked: boolean;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const confirmAction = useConfirm();
  const editable = !locked && !pool.archived;
  const form = useFormState({
    initial: { name: pool.name, teamIds: pool.teamIds },
    validate: (draft) => (draft.name.trim() ? {} : { name: 'Enter a pool name first.' }),
    onSubmit: (draft) => {
      if (!controller.updatePool(pool.id, { name: draft.name.trim(), teamIds: draft.teamIds })) {
        onAnnounce(errorNotice(`${draft.name.trim()} was not saved; review the Director error.`));
        return false;
      }
      onAnnounce(`${draft.name.trim()} updated.`);
      return true;
    },
    formId: `format-pool-${pool.id}`,
    formLabel: `${pool.name} pool`,
  });
  const assignedElsewhere = new Set(
    pools
      .filter((candidate) => candidate.id !== pool.id && !candidate.archived)
      .flatMap((candidate) => candidate.teamIds),
  );
  return (
    <div className="director-inset">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          form.submit();
        }}
      >
        <FieldGrid>
          <Field label="Pool name" error={form.errorFor('name')}>
            <TextInput
              value={form.draft.name}
              disabled={!editable}
              invalid={Boolean(form.errorFor('name'))}
              onChange={(event) => form.set('name', event.target.value)}
            />
          </Field>
          <Field
            label="Teams"
            render={({ id, labelId, describedBy }) => (
              <MultiSelect
                id={id}
                ariaLabelledBy={labelId}
                ariaDescribedBy={describedBy}
                values={form.draft.teamIds}
                disabled={!editable}
                options={teams.map((team) => ({
                  value: team.id,
                  label: team.displayName,
                  disabled: assignedElsewhere.has(team.id) && !form.draft.teamIds.includes(team.id),
                }))}
                onChange={(values) => form.set('teamIds', values)}
                searchPlaceholder="Filter teams…"
              />
            )}
          />
        </FieldGrid>
        <FormActions state={<SaveState state={form.saveState} />}>
          <StateLabel
            state={pool.archived ? 'archived' : 'active'}
            label={pool.archived ? 'Archived' : `${form.draft.teamIds.length} teams`}
          />
          <ActionMenu label={`${pool.name} actions`} triggerLabel={`${pool.name} actions`}>
            {(close) => (
              <MenuItem
                icon={pool.archived ? 'undo' : 'trash'}
                tone={pool.archived ? 'default' : 'danger'}
                onSelect={() => {
                  close();
                  void (async () => {
                    if (!pool.archived) {
                      const approved = await confirmAction({
                        title: `Archive ${pool.name}?`,
                        consequence:
                          'Its games and membership remain historical, but it will not be used for future rounds.',
                        confirmLabel: 'Archive pool',
                        tone: 'danger',
                      });
                      if (!approved) return;
                    }
                    if (controller.setPoolArchived(pool.id, !pool.archived))
                      onAnnounce(
                        `${pool.name} ${pool.archived ? 'reopened' : 'archived'}; history was retained.`,
                      );
                    else onAnnounce(errorNotice(`${pool.name} was not changed; review the Director error.`));
                  })();
                }}
              >
                {pool.archived ? 'Reopen pool' : 'Archive pool…'}
              </MenuItem>
            )}
          </ActionMenu>
          {form.dirty && (
            <Button variant="secondary" onClick={() => form.reset()}>
              Discard changes
            </Button>
          )}
          <Button variant="primary" type="submit" disabled={!editable || !form.dirty}>
            Save pool
          </Button>
        </FormActions>
      </form>
    </div>
  );
}

const phaseKindOptions: SelectOption<PhaseKind>[] = [
  { value: 'preliminary', label: 'Preliminary' },
  { value: 'playoff', label: 'Playoff' },
  { value: 'final', label: 'Final' },
  { value: 'placement', label: 'Placement' },
  { value: 'custom', label: 'Custom' },
];
function phaseKindLabel(kind: PhaseKind): string {
  return phaseKindOptions.find((option) => option.value === kind)?.label ?? kind;
}
function formatForPhase(
  state: DirectorState,
  phase: DirectorState['phases'][number],
): DirectorState['formats'][number] | undefined {
  return state.formats.find((format) => format.id === phase.formatId);
}

type PhaseFormValues = {
  name: string;
  kind: PhaseKind;
  carryover: boolean;
  advancementEnabled: boolean;
  qualifiersPerPool: string;
  wildcards: string;
  manualOverrideAllowed: boolean;
};
function phaseDraftFor(phase: DirectorState['phases'][number]): PhaseFormValues {
  return {
    name: phase.name,
    kind: phase.kind,
    carryover: phase.carryover,
    advancementEnabled: phase.advancementRule !== null,
    qualifiersPerPool: String(phase.advancementRule?.qualifiersPerPool ?? 1),
    wildcards: String(phase.advancementRule?.wildcards ?? 0),
    manualOverrideAllowed: phase.advancementRule?.manualOverrideAllowed ?? false,
  };
}

type DirectorTiebreaker = NonNullable<DirectorState['tournament']>['rules']['tiebreakers'][number];
function tiebreakerLabel(tiebreaker: DirectorTiebreaker): string {
  return (
    {
      'head-to-head': 'Head-to-head record',
      record: 'Overall record',
      points: 'Points scored',
      margin: 'Point margin',
      powers: 'Powers',
      gets: 'Gets',
      playoff: 'Playoff result',
    } as Record<DirectorTiebreaker, string>
  )[tiebreaker];
}
function tiebreakerDescription(tiebreaker: DirectorTiebreaker): string {
  return (
    {
      'head-to-head': 'Results among the tied teams',
      record: 'Wins and losses across accepted games',
      points: 'Total points scored',
      margin: 'Points scored minus points allowed',
      powers: 'Total power-tossup conversions',
      gets: 'Total regular-tossup conversions',
      playoff: 'Retained for manual playoff review; not ranked automatically',
    } as Record<DirectorTiebreaker, string>
  )[tiebreaker];
}
function formatDescription(kind: string): string {
  return (
    (
      {
        'round-robin': 'Everyone meets on a deterministic rotation',
        'double-round-robin': 'The rotation repeats with rematch tracking',
        pools: 'Teams are divided into preliminary groups',
        'playoff-pools': 'Qualifiers are grouped for playoffs',
        'single-elimination': 'One loss removes a team from the bracket',
        swiss: 'Power matching balances records',
        custom: 'The director controls each pairing',
      } as Record<string, string>
    )[kind] ?? 'Custom pairing plan'
  );
}
function formatName(kind: string): string {
  return (
    (
      {
        'round-robin': 'Round robin',
        'double-round-robin': 'Double round robin',
        pools: 'Preliminary pools',
        'playoff-pools': 'Playoff pools',
        'single-elimination': 'Single elimination',
        swiss: 'Swiss / power matching',
        custom: 'Custom format',
      } as Record<string, string>
    )[kind] ?? 'Custom format'
  );
}
function scoringSummary(state: DirectorState): string {
  const rules = state.tournament?.rules;
  if (!rules) return 'Tournament scoring rules are not configured.';
  const marks = [
    rules.superpowerValue != null ? `${rules.superpowerValue} superpower` : null,
    rules.powerValue != null ? `${rules.powerValue} power` : null,
    `${rules.tossupValue} tossup`,
    rules.negValue != null ? `${rules.negValue} neg` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return `${marks} · ${rules.bonusValue} × ${rules.bonusParts} bonus · ${rules.tossupCount} tossups`;
}

type ScoringRuleKey =
  | 'tossupValue'
  | 'superpowerValue'
  | 'powerValue'
  | 'negValue'
  | 'bonusValue'
  | 'tossupCount'
  | 'maximumTossupCount'
  | 'bonusParts'
  | 'minimumBonusParts'
  | 'maximumBonusScore'
  | 'bonusDivisor'
  | 'overtimeTossupCount'
  | 'lightningCountPerTeam'
  | 'lightningDivisor'
  | 'maximumActivePlayers';
type ScoringRuleDrafts = Record<ScoringRuleKey, string>;
function scoringRuleDraftsFor(
  rules: NonNullable<DirectorState['tournament']>['rules'] | undefined,
): ScoringRuleDrafts {
  return {
    tossupValue: String(rules?.tossupValue ?? 10),
    superpowerValue: rules?.superpowerValue == null ? '' : String(rules.superpowerValue),
    powerValue: rules?.powerValue == null ? '' : String(rules.powerValue),
    negValue: rules?.negValue == null ? '' : String(rules.negValue),
    bonusValue: String(rules?.bonusValue ?? 10),
    tossupCount: String(rules?.tossupCount ?? 20),
    maximumTossupCount: rules?.maximumTossupCount == null ? '' : String(rules.maximumTossupCount),
    bonusParts: String(rules?.bonusParts ?? 3),
    minimumBonusParts: rules?.minimumBonusParts == null ? '' : String(rules.minimumBonusParts),
    maximumBonusScore: rules?.maximumBonusScore == null ? '' : String(rules.maximumBonusScore),
    bonusDivisor: rules?.bonusDivisor == null ? '' : String(rules.bonusDivisor),
    overtimeTossupCount: String(rules?.overtimeTossupCount ?? 1),
    lightningCountPerTeam: String(rules?.lightningCountPerTeam ?? 1),
    lightningDivisor: String(rules?.lightningDivisor ?? 10),
    maximumActivePlayers: String(rules?.maximumActivePlayers ?? 4),
  };
}
