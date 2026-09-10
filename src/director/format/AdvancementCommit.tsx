import { useMemo, useState } from 'react';
import type { DirectorController } from '../state/useDirectorController';
import { advancementBasisStatus } from '../domain';
import type { AdvancementPreview, DirectorState } from '../domain';
import type { AnnounceInput } from '../notices';
import { errorNotice, infoNotice } from '../notices';
import { Button, Callout, Checkbox, Field, Select, TextInput } from '../components';
import {
  advancementCutoffDecisions,
  cutoffDecisionsAreValid,
  selectedAdvancementTeamIds,
  type AdvancementCutoffChoices,
} from './advancementSelection';

/**
 * Manual rebracketing: the preview proposes where each qualifier goes, the
 * director can resolve any cutoff ties and move teams between playoff pools,
 * and committing writes plain pool membership plus an audit record. Game
 * results are never rewritten; placement changes are explicit and audited.
 */
export function AdvancementCommit({
  state,
  sourcePhaseId,
  preview,
  controller,
  onAnnounce,
}: {
  state: DirectorState;
  sourcePhaseId: string;
  preview: AdvancementPreview;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const source = state.phases.find((entry) => entry.id === sourcePhaseId);
  const targets = useMemo(
    () =>
      state.phases
        .filter((entry) => entry.id !== sourcePhaseId && entry.archived !== true)
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
    [state.phases, sourcePhaseId],
  );
  const defaultTargetId = useMemo(() => {
    if (targets.length === 0) return '';
    const later = targets.find((entry) => source && entry.order > source.order);
    return (later ?? targets[0]).id;
  }, [targets, source]);
  const [targetPhaseId, setTargetPhaseId] = useState(defaultTargetId);
  const [moves, setMoves] = useState<Record<string, string>>({});
  const [cutoffChoices, setCutoffChoices] = useState<AdvancementCutoffChoices>({});
  const [reason, setReason] = useState('');

  const target = targets.find((entry) => entry.id === (targetPhaseId || defaultTargetId));
  const targetPools = useMemo(
    () =>
      (target?.poolIds ?? [])
        .map((poolId) => state.pools.find((pool) => pool.id === poolId))
        .filter((pool): pool is NonNullable<typeof pool> => pool !== undefined)
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
    [target, state.pools],
  );
  const cutoffDecisions = useMemo(
    () => advancementCutoffDecisions(preview, cutoffChoices),
    [preview, cutoffChoices],
  );
  const selectedTeamIds = useMemo(
    () => selectedAdvancementTeamIds(preview, cutoffDecisions),
    [preview, cutoffDecisions],
  );
  const selectedTeams = useMemo(
    () =>
      selectedTeamIds
        .map((teamId) => state.teams.find((team) => team.id === teamId))
        .filter((team): team is NonNullable<typeof team> => team !== undefined),
    [selectedTeamIds, state.teams],
  );
  const cutoffValid = cutoffDecisionsAreValid(cutoffDecisions);
  const wildcardIds = useMemo(() => {
    const ids = new Set(preview.wildcards.map((team) => team.id));
    for (const decision of cutoffDecisions.filter((entry) => /wildcard/i.test(entry.reason))) {
      decision.teamIds.forEach((teamId) => ids.delete(teamId));
      decision.selectedTeamIds.forEach((teamId) => ids.add(teamId));
    }
    return ids;
  }, [preview.wildcards, cutoffDecisions]);
  const proposal = useMemo(() => {
    const next: Record<string, string | undefined> = {};
    selectedTeams.forEach((team, index) => {
      const pool = targetPools.length > 0 ? targetPools[index % targetPools.length] : undefined;
      next[team.id] = pool ? (moves[team.id] ?? pool.id) : undefined;
    });
    return next;
  }, [selectedTeams, targetPools, moves]);

  const basisStatus = useMemo(() => advancementBasisStatus(state, sourcePhaseId), [state, sourcePhaseId]);

  if (targets.length === 0 || !target) return null;

  const previewQualifierIds = new Set(preview.qualifiers.map((team) => team.id));
  const movedOutside = selectedTeams
    .filter((team) => !previewQualifierIds.has(team.id))
    .map((team) => team.id);
  const needsReason = cutoffDecisions.length > 0 || movedOutside.length > 0;
  const byPool = new Map<string, typeof selectedTeams>();
  for (const team of selectedTeams) {
    const poolId = proposal[team.id];
    if (!poolId) continue;
    const list = byPool.get(poolId) ?? [];
    list.push(team);
    byPool.set(poolId, list);
  }

  const commit = async (): Promise<void> => {
    if (!cutoffValid) {
      onAnnounce(errorNotice('Choose exactly the available number of berths in every tied cutoff.'));
      return;
    }
    const result = controller.commitAdvancement({
      sourcePhaseId,
      targetPhaseId: target.id,
      assignments: selectedTeams
        .map((team) => ({ teamId: team.id, targetPoolId: proposal[team.id] ?? '' }))
        .filter((assignment) => assignment.targetPoolId !== ''),
      reason,
      previewBasisToken: preview.basisToken,
    });
    onAnnounce(result.committed ? infoNotice(result.message) : errorNotice(result.message));
  };

  const rule = source?.advancementRule;
  return (
    <div className="director-advancement-commit">
      <h3>Advance to {target.name}</h3>
      {(basisStatus === 'stale' || basisStatus === 'unknown') && (
        <Callout tone="warning" title="Previously committed advancement no longer verifies">
          {basisStatus === 'stale'
            ? 'The qualifying games, teams, pools, rule, or tiebreakers changed since the last commit. Recompute the preview and commit again rather than trusting the old placement.'
            : 'The last commit predates basis tracking, so it cannot be verified. Recompute the preview and commit again before downstream play.'}
        </Callout>
      )}
      {rule && (
        <p className="director-text-secondary">
          Top {rule.qualifiersPerPool} from each pool
          {(rule.wildcards ?? 0) > 0 ? ` · best ${rule.wildcards} remaining teams` : ''}. Placement changes
          are audited; results stay untouched.
        </p>
      )}
      <Field
        label="Target stage"
        render={({ id, labelId, describedBy }) => (
          <Select
            id={id}
            ariaLabelledBy={labelId}
            ariaDescribedBy={describedBy}
            value={target.id}
            options={targets.map((entry) => ({ value: entry.id, label: entry.name }))}
            onChange={(value) => {
              setTargetPhaseId(value);
              setMoves({});
            }}
          />
        )}
      />
      {cutoffDecisions.map((decision) => (
        <div className="director-inset" key={decision.key}>
          <h4>Resolve tied cutoff</h4>
          <p className="director-text-secondary">
            {decision.reason} Choose {decision.berthCount} team{decision.berthCount === 1 ? '' : 's'} to
            advance.
          </p>
          <div className="director-stack director-stack-tight">
            {decision.teamIds.map((teamId) => {
              const team = state.teams.find((entry) => entry.id === teamId);
              const checked = decision.selectedTeamIds.includes(teamId);
              const atLimit = decision.selectedTeamIds.length >= decision.berthCount;
              return (
                <Checkbox
                  key={teamId}
                  checked={checked}
                  disabled={!checked && atLimit}
                  label={team?.displayName ?? teamId}
                  onChange={(nextChecked) => {
                    setCutoffChoices((current) => {
                      const currentSelected =
                        advancementCutoffDecisions(preview, current).find(
                          (entry) => entry.key === decision.key,
                        )?.selectedTeamIds ?? [];
                      const nextSelected = nextChecked
                        ? [...currentSelected, teamId]
                        : currentSelected.filter((id) => id !== teamId);
                      return { ...current, [decision.key]: nextSelected };
                    });
                  }}
                />
              );
            })}
          </div>
        </div>
      ))}
      <div className="director-stack director-stack-tight">
        {targetPools.length > 0 ? (
          targetPools.map((pool) => (
            <div className="director-inset" key={pool.id}>
              <h4>{pool.name}</h4>
              <ul className="director-compact-list">
                {(byPool.get(pool.id) ?? []).map((team, index) => (
                  <li key={team.id}>
                    <span>
                      {index + 1}. {team.displayName}
                      {wildcardIds.has(team.id) ? ' (wildcard)' : ''}
                    </span>
                    <Select
                      ariaLabel={`Place ${team.displayName} in`}
                      value={proposal[team.id] ?? pool.id}
                      options={targetPools.map((option) => ({ value: option.id, label: option.name }))}
                      onChange={(value) => setMoves((current) => ({ ...current, [team.id]: value }))}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : (
          <div className="director-inset">
            <h4>{target.name} field</h4>
            <ul className="director-compact-list">
              {preview.qualifiers.map((team, index) => (
                <li key={team.id}>
                  {index + 1}. {team.displayName}
                  {wildcardIds.has(team.id) ? ' (wildcard)' : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {(needsReason || reason !== '') && (
        <Field
          label="Director decision"
          hint="Required when the cutoff is tied or placement differs from the preview."
        >
          <TextInput
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why this placement differs from the preview"
          />
        </Field>
      )}
      <Button
        variant="primary"
        disabled={!cutoffValid || (needsReason && reason.trim() === '')}
        onClick={() => void commit()}
      >
        Commit {selectedTeams.length} placements to {target.name}
      </Button>
    </div>
  );
}
