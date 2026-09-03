import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const allTestFiles = ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'];

// These tests exercise pure scoring/model/protocol code and do not need a browser. Keeping this list
// explicit is deliberate: a number of non-React `.test.ts` files still exercise localStorage,
// IndexedDB, or other browser behaviour and must stay in the jsdom project.
const nodeTestFiles = [
  'tests/AdvancedFromFormat.test.ts',
  'tests/FormatCorrection.test.ts',
  'tests/FormatDrivenProperty.test.ts',
  'tests/GameFormatSummary.test.ts',
  'tests/GamePackage.test.ts',
  'tests/GameRecordUpgrade.test.ts',
  'tests/ManualGameDefinition.test.ts',
  'tests/ManualGameIdentity.test.ts',
  'tests/PortableQbj.test.ts',
  'tests/PracticeScenario.test.ts',
  'tests/QbjAssignment.test.ts',
  'tests/QbjScoringRulesMalformed.test.ts',
  'tests/Qbtcp.test.ts',
  'tests/RoomDeriveGame.test.ts',
  'tests/RoomGameCorrection.test.ts',
  'tests/RoomGameProperty.test.ts',
  'tests/RoomGameStateSpace.test.ts',
  'tests/RoomLineupEditing.test.ts',
  'tests/RoomLineupMotion.test.ts',
  'tests/RoomNaqtParity.test.ts',
  'tests/RoomProcedureAndProtests.test.ts',
  'tests/RoomProcedureExceptions.test.ts',
  'tests/RoomProcedureState.test.ts',
  'tests/RoomQuestionCorrection.test.ts',
  'tests/RoomScoreEventGuard.test.ts',
  'tests/RoomScorerBonusOptions.test.ts',
  'tests/RoomScoresheetValidation.test.ts',
  'tests/RoomTableSeating.test.ts',
  'tests/Roster.test.ts',
  'tests/ScoringRulesInput.test.ts',
  'tests/SpreadsheetGame.test.ts',
  // The CI change-impact classifier. Pure path and lockfile analysis, so it wants no browser.
  'tests/ci/impact.test.ts',
  // The QBSheet Live demo backend. A Node HTTP server and a projection, so no browser — and `.mjs`
  // because it tests the script as `node` runs it rather than a compiled copy of it.
  'scripts/qblive-demo/*.test.mjs',
];

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    css: false,
    // Worker threads avoid the process-startup cost of Vitest's default fork pool. Vitest gives
    // each file its own module registry and its own jsdom, so anything jsdom defines is per file.
    // What threads do share is the process, and therefore any global Node supplies that jsdom does
    // not: `BroadcastChannel` is the one that matters, because Node's reaches every worker in the
    // process and the duplicate-tab guard would read the rest of the suite as rival tabs. It is
    // replaced with a realm-local one in `tests/broadcastChannel.ts`.
    pool: 'threads',
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: nodeTestFiles,
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          // jsdom refuses `localStorage` on an opaque origin, and the journal every scored question
          // is written to lives there. Without a real origin the tests would exercise a browser that
          // cannot save, which is a case worth testing deliberately and not by accident.
          environmentOptions: { jsdom: { url: 'https://example.org/scoresheet/' } },
          setupFiles: ['./tests/setup.ts'],
          // Engine tests live next to the engine; application and integration tests live in `tests/`.
          // Pure tests are excluded because the Node project above already runs them more cheaply.
          include: allTestFiles,
          exclude: nodeTestFiles,
        },
      },
    ],
  },
});
