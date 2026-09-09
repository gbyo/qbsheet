import { recommendTournamentPlan, type TournamentPlanRecommendation } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import type { DirectorState } from '../domain';
import type { SectionId } from '../app/navigation';
import { Button, FactList, Panel } from '../components';
import { errorNotice, infoNotice, type AnnounceInput } from '../notices';

/**
 * A planner recommendation shown only while it can still be applied cleanly.
 * It is intentionally one concise recommendation surface; the selected format
 * itself is edited in the normal configuration section below it.
 */
export function RecommendedPlan({
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
  const activeTeamCount = state.teams.filter((team) => team.status === 'confirmed').length;
  const planApplicable =
    state.rounds.every((round) => round.status === 'planned') && state.scheduledGames.length === 0;
  const planSet = activeTeamCount >= 2 && planApplicable ? recommendTournamentPlan(activeTeamCount) : null;
  if (!planSet) return null;

  const apply = (plan: TournamentPlanRecommendation): void => {
    if (!controller.applyTournamentPlan(plan)) {
      onAnnounce(
        errorNotice(
          'That plan no longer applies: rounds or pairings already exist. Edit the structure directly.',
        ),
      );
      return;
    }
    const rounds = plan.stages.reduce((total, stage) => total + stage.roundNumbers.length, 0);
    onAnnounce(
      infoNotice(
        rounds > 0
          ? `Applied ${plan.title}: ${rounds} round${rounds === 1 ? '' : 's'} created. Pairings, pools, and stages remain editable.`
          : `Applied ${plan.title}. Add rounds when ready; pairings stay under your control.`,
      ),
    );
    onNavigate('schedule');
  };

  const { recommended, alternatives } = planSet;
  return (
    <Panel
      title={recommended.title}
      description={recommended.summary}
      tone="info"
      actions={
        <Button variant="primary" onClick={() => apply(recommended)}>
          Use recommended plan
        </Button>
      }
    >
      <FactList items={recommended.consequences} />
      {alternatives.length > 0 && (
        <div className="director-actions director-format-alternatives">
          <span className="director-text-meta">Other suitable formats:</span>
          {alternatives.map((alternative) => (
            <Button
              key={alternative.id}
              variant="quiet"
              onClick={() => apply(alternative)}
              title={alternative.summary}
            >
              {alternative.title}
            </Button>
          ))}
        </div>
      )}
    </Panel>
  );
}
