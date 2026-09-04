import ScorerDialog from '../ScorerDialog';
import { IDerivedGame } from '../../scoring/deriveGame';
import { buildLabel } from '../../pwa/BuildVersion';
import { IScorekeeperFormat } from '../../scoring/ScorekeeperFormat';
import { powerCorrect } from '../tossupRulings';

export default function SecretPanel({
  game,
  format,
  discoveries,
  onClose,
}: {
  game: IDerivedGame;
  format: IScorekeeperFormat;
  discoveries: number;
  onClose: () => void;
}) {
  const buzzes = game.questions.flatMap((question) => question.buzzes);
  const powerIndex = powerCorrect(format)?.index;
  return (
    <ScorerDialog title="You found it." onClose={onClose}>
      <p className="scorer-dialog-note">A little curiosity goes a long way. So does a good scorekeeper.</p>
      <h3 className="secret-stats-heading">This game</h3>
      <dl className="secret-stats">
        <div>
          <dt>Tossups read</dt>
          <dd>{game.tossupsRead}</dd>
        </div>
        <div>
          <dt>Powers</dt>
          <dd>{buzzes.filter((buzz) => buzz.answerType.index === powerIndex).length}</dd>
        </div>
        <div>
          <dt>Negs</dt>
          <dd>{buzzes.filter((buzz) => buzz.answerType.isNeg).length}</dd>
        </div>
      </dl>
      <p className="scorer-dialog-note">
        These are the current game’s recorded totals, including corrections.
      </p>
      <dl className="secret-stats">
        <div>
          <dt>Secrets discovered on this device</dt>
          <dd>{discoveries} / ?</dd>
        </div>
        <div>
          <dt>QBSheet version</dt>
          <dd>{buildLabel()}</dd>
        </div>
      </dl>
    </ScorerDialog>
  );
}
