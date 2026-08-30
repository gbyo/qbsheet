/**
 * QBJ documents for tests, built the way a real producer builds them.
 *
 * The structure matters more than the values here. A tournament carries its phases, a phase carries
 * its rounds, a round carries its matches, and teams are referenced rather than embedded — because
 * that is the shape the reference implementation writes and reads, and a fixture that flattened it
 * would let a parser bug through.
 */
import { QbjObject } from '../src/qbj/QbjSerialization';
import { qbtcpExtensionKey, qbtcpExtensionVersion } from '../src/qbj/QbtcpExtension';

export interface IQbjTeamFixture {
  id: string;
  registrationId: string;
  name: string;
  players: { id: string; name: string }[];
}

export const ninetySix: IQbjTeamFixture = {
  id: 'Team_NinetySix',
  registrationId: 'Registration_NinetySix',
  name: 'Ninety Six',
  players: [
    { id: 'Player_Sarah', name: 'Sarah' },
    { id: 'Player_James', name: 'James' },
    { id: 'Player_Alex', name: 'Alex' },
    { id: 'Player_Taylor', name: 'Taylor' },
  ],
};

export const greenwood: IQbjTeamFixture = {
  id: 'Team_Greenwood',
  registrationId: 'Registration_Greenwood',
  name: 'Greenwood',
  players: [
    { id: 'Player_Emma', name: 'Emma' },
    { id: 'Player_Jordan', name: 'Jordan' },
    { id: 'Player_Morgan', name: 'Morgan' },
    { id: 'Player_Casey', name: 'Casey' },
  ],
};

export const clinton: IQbjTeamFixture = {
  id: 'Team_Clinton',
  registrationId: 'Registration_Clinton',
  name: 'Clinton',
  players: [
    { id: 'Player_Riley', name: 'Riley' },
    { id: 'Player_Quinn', name: 'Quinn' },
  ],
};

export const emerald: IQbjTeamFixture = {
  id: 'Team_Emerald',
  registrationId: 'Registration_Emerald',
  name: 'Emerald',
  players: [
    { id: 'Player_Sam', name: 'Sam' },
    { id: 'Player_Drew', name: 'Drew' },
  ],
};

/** ACF-with-powers scoring rules, as standard QBJ. */
export function acfPowersScoringRules(overrides: QbjObject = {}): QbjObject {
  return {
    type: 'ScoringRules',
    id: 'ScoringRules_ACF',
    name: 'ACF with powers',
    teams_per_match: 2,
    maximum_players_per_team: 4,
    regulation_tossup_count: 20,
    maximum_regulation_tossup_count: 20,
    minimum_overtime_question_count: 1,
    overtime_includes_bonuses: false,
    total_divisor: 5,
    maximum_bonus_score: 30,
    bonus_divisor: 10,
    minimum_parts_per_bonus: 3,
    maximum_parts_per_bonus: 3,
    points_per_bonus_part: 10,
    bonuses_bounce_back: false,
    answer_types: [
      {
        type: 'AnswerType',
        id: 'AnswerType_15',
        value: 15,
        label: 'Power',
        short_label: 'P',
        awards_bonus: true,
      },
      {
        type: 'AnswerType',
        id: 'AnswerType_10',
        value: 10,
        label: 'Correct',
        short_label: 'C',
        awards_bonus: true,
      },
      {
        type: 'AnswerType',
        id: 'AnswerType_-5',
        value: -5,
        label: 'Neg',
        short_label: 'N',
        awards_bonus: false,
      },
    ],
    ...overrides,
  };
}

function teamObject(team: IQbjTeamFixture): QbjObject {
  return {
    type: 'Team',
    id: team.id,
    name: team.name,
    players: team.players.map((player) => ({ type: 'Player', id: player.id, name: player.name })),
  };
}

function registrationObject(team: IQbjTeamFixture): QbjObject {
  return { type: 'Registration', id: team.registrationId, name: team.name, teams: [{ $ref: team.id }] };
}

export interface IMatchFixtureOptions {
  id: string;
  left: IQbjTeamFixture;
  right: IQbjTeamFixture;
  location?: string;
  /** Attach the operational extension. */
  qbtcp?: QbjObject;
  /** Extra fields, for making a match look played. */
  extra?: QbjObject;
}

export function matchObject(options: IMatchFixtureOptions): QbjObject {
  const match: QbjObject = {
    type: 'Match',
    id: options.id,
    ...(options.location ? { location: options.location } : {}),
    match_teams: [{ team: { $ref: options.left.id } }, { team: { $ref: options.right.id } }],
    ...options.extra,
  };
  if (options.qbtcp) {
    match[qbtcpExtensionKey] = { version: qbtcpExtensionVersion, ...options.qbtcp };
  }
  return match;
}

export interface IAssignmentOptions {
  tournamentId?: string;
  tournamentName?: string;
  scoringRules?: QbjObject | null;
  roundName?: string;
  roundNumber?: number;
  matches?: QbjObject[];
  teams?: IQbjTeamFixture[];
  version?: string;
  /**
   * Leave the non-standard `number` field off the Round.
   *
   * Standard QBJ has no such field; the reference implementation keeps its round number in a file
   * extension and writes the bare number as `Round.name`. Omitting it here is what a strictly
   * standard producer looks like.
   */
  omitRoundNumber?: boolean;
}

