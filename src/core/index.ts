/**
 * The browser-independent QBSheet scoring and game-file contract.
 *
 * This is the package entry point consumed by Fruity. The app in this repository is one consumer
 * of these modules; it is not a second implementation. Keep this barrel free of React, DOM and
 * persistence imports so a desktop host can use the exact same engine.
 */
export * from '../game/GameDefinition';
export * from '../game/GamePackage';
export * from '../game/GamePackageValidation';
export * from '../game/OpenGameDefinition';
export * from '../game/PortableQbj';
export * from '../game/Roster';

export * from '../qbj/AdvancedScoringRules';
export * from '../qbj/BasicScoringRules';
export * from '../qbj/ScoringRulesInput';
export * from '../qbj/ParseQbjAssignment';
export * from '../qbj/QbjResult';
export * from '../qbj/QbjScoringRules';
export * from '../qbj/QbjSerialization';
export * from '../qbj/QbtcpExtension';

/**
 * The protocol surface, exported so a tournament-control implementation can route on the same
 * table this scoresheet calls rather than hand-copying path strings into a server.
 */
export * from '../qbtcp/QbtcpRoutes';

export * from '../scoring/RoomProcedure';
export * from '../scoring/ScoreEvents';
export * from '../scoring/ScorekeeperFormat';
export * from '../scoring/ProtestNotes';
export * from '../scoring/types';
export * from '../scoring/canApplyScoreEvent';
export * from '../scoring/deriveGame';
export * from '../scoring/questionCorrection';
export * from '../scoring/toQbjMatch';
export * from '../scoring/validateScoresheet';
export * from '../scoring/SpreadsheetGame';

/*
 * Correcting the game itself, rather than what happened in it. A host that can score a game has to
 * be able to correct one — the rules it was set up with, the room's procedure, a team or player name
 * — and every one of these is a pure transformation over the same event history the engine derives
 * from. See `gameCorrection`.
 */
export * from '../scoring/ProcedureExceptions';
export * from '../scoring/gameCorrection';
export * from '../scoring/formatCorrection';
export * from '../scoring/identityCorrection';
export * from '../scoring/overtimeCorrection';
export * from '../scoring/procedureCorrection';
export { default as correctFormat } from '../scoring/formatCorrection';
export { default as correctProcedure } from '../scoring/procedureCorrection';
export { default as removeOvertime } from '../scoring/overtimeCorrection';

export * from '../scorer/ScorerRecovery';
export * from '../scorer/bonusOptions';

export { default as deriveGame } from '../scoring/deriveGame';
export { default as canApplyScoreEvent } from '../scoring/canApplyScoreEvent';
export { default as toQbjMatch } from '../scoring/toQbjMatch';
export { default as validateScoresheet } from '../scoring/validateScoresheet';
