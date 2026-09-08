import { useMemo, useState } from 'react';
import type { DirectorController } from '../state/useDirectorController';
import type { AdvancementPreview, DirectorState } from '../domain';
import type { AnnounceInput } from '../notices';
import { errorNotice, infoNotice } from '../notices';
import { Button, Field, Select, TextInput } from '../components';

/**
 * Manual rebracketing: the preview proposes where each qualifier goes, the
 * director can move teams between playoff pools, and committing writes plain
 * pool membership plus an audit record. Game results are never rewritten;
 * placement changes are explicit and audited.
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
  const wildcardIds = useMemo(() => new Set(preview.wildcards.map((team) => team.id)), [preview]);
  const proposal = useMemo(() => {
    const next: Record<string, string> = {};
    preview.qualifiers.forEach((team, index) => {
      const pool = targetPools.length > 0 ? targetPools[index % targetPools.length] : undefined;
      if (pool) next[team.id] = moves[team.id] ?? pool.id;
    });
    return next;
  }, [preview, targetPools, moves]);

  if (targets.length === 0 || !target || targetPools.length === 0) return null;

  const qualifierIds = new Set(preview.qualifiers.map((team) => team.id));
  const movedOutside = Object.keys(moves).filter((teamId) => !qualifierIds.has(teamId));
  const needsReason = preview.unresolved.length > 0 || movedOutside.length > 0;
  const byPool = new Map<string, typeof preview.qualifiers>();
  for (const team of preview.qualifiers) {
    const poolId = proposal[team.id];
    if (!poolId) continue;
    const list = byPool.get(poolId) ?? [];
    list.push(team);
    byPool.set(poolId, list);
  }

  const commit = (): void => {
    const result = controller.commitAdvancement({
      sourcePhaseId,
      targetPhaseId: target.id,
      assignments: preview.qualifiers
        .map((team) => ({ teamId: team.id, targetPoolId: proposal[team.id] ?? '' }))
        .filter((assignment) => assignment.targetPoolId !== ''),
      reason,
    });
    onAnnounce(result.committed ? infoNotice(result.message) : errorNotice(result.message));
  };

  const rule = source?.advancementRule;
  return (
    <div className="director-advancement-commit">
      <h3>Advance to {target.name}</h3>
      {rule && (
        <p className="director-text-secondary">
          Top {rule.qualifiersPerPool} from each pool
          {(rule.wildcards ?? 0) > 0 ? ` · best ${rule.wildcards} remaining teams` : ''}. Placement changes are audited; results stay untouched.
        </p>
      )}
      <Field
        label="Target stage"
        render={({ id, describedBy }) => (
          <Select
            id={id}
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
      <div className="director-stack director-stack-tight">
        {targetPools.map((pool) => (
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
        ))}
      </div>
      {(needsReason || reason !== '') && (
        <Field label="Director decision" hint="Required when the cutoff is tied or placement differs from the preview.">
          <TextInput value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why this placement differs from the preview" />
        </Field>
      )}
      <Button variant="primary" onClick={commit}>
        Commit {preview.qualifiers.length} placements to {target.name}
      </Button>
    </div>
  );
}
