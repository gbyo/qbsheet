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

/** The protocol-independent request data the scorer needs to display and retry. */
export interface IHelpRequestSummary {
  id?: string;
  category: HelpRequestCategory;
  message: string;
  createdAt?: string;
  updatedAt?: string;
}

/** A normalized outcome of asking tournament control to come to this room. */
export type HelpRequestResult =
  | { kind: 'accepted'; request: IHelpRequestSummary }
  | { kind: 'already-outstanding'; request: IHelpRequestSummary }
  | { kind: 'unreachable'; error: string }
  | { kind: 'unsupported'; error: string }
  | { kind: 'server-error'; status?: number; error: string }
  | { kind: 'refused'; status: number; error: string; retryable: boolean };

/** A normalized answer to the low-volume GET `/help` reconciliation. */
export type HelpReadResult =
  | { kind: 'idle' }
  | { kind: 'outstanding'; request: IHelpRequestSummary }
  | { kind: 'unavailable'; error: string }
  | Exclude<HelpRequestResult, { kind: 'accepted' | 'already-outstanding' }>;

/** A normalized answer to an explicit DELETE/withdrawal. */
export type HelpClearResult =
  | { kind: 'cleared' }
  | { kind: 'idle' }
  | Exclude<HelpRequestResult, { kind: 'accepted' | 'already-outstanding' }>;

/** Facts the live room can show about its one active summons. */
export type ControlRequestState =
  | { kind: 'unavailable'; error?: string }
  | { kind: 'idle' }
  | { kind: 'sending'; category: HelpRequestCategory; message: string }
  | {
      kind: 'outstanding';
      request: IHelpRequestSummary;
      requestedAt: string;
      requestedAtSource: 'server' | 'device';
      /** False only after this server explicitly says its help lifecycle has no DELETE route. */
      canCancel?: boolean;
    }
  | {
      kind: 'failed';
      category: HelpRequestCategory;
      message: string;
      error: string;
      retryable: boolean;
    }
  | {
      kind: 'refused';
      category: HelpRequestCategory;
      message: string;
      error: string;
      status?: number;
      retryable: boolean;
    }
  | { kind: 'unsupported'; error: string };
