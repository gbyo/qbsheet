import { useState } from 'react';
import {
  currentPhase,
  formatGenerationAvailability,
  previewAdvancement,
  type AdvancementRule,
  type DirectorState,
  type PhaseKind,
} from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, FormField, PanelBody, StateLabel } from '../components/Controls';
import { PageHeader } from '../components/PageHeader';
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
  const roundsDraftKey = format ? `${format.id}|${format.roundsPerTeam ?? ''}` : '';
  const [roundsDraftState, setRoundsDraftState] = useState(() => ({
    key: roundsDraftKey,
    value: format?.roundsPerTeam?.toString() ?? '',
    dirty: false,
  }));
  const roundsPerTeam =
    roundsDraftState.key === roundsDraftKey
      ? roundsDraftState.value
      : format && roundsDraftState.dirty && roundsDraftState.key.startsWith(`${format.id}|`)
        ? roundsDraftState.value
        : (format?.roundsPerTeam?.toString() ?? '');
  const rules = state.tournament?.rules;
  const scoringRuleDraftKey = scoringRuleKey(state.tournament?.id, rules);
  const [scoringRuleDraftState, setScoringRuleDraftState] = useState(() => ({
    key: scoringRuleDraftKey,
    values: scoringRuleDraftsFor(rules),
  }));
  const scoringRuleDrafts =
    scoringRuleDraftState.key === scoringRuleDraftKey
      ? scoringRuleDraftState.values
      : scoringRuleDraftsFor(rules);
  const updateScoringRuleDrafts = (
    update: (current: ReturnType<typeof scoringRuleDraftsFor>) => ReturnType<typeof scoringRuleDraftsFor>,
  ) => {
    setScoringRuleDraftState({
      key: scoringRuleDraftKey,
      values: update(scoringRuleDrafts),
    });
  };
  const commitScoringRule = (key: ScoringRuleKey, label: string): void => {
    const raw = scoringRuleDrafts[key].trim();
    if (!raw) {
      onAnnounce(errorNotice(`${label} must be a number.`));
      return;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      onAnnounce(errorNotice(`${label} must be a finite number.`));
      return;
    }
    controller.updateRules({ [key]: value } as Partial<NonNullable<DirectorState['tournament']>['rules']>);
  };
  const commitRoundsPerTeam = (): void => {
    if (!format) return;
    const raw = roundsPerTeam.trim();
    const value = raw ? Number(raw) : null;
    if ((value !== null && !Number.isInteger(value)) || (value !== null && (value < 1 || value > 99))) {
      onAnnounce(
        errorNotice('Rounds per team must be a whole number from 1 to 99, or blank for no fixed limit.'),
      );
      setRoundsDraftState({
        key: roundsDraftKey,
        value: format.roundsPerTeam?.toString() ?? '',
        dirty: false,
      });
      return;
    }
    if (!controller.updateFormat({ roundsPerTeam: value })) {
      onAnnounce('Rounds per team was not saved; review the Director error.');
      setRoundsDraftState({
        key: roundsDraftKey,
        value: format.roundsPerTeam?.toString() ?? '',
        dirty: false,
      });
      return;
    }
    setRoundsDraftState({
      key: `${format.id}|${value ?? ''}`,
      value: value?.toString() ?? '',
      dirty: false,
    });
  };
  const phase = currentPhase(state);
  // Progressive disclosure: one ordinary stage is the tournament itself, so
  // stage settings and the stage list stay hidden until a second stage exists.
  const visiblePhases = state.phases.filter((entry) => !entry.archived);
  const singleStage = visiblePhases.length <= 1;
  const generation = formatGenerationAvailability(state);
  const scheduleCount = state.rounds.filter((round) => round.phaseId === phase?.id).length;
  const formatTypeLocked = state.rounds.length > 0;
  const [showPhaseForm, setShowPhaseForm] = useState(false);
  const [newPhaseName, setNewPhaseName] = useState('');
  const [newPhaseKind, setNewPhaseKind] = useState<PhaseKind>('playoff');
  if (!format)
    return (
      <>
        <PageHeader
          eyebrow="Plan"
          title="Format"
          description="A tournament is required before its format can be configured."
        />
        <section className="director-panel">
          <PanelBody>
            <p className="director-empty-copy">Create a tournament from the Overview page first.</p>
          </PanelBody>
        </section>
      </>
    );
  return (
    <>
      <PageHeader
        eyebrow="Plan"
        title="Format"
        description="A reusable format controls stages, rounds, advancement, and tiebreakers."
        actions={
          <Button
            variant="primary"
            icon="play"
            disabled={!generation.supported || format.kind === 'custom'}
            onClick={() => {
              const result = controller.generateSchedule();
              if (result.generated) {
                onAnnounce(
                  result.conflicts.length
                    ? `Round generated with warnings: ${result.conflicts.join(' ')}`
                    : 'Round generated locally; saving now.',
                );
                onNavigate('tournament');
              } else {
                onAnnounce(
                  result.conflicts.join(' ') ||
                    'No round was generated; review the format and confirmed teams first.',
                );
              }
            }}
          >
            Generate next round
          </Button>
        }
      />
      <div className="director-page-stack">
        <RecommendedPlan
          state={state}
          controller={controller}
          onNavigate={onNavigate}
          onAnnounce={onAnnounce}
        />
        <section className="director-panel director-format-recommendation">
          <div>
            <p className="director-eyebrow">Current plan</p>
            <h2>{format.name}</h2>
            <p>
              {formatDescription(format.kind)} ·{' '}
              {state.teams.filter((team) => team.status === 'confirmed').length} confirmed teams ·{' '}
              {state.rooms.length} rooms · {state.packets.length} packets
            </p>
          </div>
          <StateLabel
            state={format.editable ? 'confirmed' : 'warning'}
            label={format.editable ? 'Editable' : 'Imported'}
          />
        </section>
        <div className="director-two-column">
          <section className="director-panel">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">Format settings</p>
                <h2>Pairing rules</h2>
              </div>
            </div>
            <PanelBody>
              <div className="director-form-grid director-form-grid-two">
                <FormField label="Format">
                  <select
                    value={format.kind}
                    disabled={formatTypeLocked || !format.editable}
                    onChange={(event) =>
                      controller.updateFormat({
                        kind: event.target.value as typeof format.kind,
                        name: formatName(event.target.value),
                      })
                    }
                  >
                    <option value="round-robin">Round robin</option>
                    <option value="double-round-robin">Double round robin</option>
                    <option value="pools">Preliminary pools</option>
                    <option value="playoff-pools">Playoff pools</option>
                    <option value="single-elimination">Single elimination</option>
                    <option value="swiss">Swiss / power matching</option>
                    <option value="custom">Custom / manual</option>
                  </select>
                  {formatTypeLocked && <small>Format type is locked after the first generated round.</small>}
                </FormField>
                <FormField
                  label="Rounds per team"
                  hint="Set a maximum for this stage; leave blank for no fixed limit."
                >
                  <input
                    type="number"
                    min="1"
                    max="99"
                    disabled={!format.editable}
                    value={roundsPerTeam}
                    onChange={(event) =>
                      setRoundsDraftState({ key: roundsDraftKey, value: event.target.value, dirty: true })
                    }
                    onBlur={commitRoundsPerTeam}
                  />
                </FormField>
              </div>
              <div className="director-check-group">
                <label className="director-check-row">
                  <input
                    type="checkbox"
                    checked={format.avoidRematches}
                    disabled={!format.editable}
                    onChange={(event) => controller.updateFormat({ avoidRematches: event.target.checked })}
                  />
                  <span>Avoid rematches when possible</span>
                </label>
                <label className="director-check-row">
                  <input
                    type="checkbox"
                    checked={format.avoidSameOrganization}
                    disabled={!format.editable}
                    onChange={(event) =>
                      controller.updateFormat({ avoidSameOrganization: event.target.checked })
                    }
                  />
                  <span>Avoid same-school pairings when possible</span>
                </label>
                <label className="director-check-row">
                  <input
                    type="checkbox"
                    checked={format.allowByes}
                    disabled={!format.editable}
                    onChange={(event) => controller.updateFormat({ allowByes: event.target.checked })}
                  />
                  <span>Allow explicit byes for odd fields</span>
                </label>
              </div>
              <p className="director-panel-footnote" role={generation.supported ? undefined : 'alert'}>
                {generation.message}
              </p>
            </PanelBody>
          </section>
          <section className="director-panel">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">Scoring rules</p>
                <h2>QBSheet rules</h2>
              </div>
              <span className="director-muted">
                {controller.error
                  ? 'Save needs attention'
                  : controller.saving
                    ? 'Saving changes…'
                    : state.metadata.lastSavedAt
                      ? 'Saved locally'
                      : 'Not saved yet'}
              </span>
            </div>
            <PanelBody>
              <div className="director-form-grid">
                <FormField label="Tossup value">
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={scoringRuleDrafts.tossupValue}
                    onChange={(event) =>
                      updateScoringRuleDrafts((current) => ({
                        ...current,
                        tossupValue: event.target.value,
                      }))
                    }
                    onBlur={() => commitScoringRule('tossupValue', 'Tossup value')}
                  />
                </FormField>
                <FormField label="Power value">
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={scoringRuleDrafts.powerValue}
                    onChange={(event) =>
                      updateScoringRuleDrafts((current) => ({
                        ...current,
                        powerValue: event.target.value,
                      }))
                    }
                    onBlur={() => commitScoringRule('powerValue', 'Power value')}
                  />
                </FormField>
                <FormField label="Neg value">
                  <input
                    type="number"
                    max="0"
                    step="1"
                    value={scoringRuleDrafts.negValue}
                    onChange={(event) =>
                      updateScoringRuleDrafts((current) => ({
                        ...current,
                        negValue: event.target.value,
                      }))
                    }
                    onBlur={() => commitScoringRule('negValue', 'Neg value')}
                  />
                </FormField>
                <FormField label="Bonus value">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={scoringRuleDrafts.bonusValue}
                    onChange={(event) =>
                      updateScoringRuleDrafts((current) => ({
                        ...current,
                        bonusValue: event.target.value,
                      }))
                    }
                    onBlur={() => commitScoringRule('bonusValue', 'Bonus value')}
                  />
                </FormField>
                <FormField label="Tossups">
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={scoringRuleDrafts.tossupCount}
                    onChange={(event) =>
                      updateScoringRuleDrafts((current) => ({
                        ...current,
                        tossupCount: event.target.value,
                      }))
                    }
                    onBlur={() => commitScoringRule('tossupCount', 'Tossups')}
                  />
                </FormField>
                <FormField label="Bonus parts">
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={scoringRuleDrafts.bonusParts}
                    onChange={(event) =>
                      updateScoringRuleDrafts((current) => ({
                        ...current,
                        bonusParts: event.target.value,
                      }))
                    }
                    onBlur={() => commitScoringRule('bonusParts', 'Bonus parts')}
                  />
                </FormField>
                <FormField label="Maximum active players">
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={scoringRuleDrafts.maximumActivePlayers}
                    onChange={(event) =>
                      updateScoringRuleDrafts((current) => ({
                        ...current,
                        maximumActivePlayers: event.target.value,
                      }))
                    }
                    onBlur={() => commitScoringRule('maximumActivePlayers', 'Maximum active players')}
                  />
                </FormField>
              </div>
              <div className="director-check-group">
                <label className="director-check-row">
                  <input
                    type="checkbox"
                    checked={state.tournament?.rules.bouncebacks ?? false}
                    onChange={(event) => controller.updateRules({ bouncebacks: event.target.checked })}
                  />
                  <span>Allow bouncebacks</span>
                </label>
                <label className="director-check-row">
                  <input
                    type="checkbox"
                    checked={state.tournament?.rules.overtime ?? true}
                    onChange={(event) => controller.updateRules({ overtime: event.target.checked })}
                  />
                  <span>Use overtime when tied</span>
                </label>
                <label className="director-check-row">
                  <input
                    type="checkbox"
                    checked={state.tournament?.rules.timed ?? false}
                    onChange={(event) => controller.updateRules({ timed: event.target.checked })}
                  />
                  <span>Use timed regulation</span>
                </label>
                <label className="director-check-row">
                  <input
                    type="checkbox"
                    checked={state.tournament?.rules.lightning ?? false}
                    onChange={(event) => controller.updateRules({ lightning: event.target.checked })}
                  />
                  <span>Enable lightning</span>
                </label>
              </div>
              <p className="director-panel-footnote">
                Timed regulation is carried to the scorer as a moderator-controlled clock. Regulation minutes
                remains a planning value; it never changes the scorer’s actual end-of-regulation decision.
              </p>
            </PanelBody>
          </section>
        </div>
        {(format.kind === 'custom' || format.kind === 'swiss') && phase && (
          <ManualRoundBuilder
            state={state}
            controller={controller}
            mode={format.kind}
            onNavigate={onNavigate}
            onAnnounce={onAnnounce}
          />
        )}
        {(format.kind === 'pools' || format.kind === 'playoff-pools') && phase && (
          <PoolConfiguration state={state} phase={phase} controller={controller} onAnnounce={onAnnounce} />
        )}
        {phase && !singleStage && (
          <PhaseConfiguration state={state} phase={phase} controller={controller} onAnnounce={onAnnounce} />
        )}
        {rules && <TiebreakerConfiguration rules={rules} controller={controller} onAnnounce={onAnnounce} />}
        <section className="director-panel">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">{singleStage ? 'Tournament plan' : 'Stages'}</p>
              <h2>{singleStage ? 'Single stage' : 'Plan sequence'}</h2>
            </div>
            <Button
              variant="quiet"
              onClick={() => {
                const next = !showPhaseForm;
                setShowPhaseForm(next);
                if (next) {
                  setNewPhaseName(singleStage ? 'Playoffs' : `Stage ${state.phases.length + 1}`);
                  setNewPhaseKind('playoff');
                }
              }}
            >
              {showPhaseForm ? 'Close' : singleStage ? 'Add playoff stage' : 'Add stage'}
            </Button>
          </div>
          <PanelBody>
            {showPhaseForm && (
              <form
                className="director-phase-add-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  controller.addPhase(
                    newPhaseName.trim() || (singleStage ? 'Playoffs' : `Stage ${state.phases.length + 1}`),
                    newPhaseKind,
                  );
                  setShowPhaseForm(false);
                  setNewPhaseName('');
                  onAnnounce('Stage added locally; saving now.');
                }}
              >
                <FormField label="Stage name">
                  <input
                    value={newPhaseName}
                    onChange={(event) => setNewPhaseName(event.target.value)}
                    placeholder="Playoffs"
                  />
                </FormField>
                <FormField label="Stage type">
                  <select
                    value={newPhaseKind}
                    onChange={(event) => setNewPhaseKind(event.target.value as PhaseKind)}
                  >
                    <option value="preliminary">Preliminary</option>
                    <option value="playoff">Playoff</option>
                    <option value="final">Final</option>
                    <option value="placement">Placement</option>
                    <option value="custom">Custom</option>
                  </select>
                </FormField>
                <Button variant="secondary" type="submit">
                  Save stage
                </Button>
              </form>
            )}
            {singleStage ? (
              <StageSummary state={state} />
            ) : state.phases.length === 0 ? (
              <p className="director-empty-copy">No stages configured.</p>
            ) : (
              <ol className="director-phase-list">
                {state.phases.map((entry) => (
                  <li key={entry.id}>
                    <span className="director-leader-rank">{entry.order}</span>
                    <div>
                      <strong>{entry.name}</strong>
                      <small>
                        {entry.kind} ·{' '}
                        {state.rounds.filter((round) => entry.roundIds.includes(round.id)).length} generated
                        round
                        {state.rounds.filter((round) => entry.roundIds.includes(round.id)).length === 1
                          ? ''
                          : 's'}
                      </small>
                    </div>
                    <StateLabel
                      state={entry.archived ? 'archived' : entry.status}
                      label={entry.archived ? 'archived' : entry.status}
                    />
                    <Button
                      variant={entry.id === state.tournament?.currentPhaseId ? 'secondary' : 'quiet'}
                      disabled={entry.archived}
                      onClick={() => {
                        controller.selectPhase(entry.id);
                        onAnnounce(
                          entry.status === 'complete'
                            ? `${entry.name} selected for review; it is complete.`
                            : `${entry.name} selected for the next generated round.`,
                        );
                      }}
                    >
                      {entry.status === 'complete'
                        ? 'Review'
                        : entry.id === state.tournament?.currentPhaseId
                          ? 'Current'
                          : 'Use'}
                    </Button>
                    <Button
                      variant="quiet"
                      onClick={() => {
                        if (
                          !entry.archived &&
                          !confirm(`Archive ${entry.name}? Its rounds will remain historical.`)
                        ) {
                          return;
                        }
                        if (controller.setPhaseArchived(entry.id, !entry.archived)) {
                          onAnnounce(
                            `${entry.name} ${entry.archived ? 'reopened' : 'archived'}; history was retained.`,
                          );
                        }
                      }}
                    >
                      {entry.archived ? 'Reopen' : 'Archive'}
                    </Button>
                  </li>
                ))}
              </ol>
            )}
            {!singleStage && (
              <p className="director-panel-footnote">
                {scheduleCount
                  ? `${scheduleCount} round${scheduleCount === 1 ? '' : 's'} already generated. New format changes affect future rounds only.`
                  : 'Generate a round after adding teams and rooms.'}
              </p>
            )}
          </PanelBody>
        </section>
      </div>
    </>
  );
}

