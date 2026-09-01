/**
 * Answering the question a new game opens with.
 *
 * Every genuinely new game asks which scoring layout to use — see `scoringLayoutPrompt` — and almost
 * nothing in these specs is about that question. In a real browser the chooser is a modal `<dialog>`
 * that makes the page behind it inert, so unlike the jsdom suites this cannot simply be ignored.
 *
 * Tolerant of its absence on purpose: a recovered game, a game already in progress, and a game this
 * device has already been asked about all skip the question, and a spec that walks one of those
 * routes should not have to know which.
 */
import { expect, type Page } from '@playwright/test';

export type ScoringLayoutName = 'Scoresheet' | 'Table';

export async function chooseScoringLayout(
  page: Page,
  layout: ScoringLayoutName = 'Scoresheet',
): Promise<void> {
  const chooser = page.getByRole('dialog', { name: 'Choose a scoring layout' });
  // Short, because it is drawn with the scoresheet rather than fetched: either it is there in the
  // same frame or this game was never going to ask.
  const asked = await chooser
    .waitFor({ state: 'visible', timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  if (!asked) return;
  await chooser.getByRole('radio', { name: layout, exact: true }).click();
  await expect(chooser).toBeHidden();
}
