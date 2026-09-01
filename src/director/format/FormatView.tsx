import { useState } from 'react';
import type { DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, FormField, PanelBody, StateLabel } from '../components/Controls';
import { PageHeader } from '../components/PageHeader';
import type { SectionId } from '../app/navigation';

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
  const format = state.formats.find((entry) => entry.id === state.tournament?.formatId) ?? state.formats[0];
  const [roundsPerTeam, setRoundsPerTeam] = useState(format?.roundsPerTeam?.toString() ?? '');
  const phase = state.phases.find((entry) => entry.id === format?.phaseIds[0]);
  const scheduleCount = state.rounds.filter((round) => round.phaseId === phase?.id).length;
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
            onClick={() => {
              const result = controller.generateSchedule();
              onAnnounce(result.conflicts.length ? result.conflicts.join(' ') : 'Round generated and saved.');
              onNavigate('tournament');
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
                </FormField>
                <FormField
                  label="Rounds per team"
                  hint="Leave blank for the natural count of the selected format."
                >
                  <input
                    type="number"
                    min="1"
                    max="99"
                    value={roundsPerTeam}
                    onChange={(event) => {
                      setRoundsPerTeam(event.target.value);
                      controller.updateFormat({
                        roundsPerTeam: event.target.value ? Number(event.target.value) : null,
                      });
                    }}
                  />
                </FormField>
              </div>
              <div className="director-check-group">
                <label className="director-check-row">
                  <input
                    type="checkbox"
                    checked={format.avoidRematches}
                    onChange={(event) => controller.updateFormat({ avoidRematches: event.target.checked })}
                  />
                  <span>Avoid rematches when possible</span>
                </label>
                <label className="director-check-row">
                  <input
                    type="checkbox"
                    checked={format.avoidSameOrganization}
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
                    onChange={(event) => controller.updateFormat({ allowByes: event.target.checked })}
                  />
                  <span>Allow explicit byes for odd fields</span>
                </label>
              </div>
            </PanelBody>
          </section>
          <section className="director-panel">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">Scoring rules</p>
                <h2>QBSheet rules</h2>
              </div>
              <span className="director-muted">Saved with tournament</span>
            </div>
            <PanelBody>
              <div className="director-form-grid">
                <FormField label="Tossup value">
                  <input
                    type="number"
                    value={state.tournament?.rules.tossupValue ?? 10}
                    onChange={(event) => controller.updateRules({ tossupValue: Number(event.target.value) })}
                  />
                </FormField>
                <FormField label="Power value">
                  <input
                    type="number"
                    value={state.tournament?.rules.powerValue ?? 15}
                    onChange={(event) => controller.updateRules({ powerValue: Number(event.target.value) })}
                  />
                </FormField>
                <FormField label="Neg value">
                  <input
                    type="number"
                    value={state.tournament?.rules.negValue ?? -5}
                    onChange={(event) => controller.updateRules({ negValue: Number(event.target.value) })}
                  />
                </FormField>
                <FormField label="Tossups">
                  <input
                    type="number"
                    min="1"
                    value={state.tournament?.rules.tossupCount ?? 20}
                    onChange={(event) => controller.updateRules({ tossupCount: Number(event.target.value) })}
                  />
                </FormField>
                <FormField label="Bonus parts">
                  <input
                    type="number"
                    min="1"
                    value={state.tournament?.rules.bonusParts ?? 3}
                    onChange={(event) => controller.updateRules({ bonusParts: Number(event.target.value) })}
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
                onAnnounce('Phase added and saved.');
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
