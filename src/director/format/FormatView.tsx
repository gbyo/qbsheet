import { useEffect, useState } from 'react';
import { currentPhase, formatGenerationAvailability, type DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, FormField, PanelBody, StateLabel } from '../components/Controls';
import { PageHeader } from '../components/PageHeader';
import type { SectionId } from '../app/navigation';
import { poolName, recommendPoolSizes } from '@qbsheet/tournament-core';

export function FormatView({
  state,
  controller,
  onNavigate,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  onNavigate: (section: SectionId) => void;
  onAnnounce: (message: string) => void;
}) {
  const formatId = state.tournament?.formatId;
  const format = formatId ? state.formats.find((entry) => entry.id === formatId) : undefined;
  const [roundsPerTeam, setRoundsPerTeam] = useState(format?.roundsPerTeam?.toString() ?? '');
  const rules = state.tournament?.rules;
  const [scoringRuleDrafts, setScoringRuleDrafts] = useState(() => scoringRuleDraftsFor(rules));
  useEffect(() => {
    setScoringRuleDrafts(scoringRuleDraftsFor(rules));
  }, [
    state.tournament?.id,
    rules?.tossupValue,
    rules?.powerValue,
    rules?.negValue,
    rules?.bonusValue,
    rules?.tossupCount,
    rules?.bonusParts,
  ]);
  const commitScoringRule = (key: ScoringRuleKey, label: string): void => {
    const raw = scoringRuleDrafts[key].trim();
    if (!raw) {
      onAnnounce(`${label} must be a number.`);
      return;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      onAnnounce(`${label} must be a finite number.`);
      return;
    }
    controller.updateRules({ [key]: value } as Partial<NonNullable<DirectorState['tournament']>['rules']>);
  };
  const phase = currentPhase(state);
  const generation = formatGenerationAvailability(state);
  const scheduleCount = state.rounds.filter((round) => round.phaseId === phase?.id).length;
  const formatTypeLocked = state.rounds.length > 0;
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
        description="A reusable format controls phases, rounds, advancement, and tiebreakers."
        actions={
          <Button
            variant="primary"
            icon="play"
            disabled={!generation.supported}
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
                    <option value="single-elimination" disabled>
                      Single elimination (not implemented)
                    </option>
                    <option value="swiss" disabled>
                      Swiss / power matching (not implemented)
                    </option>
                    <option value="custom" disabled>
                      Custom / manual (not implemented)
                    </option>
                  </select>
                  {formatTypeLocked && <small>Format type is locked after the first generated round.</small>}
                </FormField>
                <FormField
                  label="Rounds per team"
                  hint="Director generates one validated round at a time; this setting is reserved for future format support."
                >
                  <input
                    type="number"
                    min="1"
                    max="99"
                    disabled
                    value={roundsPerTeam}
                    onChange={(event) => setRoundsPerTeam(event.target.value)}
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
                      setScoringRuleDrafts((current) => ({
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
                      setScoringRuleDrafts((current) => ({
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
                      setScoringRuleDrafts((current) => ({
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
                      setScoringRuleDrafts((current) => ({
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
                      setScoringRuleDrafts((current) => ({
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
                      setScoringRuleDrafts((current) => ({
                        ...current,
                        bonusParts: event.target.value,
                      }))
                    }
                    onBlur={() => commitScoringRule('bonusParts', 'Bonus parts')}
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
              </div>
            </PanelBody>
          </section>
        </div>
        {(format.kind === 'pools' || format.kind === 'playoff-pools') && phase && (
          <PoolConfiguration state={state} phase={phase} controller={controller} onAnnounce={onAnnounce} />
        )}
        <section className="director-panel">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">Phases</p>
              <h2>Plan sequence</h2>
            </div>
            <Button
              variant="quiet"
              onClick={() => {
                controller.addPhase(`Phase ${state.phases.length + 1}`, 'preliminary');
                onAnnounce('Phase added locally; saving now.');
              }}
            >
              Add phase
            </Button>
          </div>
          <PanelBody>
            {state.phases.length === 0 ? (
              <p className="director-empty-copy">No phases configured.</p>
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
                    <StateLabel state={entry.status} label={entry.status} />
                    <Button
                      variant={entry.id === state.tournament?.currentPhaseId ? 'secondary' : 'quiet'}
                      onClick={() => {
                        controller.selectPhase(entry.id);
                        onAnnounce(`${entry.name} selected for the next generated round.`);
                      }}
                    >
                      {entry.id === state.tournament?.currentPhaseId ? 'Current' : 'Use'}
                    </Button>
                  </li>
                ))}
              </ol>
            )}
            <p className="director-panel-footnote">
              {scheduleCount
                ? `${scheduleCount} round${scheduleCount === 1 ? '' : 's'} already generated. New format changes affect future rounds only.`
                : 'Generate a round after adding teams and rooms.'}
            </p>
          </PanelBody>
        </section>
      </div>
    </>
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
  onAnnounce: (message: string) => void;
}) {
  const pools = state.pools
    .filter((pool) => phase.poolIds.includes(pool.id))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
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
  const assignedTeamIds = new Set(pools.flatMap((pool) => pool.teamIds));
  const unassignedCount = confirmedTeams.filter((team) => !assignedTeamIds.has(team.id)).length;
  const createPools = () => {
    if (locked) {
      onAnnounce('Pool membership is locked after a round has been generated; add a new phase instead.');
      return;
    }
    const count = Number(poolCount);
    if (!Number.isInteger(count) || count < 1 || count > confirmedTeams.length) {
      onAnnounce(`Choose between 1 and ${confirmedTeams.length || 1} pools.`);
      return;
    }
    const sizes = recommendPoolSizes(confirmedTeams.length, count);
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
    onAnnounce(`${count} pool${count === 1 ? '' : 's'} created and confirmed teams distributed.`);
  };
  const addPool = () => {
    if (locked) {
      onAnnounce('Pool membership is locked after a round has been generated; add a new phase instead.');
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
              : 'Assign confirmed teams'}
          </h2>
        </div>
        <StateLabel
          state={locked ? 'finished' : unassignedCount === 0 && pools.length > 0 ? 'ready' : 'warning'}
          label={locked ? 'Locked' : unassignedCount === 0 && pools.length > 0 ? 'Complete' : 'Needs setup'}
        />
      </div>
      <PanelBody>
        <p className="director-panel-description">
          Every confirmed team must belong to exactly one pool before a pool round can be generated.
          {locked ? ' Membership is locked because this phase already has generated rounds.' : ''}
        </p>
        {pools.length === 0 ? (
          <form
            className="director-pool-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              createPools();
            }}
          >
            <FormField label="Number of pools" hint="Teams are distributed by seed, with larger pools first.">
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
              Create and distribute pools
            </Button>
          </form>
        ) : (
          <>
            <p className="director-panel-footnote">
              {unassignedCount === 0
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
  onAnnounce: (message: string) => void;
}) {
  const [name, setName] = useState(pool.name);
  const [teamIds, setTeamIds] = useState(pool.teamIds);
  const assignedElsewhere = new Set(
    pools.filter((candidate) => candidate.id !== pool.id).flatMap((candidate) => candidate.teamIds),
  );
  const save = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      onAnnounce('Enter a pool name first.');
      return;
    }
    if (!controller.updatePool(pool.id, { name: trimmedName, teamIds })) return;
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
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </FormField>
        <FormField label="Teams" hint="Hold Command/Ctrl to select more than one team.">
          <select
            className="director-pool-team-select"
            multiple
            size={Math.min(8, Math.max(3, teams.length))}
            value={teamIds}
            onChange={(event) =>
              setTeamIds(Array.from(event.currentTarget.selectedOptions, (option) => option.value))
            }
            disabled={locked}
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
        <Button variant="secondary" type="submit" disabled={locked}>
          Save {pool.name}
        </Button>
        <span className="director-muted">
          {teamIds.length} team{teamIds.length === 1 ? '' : 's'}
        </span>
      </div>
    </form>
  );
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

type ScoringRuleKey = 'tossupValue' | 'powerValue' | 'negValue' | 'bonusValue' | 'tossupCount' | 'bonusParts';

type ScoringRuleDrafts = Record<ScoringRuleKey, string>;

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