function StageSummary({ state }: { state: DirectorState }) {
  const roundCount = state.rounds.length;
  const poolCount = state.pools.filter((pool) => !pool.archived).length;
  const rounds = `${roundCount} round${roundCount === 1 ? '' : 's'}`;
  const pools = poolCount === 0 ? 'no pools' : `${poolCount} pool${poolCount === 1 ? '' : 's'}`;
  return (
    <p className="director-empty-copy">
      {rounds} · {pools}. Add a playoff stage when the field splits; rounds, pools, and advancement stay
      editable.
    </p>
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
  const draftKey = phaseConfigurationKey(phase);
  const [draftState, setDraftState] = useState(() => ({
    key: draftKey,
    values: phaseDraftFor(phase),
  }));
  const draft =
    draftState.key === draftKey
      ? draftState.values
      : draftState.key.startsWith(`${phase.id}|`)
        ? reconcilePhaseDraft(draftState.values, phase)
        : phaseDraftFor(phase);
  const setDraft = (update: (current: PhaseDraft) => PhaseDraft): void => {
    setDraftState({ key: draftKey, values: update(draft) });
  };
  const advancementEnabled = draft.advancementDirty
    ? draft.advancementEnabled
    : phase.advancementRule !== null;
  const qualifiersPerPool = draft.advancementDirty
    ? draft.qualifiersPerPool
    : String(phase.advancementRule?.qualifiersPerPool ?? 1);
  const wildcards = draft.advancementDirty
    ? draft.wildcards
    : String(phase.advancementRule?.wildcards ?? 0);
  const manualOverrideAllowed = draft.advancementDirty
    ? draft.manualOverrideAllowed
    : (phase.advancementRule?.manualOverrideAllowed ?? false);
  const save = () => {
    const rawQualifiers = qualifiersPerPool.trim();
    let advancementRule: AdvancementRule | null = null;
    if (advancementEnabled) {
      const qualifiers = Number(rawQualifiers);
      if (!rawQualifiers || !Number.isInteger(qualifiers) || qualifiers < 1) {
        onAnnounce(errorNotice('Qualifiers per pool must be a positive whole number.'));
        return;
      }
      const rawWildcards = wildcards.trim();
      const wildcardCount = rawWildcards === '' ? 0 : Number(rawWildcards);
      if (!Number.isInteger(wildcardCount) || wildcardCount < 0) {
        onAnnounce(errorNotice('Wildcards must be zero or a positive whole number.'));
        return;
      }
      const tiebreakers = phase.advancementRule?.tiebreakers ?? rules?.tiebreakers ?? [];
      if (tiebreakers.length === 0) {
        onAnnounce('Configure at least one standings tiebreaker before enabling advancement.');
        return;
      }
      advancementRule = {
        qualifiersPerPool: qualifiers,
        wildcards: wildcardCount,
        tiebreakers: [...tiebreakers],
        manualOverrideAllowed,
      };
    }
    const updated = controller.updatePhase(phase.id, {
      name: draft.name.trim(),
      kind: draft.kind,
      carryover: draft.carryover,
      advancementRule,
    });
    if (!updated) {
      onAnnounce('Stage changes were not saved; review the Director error.');
      return;
    }
    setDraftState({
      key: draftKey,
      values: {
        name: draft.name.trim(),
        kind: draft.kind,
        carryover: draft.carryover,
        advancementEnabled,
        qualifiersPerPool: rawQualifiers,
        wildcards: wildcards.trim(),
        manualOverrideAllowed,
        nameDirty: false,
        kindDirty: false,
        carryoverDirty: false,
        advancementDirty: false,
      },
    });
    onAnnounce(`${draft.name.trim()} stage settings updated.`);
  };
  const acceptedResults = state.games.some(
    (game) => game.roundId && phase.roundIds.includes(game.roundId) && game.status === 'accepted',
  );
  const preview = phase.advancementRule && acceptedResults ? previewAdvancement(state, phase) : null;
  return (
    <section className="director-panel">
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">Selected stage</p>
          <h2>Stage settings</h2>
        </div>
        <StateLabel state={phase.status} label={phase.status} />
      </div>
      <PanelBody>
        <div className="director-form-grid director-form-grid-three">
          <FormField label="Stage name">
            <input
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value, nameDirty: true }))
              }
            />
          </FormField>
          <FormField
            label="Stage type"
            hint={phase.roundIds.length > 0 ? 'Type is locked after the first generated round.' : undefined}
          >
            <select
              value={draft.kind}
              disabled={phase.roundIds.length > 0}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  kind: event.target.value as PhaseKind,
                  kindDirty: true,
                }))
              }
            >
              <option value="preliminary">Preliminary</option>
              <option value="playoff">Playoff</option>
              <option value="final">Final</option>
              <option value="placement">Placement</option>
              <option value="custom">Custom</option>
            </select>
          </FormField>
          <label className="director-check-row director-phase-carryover-field">
            <input
              type="checkbox"
              checked={draft.carryover}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  carryover: event.target.checked,
                  carryoverDirty: true,
                }))
              }
            />
            <span>Carry over prior stage results</span>
          </label>
        </div>
        <div className="director-phase-advancement">
          <div>
            <p className="director-eyebrow">Advancement</p>
            <p className="director-panel-description">
              Configure who qualifies from this stage. Director previews the decision; move teams into the
              next stage after review.
            </p>
          </div>
          <label className="director-check-row">
            <input
              type="checkbox"
              checked={advancementEnabled}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  advancementEnabled: event.target.checked,
                  advancementDirty: true,
                }))
              }
            />
            <span>Use an advancement rule</span>
          </label>
          {advancementEnabled && (
            <div className="director-form-grid director-form-grid-two">
              <FormField
                label={phase.poolIds.length > 0 ? 'Qualifiers per pool' : 'Qualifiers from stage'}
                hint="The first team is the highest-ranked qualifier."
              >
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={qualifiersPerPool}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      qualifiersPerPool: event.target.value,
                      advancementDirty: true,
                    }))
                  }
                />
              </FormField>
              {phase.poolIds.length > 0 && (
                <FormField
                  label="Best remaining teams"
                  hint="Wildcards: top remaining teams across pools after the per-pool qualifiers."
                >
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={wildcards}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        wildcards: event.target.value,
                        advancementDirty: true,
                      }))
                    }
                  />
                </FormField>
              )}
              <label className="director-check-row director-phase-override-field">
                <input
                  type="checkbox"
                  checked={manualOverrideAllowed}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      manualOverrideAllowed: event.target.checked,
                      advancementDirty: true,
                    }))
                  }
                />
                <span>Allow director override for unresolved ties</span>
              </label>
            </div>
          )}
        </div>
        {preview && (
          <div className="director-advancement-preview" aria-live="polite">
            <div className="director-panel-heading director-panel-heading-compact">
              <div>
                <p className="director-eyebrow">Advancement preview</p>
                <h3>
                  {preview.qualifiers.length} qualifier{preview.qualifiers.length === 1 ? '' : 's'}
                </h3>
              </div>
              <StateLabel
                state={preview.unresolved.length > 0 ? 'warning' : 'ready'}
                label={preview.unresolved.length > 0 ? 'Decision needed' : 'Ranked'}
              />
            </div>
            <ul className="director-compact-list">
              {preview.qualifiers.map((team) => (
                <li key={team.id}>
                  {team.displayName}
                  {preview.wildcards.some((wildcard) => wildcard.id === team.id)
                    ? ' (wildcard)'
                    : ''}
                </li>
              ))}
            </ul>
            {preview.unresolved.map((tie) => (
              <p className="director-error-copy" key={tie.teamIds.join('|')}>
                {tie.reason} {tie.teamIds.map((teamId) => teamLabel(state, teamId)).join(' · ')}
              </p>
            ))}
            <small className="director-table-subtext">{preview.explanation.at(-1)}</small>
          </div>
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
          <p className="director-panel-footnote">
            Accept at least one result in this stage to populate the advancement preview.
          </p>
        )}
        <div className="director-row-actions director-phase-save-actions">
          <Button variant="secondary" onClick={save}>
            Save stage settings
          </Button>
        </div>
      </PanelBody>
    </section>
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
  const move = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= rules.tiebreakers.length) return;
    const next = [...rules.tiebreakers];
    const current = next[index];
    const target = next[targetIndex];
    if (!current || !target) return;
    next[index] = target;
    next[targetIndex] = current;
    if (controller.updateRules({ tiebreakers: next })) {
      onAnnounce(
        `${tiebreakerLabel(current)} moved ${direction < 0 ? 'up' : 'down'} in the standings order.`,
      );
    }
  };
  return (
    <section className="director-panel">
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">Standings</p>
          <h2>Tiebreaker order</h2>
        </div>
        <span className="director-muted">First criterion wins</span>
      </div>
      <PanelBody>
        <p className="director-panel-description">
          This order drives standings, advancement previews, and the published results table.
        </p>
        <ol className="director-tiebreaker-list">
          {rules.tiebreakers.map((tiebreaker, index) => (
            <li key={tiebreaker}>
              <span className="director-leader-rank">{index + 1}</span>
              <div>
                <strong>{tiebreakerLabel(tiebreaker)}</strong>
                <small>{tiebreakerDescription(tiebreaker)}</small>
              </div>
              <div className="director-tiebreaker-actions">
                <button
                  type="button"
                  className="director-icon-button"
                  aria-label={`Move ${tiebreakerLabel(tiebreaker)} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="director-icon-button"
                  aria-label={`Move ${tiebreakerLabel(tiebreaker)} down`}
                  disabled={index === rules.tiebreakers.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
              </div>
            </li>
          ))}
        </ol>
        {rules.tiebreakers.includes('playoff') && (
          <p className="director-panel-footnote">
            Playoff results are retained for the audit trail, but Director does not use them to rank teams
            automatically yet.
          </p>
        )}
      </PanelBody>
    </section>
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
        (left.seed ?? 9999) - (right.seed ?? 9999) ||
        left.displayName.localeCompare(right.displayName) ||
        left.id.localeCompare(right.id),
    );
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>(() => teams.map((team) => team.id));
  const [byeTeamId, setByeTeamId] = useState('');
  const [roundName, setRoundName] = useState('');
  const [packetId, setPacketId] = useState(state.tournament?.currentPacketId ?? '');
  const selected = teams.filter((team) => selectedTeamIds.includes(team.id));
  const pairable = selected.filter((team) => team.id !== byeTeamId);
  const oddNeedsBye = pairable.length % 2 === 1;
  const toggleTeam = (teamId: string) => {
    setSelectedTeamIds((current) =>
      current.includes(teamId) ? current.filter((id) => id !== teamId) : [...current, teamId],
    );
    if (byeTeamId === teamId) setByeTeamId('');
  };
  const createRound = () => {
    if (mode === 'swiss' && selected.length !== teams.length) {
      onAnnounce(
        'Swiss manual override must account for every confirmed team; drop teams instead of omitting them.',
      );
      return;
    }
    if (selected.length < 2) {
      onAnnounce('Select at least two confirmed teams.');
      return;
    }
    if (byeTeamId && !selectedTeamIds.includes(byeTeamId)) {
      onAnnounce('Choose a bye team from the selected field.');
      return;
    }
    if (oddNeedsBye) {
      onAnnounce('This selected field is odd; choose the team receiving the bye.');
      return;
    }
    const pairings = [] as Array<{ leftTeamId: string; rightTeamId: string | null }>;
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
        ? 'Manual Swiss override created; review and prepare the round before release.'
        : 'Manual round created; review and prepare the round before release.',
    );
    onNavigate('tournament');
  };
  return (
    <section className="director-panel">
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">{mode === 'swiss' ? 'Director override' : 'Manual builder'}</p>
          <h2>{mode === 'swiss' ? 'Power-pairing override' : 'Create a manual round'}</h2>
        </div>
        <span className="director-muted">{selected.length} teams selected</span>
      </div>
      <PanelBody>
        <p className="director-panel-description">
          {mode === 'swiss'
            ? 'Use this only when the unresolved standings or a pairing conflict requires a human decision. Every confirmed team must be included.'
            : 'Select the field, choose a bye when needed, and let Director create normal canonical games for review, preparation, and release.'}
        </p>
        <div className="director-form-grid director-form-grid-two">
          <FormField label="Round name">
            <input
              value={roundName}
              onChange={(event) => setRoundName(event.target.value)}
              placeholder="Round 1"
            />
          </FormField>
          <FormField label="Packet">
            <select value={packetId} onChange={(event) => setPacketId(event.target.value)}>
              <option value="">No packet selected</option>
              {state.packets
                .filter((packet) => packet.retired !== true)
                .map((packet) => (
                  <option key={packet.id} value={packet.id}>
                    {packet.name}
                  </option>
                ))}
            </select>
          </FormField>
        </div>
        <div className="director-check-group director-manual-team-list">
          {teams.map((team) => (
            <label key={team.id} className="director-check-row">
              <input
                type="checkbox"
                checked={selectedTeamIds.includes(team.id)}
                onChange={() => toggleTeam(team.id)}
              />
              <span>{team.displayName}</span>
            </label>
          ))}
        </div>
        <div className="director-form-grid director-form-grid-two">
          <FormField label="Bye (optional)" hint="Required when the selected field is odd.">
            <select value={byeTeamId} onChange={(event) => setByeTeamId(event.target.value)}>
              <option value="">No bye</option>
              {selected.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.displayName}
                </option>
              ))}
            </select>
          </FormField>
          <div className="director-form-actions">
            <Button variant="secondary" onClick={createRound} disabled={teams.length < 2}>
              Create round
            </Button>
          </div>
        </div>
      </PanelBody>
    </section>
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
  const activePools = pools.filter((pool) => pool.archived !== true);
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
  const poolSetupComplete = activePools.length > 0 && poolGeneration.supported;
  const createPools = () => {
    if (locked) {
      onAnnounce('Pool membership is locked after a round has been generated; add a new stage instead.');
      return;
    }
    const count = Number(poolCount);
    if (!Number.isInteger(count) || count < 1 || count > confirmedTeams.length) {
      onAnnounce(`Choose between 1 and ${confirmedTeams.length || 1} pools.`);
      return;
    }
    const sizes = playoffPools
      ? Array.from({ length: count }, () => 0)
      : recommendPoolSizes(confirmedTeams.length, count);
    let offset = 0;
    for (let index = 0; index < sizes.length; index += 1) {
      const teamIds = confirmedTeams.slice(offset, offset + (sizes[index] ?? 0)).map((team) => team.id);
      const added = controller.addPool({ phaseId: phase.id, name: poolName(index), teamIds });
      if (!added) {
        onAnnounce('Pool creation stopped; review the Director error before trying again.');
        return;
      }
      offset += sizes[index] ?? 0;
    }
    onAnnounce(
      playoffPools
        ? `${count} playoff pool${count === 1 ? '' : 's'} created; assign advancing teams before generating.`
        : `${count} pool${count === 1 ? '' : 's'} created and confirmed teams distributed.`,
    );
  };
  const addPool = () => {
    if (locked) {
      onAnnounce('Pool membership is locked after a round has been generated; add a new stage instead.');
      return;
    }
    const name = newPoolName.trim() || poolName(pools.length);
    if (!controller.addPool({ phaseId: phase.id, name })) return;
    setNewPoolName('');
    onAnnounce(`${name} added; assign its teams before generating.`);
  };
  return (
    <section className="director-panel">
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">Pool setup</p>
          <h2>
            {pools.length
              ? `${pools.length} pool${pools.length === 1 ? '' : 's'} configured`
              : playoffPools
                ? 'Create playoff pools'
                : 'Assign confirmed teams'}
          </h2>
        </div>
        <StateLabel
          state={locked ? 'finished' : poolSetupComplete ? 'ready' : 'warning'}
          label={locked ? 'Locked' : poolSetupComplete ? 'Complete' : 'Needs setup'}
        />
      </div>
      <PanelBody>
        <p className="director-panel-description">
          {playoffPools
            ? 'Each advancing team in this stage must belong to exactly one playoff pool; confirmed teams outside the stage are valid.'
            : 'Every confirmed team must belong to exactly one pool before a pool round can be generated.'}
          {locked ? ' Membership is locked because this stage already has generated rounds.' : ''}
        </p>
        {pools.length === 0 ? (
          <form
            className="director-pool-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              createPools();
            }}
          >
            <FormField
              label="Number of pools"
              hint={
                playoffPools
                  ? 'Create empty pools, then assign advancing teams manually.'
                  : 'Teams are distributed by seed, with larger pools first.'
              }
            >
              <input
                type="number"
                min="1"
                max={Math.max(1, confirmedTeams.length)}
                step="1"
                value={poolCount}
                onChange={(event) => setPoolCount(event.target.value)}
                disabled={locked || confirmedTeams.length === 0}
              />
            </FormField>
            <Button variant="primary" type="submit" disabled={locked || confirmedTeams.length === 0}>
              {playoffPools ? 'Create playoff pools' : 'Create and distribute pools'}
            </Button>
          </form>
        ) : (
          <>
            <p className="director-panel-footnote">
              {playoffPools
                ? assignedTeamIds.size > 0
                  ? 'Only teams assigned to these pools will play this stage; verify they are the advancing field before generating.'
                  : 'Assign the advancing teams to playoff pools before generating.'
                : unassignedCount === 0
                  ? 'All confirmed teams are assigned exactly once.'
                  : `${unassignedCount} confirmed team${unassignedCount === 1 ? '' : 's'} still need${unassignedCount === 1 ? 's' : ''} a pool.`}
            </p>
            <div className="director-pool-list">
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
            </div>
            <form
              className="director-pool-add-form"
              onSubmit={(event) => {
                event.preventDefault();
                addPool();
              }}
            >
              <FormField label="Add another pool">
                <input
                  value={newPoolName}
                  onChange={(event) => setNewPoolName(event.target.value)}
                  placeholder={poolName(pools.length)}
                  disabled={locked}
                />
              </FormField>
              <Button variant="secondary" type="submit" disabled={locked}>
                Add pool
              </Button>
            </form>
          </>
        )}
      </PanelBody>
    </section>
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
  const [draft, setDraft] = useState(() => ({
    name: pool.name,
    teamIds: pool.teamIds,
    nameDirty: false,
    teamIdsDirty: false,
  }));
  const editable = !locked && !pool.archived;
  const name = editable && draft.nameDirty ? draft.name : pool.name;
  const teamIds = editable && draft.teamIdsDirty ? draft.teamIds : pool.teamIds;
  const assignedElsewhere = new Set(
    pools
      .filter((candidate) => candidate.id !== pool.id && candidate.archived !== true)
      .flatMap((candidate) => candidate.teamIds),
  );
  const save = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      onAnnounce('Enter a pool name first.');
      return;
    }
    if (!controller.updatePool(pool.id, { name: trimmedName, teamIds })) return;
    setDraft({ name: trimmedName, teamIds, nameDirty: false, teamIdsDirty: false });
    onAnnounce(`${trimmedName} updated.`);
  };
  return (
    <form
      className="director-pool-card"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="director-form-grid director-form-grid-two">
        <FormField label="Pool name">
          <input
            value={name}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                name: event.target.value,
                nameDirty: true,
              }));
            }}
            disabled={!editable}
          />
        </FormField>
        <FormField label="Teams" hint="Hold Command/Ctrl to select more than one team.">
          <select
            className="director-pool-team-select"
            multiple
            size={Math.min(8, Math.max(3, teams.length))}
            value={teamIds}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                teamIds: Array.from(event.currentTarget.selectedOptions, (option) => option.value),
                teamIdsDirty: true,
              }));
            }}
            disabled={!editable}
          >
            {teams.map((team) => (
              <option
                key={team.id}
                value={team.id}
                disabled={assignedElsewhere.has(team.id) && !teamIds.includes(team.id)}
              >
                {team.displayName}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <div className="director-row-actions">
        <Button variant="secondary" type="submit" disabled={!editable}>
          Save {pool.name}
        </Button>
        <Button
          variant="quiet"
          type="button"
          onClick={() => {
            if (
              !pool.archived &&
              !confirm(`Archive ${pool.name}? Its games and membership will remain historical.`)
            ) {
              return;
            }
            if (controller.setPoolArchived(pool.id, !pool.archived)) {
              onAnnounce(`${pool.name} ${pool.archived ? 'reopened' : 'archived'}; history was retained.`);
            }
          }}
        >
          {pool.archived ? 'Reopen' : 'Archive'}
        </Button>
        <StateLabel
          state={pool.archived ? 'archived' : 'active'}
          label={pool.archived ? 'Archived' : 'Active'}
        />
        <span className="director-muted">
          {teamIds.length} team{teamIds.length === 1 ? '' : 's'}
        </span>
      </div>
    </form>
  );
}

function formatForPhase(
  state: DirectorState,
  phase: DirectorState['phases'][number],
): DirectorState['formats'][number] | undefined {
  return state.formats.find((format) => format.id === phase.formatId);
}

type PhaseDraft = {
  name: string;
  kind: PhaseKind;
  carryover: boolean;
  advancementEnabled: boolean;
  qualifiersPerPool: string;
  wildcards: string;
  manualOverrideAllowed: boolean;
  nameDirty: boolean;
  kindDirty: boolean;
  carryoverDirty: boolean;
  advancementDirty: boolean;
};

function phaseConfigurationKey(phase: DirectorState['phases'][number]): string {
  return [
    phase.id,
    phase.name,
    phase.kind,
    phase.carryover,
    phase.advancementRule?.qualifiersPerPool ?? '',
    phase.advancementRule?.wildcards ?? '',
    phase.advancementRule?.manualOverrideAllowed ?? '',
    phase.advancementRule?.tiebreakers.join(',') ?? '',
  ].join('|');
}

function phaseDraftFor(phase: DirectorState['phases'][number]): PhaseDraft {
  return {
    name: phase.name,
    kind: phase.kind,
    carryover: phase.carryover,
    advancementEnabled: phase.advancementRule !== null,
    qualifiersPerPool: String(phase.advancementRule?.qualifiersPerPool ?? 1),
    wildcards: String(phase.advancementRule?.wildcards ?? 0),
    manualOverrideAllowed: phase.advancementRule?.manualOverrideAllowed ?? false,
    nameDirty: false,
    kindDirty: false,
    carryoverDirty: false,
    advancementDirty: false,
  };
}

function reconcilePhaseDraft(draft: PhaseDraft, phase: DirectorState['phases'][number]): PhaseDraft {
  const incoming = phaseDraftFor(phase);
  return {
    ...incoming,
    name: draft.nameDirty ? draft.name : incoming.name,
    kind: draft.kindDirty ? draft.kind : incoming.kind,
    carryover: draft.carryoverDirty ? draft.carryover : incoming.carryover,
    advancementEnabled: draft.advancementDirty ? draft.advancementEnabled : incoming.advancementEnabled,
    qualifiersPerPool: draft.advancementDirty ? draft.qualifiersPerPool : incoming.qualifiersPerPool,
    wildcards: draft.advancementDirty ? draft.wildcards : incoming.wildcards,
    manualOverrideAllowed: draft.advancementDirty
      ? draft.manualOverrideAllowed
      : incoming.manualOverrideAllowed,
    nameDirty: draft.nameDirty,
    kindDirty: draft.kindDirty,
    carryoverDirty: draft.carryoverDirty,
    advancementDirty: draft.advancementDirty,
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

function teamLabel(state: DirectorState, teamId: string): string {
  return state.teams.find((team) => team.id === teamId)?.displayName ?? teamId;
}

function formatDescription(kind: string): string {
  return (
    (
      {
        'round-robin': 'everyone meets on a deterministic rotation',
        'double-round-robin': 'the rotation repeats with rematch tracking',
        pools: 'teams are divided into preliminary groups',
        'playoff-pools': 'qualifiers are grouped for playoffs',
        'single-elimination': 'one loss removes a team from the bracket',
        swiss: 'power matching balances records',
        custom: 'the director controls each pairing',
      } as Record<string, string>
    )[kind] ?? 'custom pairing plan'
  );
}

type ScoringRuleKey =
  | 'tossupValue'
  | 'powerValue'
  | 'negValue'
  | 'bonusValue'
  | 'tossupCount'
  | 'bonusParts'
  | 'maximumActivePlayers';

type ScoringRuleDrafts = Record<ScoringRuleKey, string>;

function scoringRuleKey(
  tournamentId: string | undefined,
  rules: NonNullable<DirectorState['tournament']>['rules'] | undefined,
): string {
  return [
    tournamentId ?? '',
    rules?.tossupValue ?? '',
    rules?.powerValue ?? '',
    rules?.negValue ?? '',
    rules?.bonusValue ?? '',
    rules?.tossupCount ?? '',
    rules?.bonusParts ?? '',
    rules?.maximumActivePlayers ?? '',
  ].join('|');
}

function scoringRuleDraftsFor(
  rules: NonNullable<DirectorState['tournament']>['rules'] | undefined,
): ScoringRuleDrafts {
  return {
    tossupValue: String(rules?.tossupValue ?? 10),
    powerValue: String(rules?.powerValue ?? 15),
    negValue: String(rules?.negValue ?? -5),
    bonusValue: String(rules?.bonusValue ?? 10),
    tossupCount: String(rules?.tossupCount ?? 20),
    bonusParts: String(rules?.bonusParts ?? 3),
    maximumActivePlayers: String(rules?.maximumActivePlayers ?? 4),
  };
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
