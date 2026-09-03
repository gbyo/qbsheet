import { useMemo, useState } from 'react';
import type { DirectorController } from '../state/useDirectorController';
import type { AdvancementPreview, DirectorState } from '../domain';
import type { AnnounceInput } from '../notices';
import { errorNotice, infoNotice } from '../notices';
import { Button, FormField } from '../components/Controls';

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
      <div className="director-panel-heading director-panel-heading-compact">
        <div>
          <p className="director-eyebrow">Rebracket</p>
          <h3>Advance to {target.name}</h3>
        </div>
      </div>
      {rule && (
        <p className="director-table-subtext">
          Top {rule.qualifiersPerPool} from each pool
          {(rule.wildcards ?? 0) > 0 ? ` · best ${rule.wildcards} remaining teams` : ''} · only placement
          changes, results stay untouched.
        </p>
      )}
      <FormField label="Target stage">
        <select
          value={target.id}
          onChange={(event) => {
            setTargetPhaseId(event.target.value);
            setMoves({});
          }}
        >
          {targets.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </FormField>
      {targetPools.map((pool) => (
        <div key={pool.id}>
          <h4>{pool.name}</h4>
          <ul className="director-compact-list">
            {(byPool.get(pool.id) ?? []).map((team, index) => (
              <li key={team.id}>
                {index + 1}. {team.displayName}
                {wildcardIds.has(team.id) ? ' (wildcard)' : ''}{' '}
                <select
                  aria-label={`Place ${team.displayName} in`}
                  value={proposal[team.id] ?? pool.id}
                  onChange={(event) => setMoves((current) => ({ ...current, [team.id]: event.target.value }))}
                >
                  {targetPools.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {(needsReason || reason !== '') && (
        <FormField
          label="Director decision"
          hint="Required when the cutoff is tied or a team is placed outside the preview."
        >
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why this placement differs from the preview"
          />
        </FormField>
      )}
      <Button variant="primary" onClick={commit}>
        Commit {preview.qualifiers.length} placements to {target.name}
      </Button>
    </div>
  );
}
