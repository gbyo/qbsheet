/**
 * The browser-independent QBSheet scoring and game-file contract.
 *
 * This is the package entry point consumed by Fruity. The app in this repository is one consumer
 * of these modules; it is not a second implementation. Keep this barrel free of React, DOM and
 * persistence imports so a desktop host can use the exact same engine.
 */
export * from '../game/GamePackage';
export * from '../game/GamePackageValidation';
export * from '../game/PortableQbj';
export * from '../game/Roster';

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

export * from '../scorer/ScorerRecovery';
export * from '../scorer/bonusOptions';

export { default as deriveGame } from '../scoring/deriveGame';
export { default as canApplyScoreEvent } from '../scoring/canApplyScoreEvent';
export { default as toQbjMatch } from '../scoring/toQbjMatch';
export { default as validateScoresheet } from '../scoring/validateScoresheet';