/**
 * A one-game assignment: one tournament, one phase, one round, one unplayed match.
 *
 * Deliberately carries no scores of any kind. An assignment that invented zeroes would be
 * indistinguishable from a game that finished nil-nil, which is exactly the signal an importer uses.
 */
export function assignmentDocument(options: IAssignmentOptions = {}): object {
  const teams = options.teams ?? [ninetySix, greenwood];
  const matches = options.matches ?? [
    matchObject({
      id: 'Match_sm-4471',
      left: teams[0],
      right: teams[1],
      location: 'Room 204',
      qbtcp: {
        round_revision: 3,
        room_id: 'room-204',
        handoff_instruction: 'Upload to the Round 4 folder.',
        scorekeeper: { timed: false },
      },
    }),
  ];
  const rules = options.scoringRules === null ? null : (options.scoringRules ?? acfPowersScoringRules());

  const round: QbjObject = {
    type: 'Round',
    id: `Round_${options.roundNumber ?? 4}`,
    // Numeric, as the reference implementation writes it. "Round 4" is a display string and lives
    // elsewhere; putting it here makes the round unresolvable on import.
    name: options.roundName ?? String(options.roundNumber ?? 4),
    ...(options.omitRoundNumber ? {} : { number: options.roundNumber ?? 4 }),
    matches: matches.map((match) => ({ $ref: match.id as string })),
  };

  const tournament: QbjObject = {
    type: 'Tournament',
    id: options.tournamentId ?? 'Tournament_spring-2026',
    name: options.tournamentName ?? 'Spring Invitational',
    ...(rules ? { scoring_rules: { $ref: rules.id as string } } : {}),
    registrations: teams.map((team) => ({ $ref: team.registrationId })),
    phases: [{ type: 'Phase', id: 'Phase_Prelims', name: 'Prelims', rounds: [round] }],
  };

  return {
    version: options.version ?? '2.1.1',
    objects: [
      tournament,
      ...(rules ? [rules] : []),
      ...teams.map(registrationObject),
      ...teams.map(teamObject),
      ...matches,
    ],
  };
}

/** The same team with its roster stripped, for the documents that name a team and list nobody. */
export function withoutRoster(team: IQbjTeamFixture): IQbjTeamFixture {
  return { ...team, players: [] };
}

/** A whole-tournament document: two rounds, four matches, one already played. */
export function tournamentDocument(): object {
  const teams = [ninetySix, greenwood, clinton, emerald];
  const rules = acfPowersScoringRules();

  const roundFour = [
    matchObject({
      id: 'Match_r4-101',
      left: ninetySix,
      right: clinton,
      location: 'Room 101',
      qbtcp: { scorekeeper: { timed: false } },
    }),
    matchObject({
      id: 'Match_r4-102',
      left: emerald,
      right: greenwood,
      location: 'Room 102',
      qbtcp: { scorekeeper: { timed: false } },
    }),
  ];
  const roundThree = [
    matchObject({
      id: 'Match_r3-101',
      left: ninetySix,
      right: greenwood,
      location: 'Room 101',
      qbtcp: { scorekeeper: { timed: false } },
      extra: {
        tossups_read: 20,
        match_teams: [
          { team: { $ref: ninetySix.id }, points: 315 },
          { team: { $ref: greenwood.id }, points: 240 },
        ],
      },
    }),
  ];

  return {
    version: '2.1.1',
    objects: [
      {
        type: 'Tournament',
        id: 'Tournament_spring-2026',
        name: 'Spring Invitational',
        scoring_rules: { $ref: rules.id as string },
        registrations: teams.map((team) => ({ $ref: team.registrationId })),
        phases: [
          {
            type: 'Phase',
            id: 'Phase_Prelims',
            name: 'Prelims',
            rounds: [
              {
                type: 'Round',
                id: 'Round_3',
                name: '3',
                number: 3,
                matches: roundThree.map((m) => ({ $ref: m.id as string })),
              },
              {
                type: 'Round',
                id: 'Round_4',
                name: '4',
                number: 4,
                matches: roundFour.map((m) => ({ $ref: m.id as string })),
              },
            ],
          },
        ],
      },
      rules,
      ...teams.map(registrationObject),
      ...teams.map(teamObject),
      ...roundThree,
      ...roundFour,
    ],
  };
}

/** A bare Match, the way MODAQ writes one: no envelope, teams embedded by name, `_round`. */
export function modaqMatchOnly(): object {
  return {
    tossups_read: 20,
    _round: 4,
    location: 'Room 204',
    match_teams: [
      {
        team: { name: 'Ninety Six', players: [{ name: 'Sarah' }, { name: 'James' }] },
        points: 315,
        match_players: [
          {
            player: { name: 'Sarah' },
            tossups_heard: 20,
            answer_counts: [{ number: 3, answer_type: { value: 15 } }],
          },
        ],
      },
      {
        team: { name: 'Greenwood', players: [{ name: 'Emma' }, { name: 'Jordan' }] },
        points: 240,
        match_players: [{ player: { name: 'Emma' }, tossups_heard: 20, answer_counts: [] }],
      },
    ],
  };
}
