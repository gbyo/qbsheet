import { recommendTournamentPlan, type TournamentPlanRecommendation } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import type { DirectorState } from '../domain';
import type { SectionId } from '../app/navigation';
import { Button, PanelBody } from '../components/Controls';
import { errorNotice, infoNotice, type AnnounceInput } from '../notices';

/**
 * The "Use this plan" panel. Recommendations come from the shared
 * formatPlan-based planner, never from a React-side pairing engine; applying
 * one materializes ordinary phases, pools, and rounds the TD can then edit.
 * It only appears while a plan can still be applied cleanly (no rounds past
 * planned, no pairings generated yet).
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
  /*
   * Count the teams the pairing engine will actually accept.
   *
   * A recommendation sized on every non-dropped team offered a plan for ten waitlisted teams
   * that the canonical scheduler then refused to pair, because it schedules confirmed teams
   * only. The plan and the pairings now agree about who is playing.
   */
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
    <section
      className="director-panel director-format-recommendation"
      aria-labelledby="recommended-plan-title"
    >
      <PanelBody>
        <p className="director-eyebrow">Recommended</p>
        <h2 id="recommended-plan-title">{recommended.title}</h2>
        <p>{recommended.summary}</p>
        <ul>
          {recommended.consequences.map((consequence) => (
            <li key={consequence}>{consequence}</li>
          ))}
        </ul>
        <Button variant="primary" icon="play" onClick={() => apply(recommended)}>
          Use this plan
        </Button>
        {alternatives.length > 0 && (
          <>
            <h3>Other formats</h3>
            <ul>
              {alternatives.map((alternative) => (
                <li key={alternative.id}>
                  <strong>{alternative.title}.</strong> {alternative.summary}{' '}
                  <Button variant="secondary" onClick={() => apply(alternative)}>
                    Use {alternative.title.toLowerCase()}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </PanelBody>
    </section>
  );
}
