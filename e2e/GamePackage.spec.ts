import { expect, test, type Page } from '@playwright/test';
import { encodePortableGameSetup } from '../src/game/PortableGameSetup';
import { portableInput } from '../tests/portableSetupFixtures';

async function camera(page: Page, text: string) {
  await page.addInitScript((payload) => {
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      canvas.getContext('2d')!.fillRect(0, 0, 320, 240);
      return canvas.captureStream(5);
    };
    (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = class {
      static async getSupportedFormats() {
        return ['qr_code'];
      }
      async detect() {
        return [{ rawValue: payload }];
      }
    };
  }, text);
}

test('standalone creator opens separately, restores its draft, and downloads a working SVG', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  // The creator lives behind the Advanced row, with the other infrequent device-level actions.
  await page
    .getByRole('dialog', { name: 'Settings', exact: true })
    .getByRole('button', { name: 'Advanced', exact: true })
    .click();
  const advanced = page.getByRole('dialog', { name: 'Advanced', exact: true });
  const popupPromise = page.waitForEvent('popup');
  await advanced.getByRole('link', { name: 'Open game package creator' }).click();
  const creator = await popupPromise;
  await expect(creator.getByRole('heading', { name: 'Game package creator' })).toBeVisible();
  // A separate tab, so the Settings dialog this was opened from is untouched behind it.
  await expect(advanced).toBeVisible();
  const input = portableInput();
  await creator.getByLabel('Left team name').fill(input.left.name);
  await creator.getByLabel(`${input.left.name} players`, { exact: true }).fill(input.left.players);
  await creator.getByLabel('Right team name').fill(input.right.name);
  await creator.getByLabel(`${input.right.name} players`, { exact: true }).fill(input.right.players);
  await expect
    .poll(() => creator.evaluate(() => localStorage.getItem('qbsheet.game-package-creator-draft.v1')))
    .toContain(input.left.name);
  await creator.reload();
  await expect(creator.getByLabel('Left team name')).toHaveValue(input.left.name);
  await creator.getByRole('button', { name: 'Generate package' }).click();
  await expect(creator.getByRole('img', { name: 'Game setup QR code' })).toBeVisible();
  const downloadPromise = creator.waitForEvent('download');
  await creator.getByRole('link', { name: 'Download SVG' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('qbsheet-game-setup.svg');
  expect(await download.failure()).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('qbsheet.manual-game-draft.v1'))).toBeNull();
  await creator.screenshot({ path: 'test-results/game-package-creator.png', fullPage: true });
});

test('a scan is a modal review, cancel creates nothing, and Edit fills the normal form', async ({ page }) => {
  const encoded = encodePortableGameSetup(portableInput(true));
  if (!encoded.ok) throw new Error(encoded.message);
  await camera(page, encoded.text);
  await page.goto('/');
  await page.getByRole('button', { name: 'Scan QR' }).click();
  let review = page.getByRole('dialog', { name: 'Review game package' });
  await expect(review).toBeVisible();
  await expect(review).toContainText('Nothing has been created yet');
  await expect(review).toContainText('Bench player');
  await review.getByRole('button', { name: 'Cancel' }).click();
  await page.reload();
  expect(await page.evaluate(() => localStorage.getItem('qbsheet.manual-game-draft.v1'))).toBeNull();
  await page.getByRole('button', { name: 'Scan QR' }).click();
  review = page.getByRole('dialog', { name: 'Review game package' });
  await review.getByRole('button', { name: 'Edit setup' }).click();
  await expect(page.getByRole('heading', { name: 'Create a game' })).toBeVisible();
  await expect(page.getByLabel('Left team name')).toHaveValue(portableInput().left.name);
});

test('malformed portable payload keeps the real scanner open with an error', async ({ page }) => {
  await camera(page, 'QBSHEET-SETUP:1:!');
  await page.goto('/');
  await page.getByRole('button', { name: 'Scan QR' }).click();
  const scanner = page.getByRole('dialog', { name: 'Scan tournament QR code' });
  await expect(scanner).toBeVisible();
  await expect(scanner).toContainText('This game package is invalid');
  await expect(page.getByRole('dialog', { name: 'Review game package' })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('qbsheet.manual-game-draft.v1'))).toBeNull();
});
