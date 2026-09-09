import { writeFileSync } from 'node:fs';

import * as GameFormats from 'src/state/GameFormats';
import { GameState } from 'src/state/GameState';
import { Bonus, PacketState, Tossup } from 'src/state/PacketState';
import { Player } from 'src/state/TeamState';
import * as QBJ from 'src/qbj/QBJ';

const outputPath = process.argv[2];
if (!outputPath) throw new Error('Usage: generator <output-path>');

const packet = new PacketState();
packet.setTossups([
  new Tossup('first tossup (*) power marker', 'first answer'),
  new Tossup('second tossup', 'second answer'),
  new Tossup('overtime tossup', 'overtime answer'),
]);
packet.setBonuses([
  new Bonus('first bonus', [
    { question: 'part 1', answer: 'answer 1', value: 10 },
    { question: 'part 2', answer: 'answer 2', value: 10 },
    { question: 'part 3', answer: 'answer 3', value: 10 },
  ]),
  new Bonus('second bonus', [
    { question: 'part 1', answer: 'answer 1', value: 10 },
    { question: 'part 2', answer: 'answer 2', value: 10 },
    { question: 'part 3', answer: 'answer 3', value: 10 },
  ]),
  new Bonus('overtime bonus', [
    { question: 'part 1', answer: 'answer 1', value: 10 },
    { question: 'part 2', answer: 'answer 2', value: 10 },
    { question: 'part 3', answer: 'answer 3', value: 10 },
  ]),
]);

const left = new Player('Ninety Six A player 1', 'Ninety Six A', true);
const leftSub = new Player('Ninety Six A player 2', 'Ninety Six A', false);
const right = new Player('Greenwood A player 1', 'Greenwood A', true);
const game = new GameState();
game.loadPacket(packet);
game.setPlayers([left, leftSub, right]);
const format = { ...GameFormats.StandardPowersMACFGameFormat, regulationTossupCount: 2 };
game.setGameFormat(format);

const first = game.cycles[0];
first.addCorrectBuzz({ player: left, points: 15, position: 2 }, 0, format, 0, 3);
first.setBonusPartAnswer(0, left.teamName, 10);
first.setBonusPartAnswer(1, left.teamName, 10);

const second = game.cycles[1];
second.addWrongBuzz({ player: right, points: -5, position: 1, isLastWord: false }, 1, format);
second.addCorrectBuzz({ player: left, points: 10, position: 3 }, 1, format, 1, 3);
second.setBonusPartAnswer(0, left.teamName, 10);

const overtime = game.cycles[2];
overtime.addCorrectBuzz({ player: right, points: 10, position: 1 }, 2, format, 2, 3);

const match = QBJ.toQBJ(game, 'Packet 5.pdf', 5);
writeFileSync(outputPath, `${JSON.stringify(match, null, 2)}\n`);
