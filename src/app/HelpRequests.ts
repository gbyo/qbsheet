/**
 * What a room can ask tournament control for without leaving the scoresheet.
 *
 * The categories exist so control sees a queue it can triage rather than a list of free text, and
 * the labels are the words a scorekeeper would use. The values are wire-compatible with the
 * tournament server's own help-request categories, because a connected room's request goes straight
 * there; a room scoring from a file has nowhere to send one, and the control panel is not offered.
 */
export type HelpRequestCategory =
  | 'wrong-matchup'
  | 'team-missing'
  | 'protest'
  | 'question-packet'
  | 'roster-change'
  | 'equipment-technical'
  | 'rules-question'
  | 'scoring-problem'
  | 'device-network'
  | 'wrong-room'
  | 'other';

export const helpRequestCategoryLabels: Record<HelpRequestCategory, string> = {
  'wrong-matchup': 'Wrong matchup',
  'team-missing': "Team hasn't arrived",
  protest: 'Protest / disputed ruling',
  'question-packet': 'Question / packet issue',
  'roster-change': 'Roster change',
  'equipment-technical': 'Equipment / technical issue',
  'rules-question': 'Rules question',
  'scoring-problem': 'Scoring problem',
  'device-network': 'Device/network problem',
  'wrong-room': 'Wrong room',
  other: 'Other',
};
