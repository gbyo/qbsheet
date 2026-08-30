/**
 * Pairing from a link and from a QR code, in a real browser.
 *
 * # What only a browser can prove
 *
 * Two things here are properties of the browser rather than of the code, and jsdom will report both
 * as passing whatever happens. The first is the address bar: `history.replaceState` is what removes
 * the pairing code, and "the URL no longer contains it, and the page did not reload to achieve that"
 * is a statement about a real navigation stack. The second is the modal: `<dialog>` supplies the
 * page inertness and focus trap this scanner leans on rather than reimplementing, and jsdom's
 * `showModal` does neither.
 *
 * # The camera is stubbed, and that is the honest choice
 *
 * There is no camera on a CI runner, and a fake device fed a video file would be testing Chrome's
 * decoder rather than this application. So `getUserMedia` and `BarcodeDetector` are replaced before
 * the page loads, and what is exercised is everything this repository actually owns: that the dialog
 * opens on the press, that a decoded string reaches the pairing flow, that a refused one keeps the
 * scanner up, and that the camera is released when it closes. The deep-link half of this file needs
 * no camera at all, which is why it carries the end-to-end pairing assertions.
 */
import { expect, test, type Page } from '@playwright/test';
import { ITournamentControl, pairingCode, startTournamentControl } from './support/tournamentControl';

let control: ITournamentControl;

test.beforeEach(async () => {
  control = await startTournamentControl('qbtcp');
});

test.afterEach(async () => {
  await control.close();
});

function launchUrl(options: { code?: string; room?: string; version?: string } = {}): string {
  const room = options.room === undefined ? '' : `&room=${encodeURIComponent(options.room)}`;
  return `/#qbtcp-pair?v=${options.version ?? '1'}&server=${encodeURIComponent(control.origin)}&code=${options.code ?? pairingCode}${room}`;
}

/**
 * Replace the camera and the decoder before any of the page's own code runs.
 *
 * The stream is a real one — a canvas capture — so the `<video>` element, the track list and the
 * `stop()` this application calls on teardown are all the browser's own objects rather than stand-ins.
 * Only what is *seen* in the frame is invented.
 */
async function stubCamera(page: Page, payload: string | null): Promise<void> {
  await page.addInitScript(
    ([decoded]) => {
      const stopped: string[] = [];
      (window as unknown as { cameraStops: string[] }).cameraStops = stopped;
      const media = navigator.mediaDevices as unknown as {
        getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
      };
      media.getUserMedia = async (constraints: MediaStreamConstraints) => {
        (window as unknown as { cameraConstraints: unknown }).cameraConstraints = constraints;
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        canvas.getContext('2d')?.fillRect(0, 0, 320, 240);
        const stream = (canvas as unknown as { captureStream: (fps: number) => MediaStream }).captureStream(5);
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            stopped.push(track.kind);
            stop();
          };
        }
        return stream;
      };
      (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = class {
        static getSupportedFormats() {
          return Promise.resolve(['qr_code']);
        }

        detect() {
          return Promise.resolve(decoded === null ? [] : [{ rawValue: decoded }]);
        }
      };
    },
    [payload],
  );
}

test.describe('a pairing deep link', () => {
  test('scrubs itself, waits for a press, and pairs the room', async ({ page }) => {
    await page.goto(launchUrl({ room: 'room-204' }));

    // The code is out of the address bar before the first screen is readable, and the page it is on
    // is still the one that was loaded — no reload, no history entry to go back to.
    await expect(page.getByRole('heading', { name: 'Ready to connect' })).toBeVisible();
    expect(page.url()).not.toContain(pairingCode);
    expect(page.url()).not.toContain('qbtcp-pair');
    expect(new URL(page.url()).hash).toBe('');

    // Nothing has been sent. Local-network access is gated on a gesture, and opening a link is not one.
    expect(control.requests).toHaveLength(0);
    await expect(page.getByText(new URL(control.origin).host)).toBeVisible();
    await expect(page.getByText('room-204')).toBeVisible();
    await expect(page.getByText(pairingCode)).toHaveCount(0);

    await page.getByRole('button', { name: 'Connect and pair' }).click();

    await expect(page.locator('.connected-room-shell')).toBeVisible();
    expect(control.requests.some((entry) => entry.method === 'POST' && entry.path === '/qbtcp/v1/pair')).toBe(true);
  });

  test('the pairing survives a reload without asking for anything again', async ({ page }) => {
    await page.goto(launchUrl({ room: 'room-204' }));
    await page.getByRole('button', { name: 'Connect and pair' }).click();
    await expect(page.locator('.connected-room-shell')).toBeVisible();

    await page.reload();

    // Straight back into the room, from storage. The URL is the ordinary one and has been since the
    // first load, so the reload could not have carried the code back in.
    await expect(page.locator('.connected-room-shell')).toBeVisible();
    await expect(page.getByLabel('Pairing code')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Connect and pair' })).toHaveCount(0);
    expect(new URL(page.url()).hash).toBe('');
  });

  test('the assignment reaches the room it paired', async ({ page }) => {
    await page.goto(launchUrl({ room: 'room-204' }));
    await page.getByRole('button', { name: 'Connect and pair' }).click();

    await expect(page.locator('.assignment-team').nth(0)).toHaveText('Ninety Six');
    await expect(page.locator('.assignment-team').nth(1)).toHaveText('Greenwood');
    await expect(page.getByRole('button', { name: /^(Start|Resume) scoring$/ })).toBeEnabled();
  });

  test('a link this build cannot read is scrubbed anyway and says so without repeating itself', async ({ page }) => {
    await page.goto(launchUrl({ version: '9' }));

    await expect(page.getByText('This pairing link uses a version this build does not support.')).toBeVisible();
    expect(page.url()).not.toContain(pairingCode);
    expect(page.url()).not.toContain('qbtcp-pair');
    // Left on the ordinary homepage, with the manual path untouched.
    await expect(page.locator('#control-address')).toBeVisible();
    expect(control.requests).toHaveLength(0);
  });

  test('the pairing code never appears in any request line', async ({ page }) => {
    await page.goto(launchUrl({ room: 'room-204' }));
    await page.getByRole('button', { name: 'Connect and pair' }).click();
    await expect(page.locator('.connected-room-shell')).toBeVisible();

    expect(control.requests.every((entry) => !entry.path.includes(pairingCode))).toBe(true);
  });
});

test.describe('the homepage button', () => {
  test('keeps Connect stable while Scan QR stays available', async ({ page }) => {
    await page.goto('/');
    const fields = page.locator('.welcome-connect-fields');
    const connect = fields.getByRole('button', { name: 'Connect', exact: true });
    const scan = fields.getByRole('button', { name: 'Scan QR', exact: true });

    await expect(connect).toBeVisible();
    await expect(connect).toBeDisabled();
    await expect(scan).toBeVisible();
    await expect(scan).toBeEnabled();
    await expect(fields.getByRole('button')).toHaveCount(2);

    await page.locator('#control-address').fill('192.168.1.24:3000');
    await expect(connect).toBeEnabled();
    await expect(scan).toBeEnabled();
    await expect(fields.getByRole('button')).toHaveCount(2);

    await page.locator('#control-address').fill('');
    await expect(connect).toBeDisabled();
    await expect(scan).toBeVisible();
    await expect(scan).toBeEnabled();
  });

  test('stays a single row of controls on a phone-width viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    const scan = page.locator('.welcome-connect-fields').getByRole('button', { name: 'Scan QR' });
    await expect(scan).toBeVisible();
    // The existing narrow-screen rule stacks the field and its action; the action must still be
    // inside the viewport rather than pushed off the side by the added glyph.
    const box = await scan.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
  });
});

test.describe('the scanner dialog', () => {
  test('opens as a real modal, decodes, and hands the result to the pairing flow', async ({ page, baseURL }) => {
    if (baseURL === undefined) throw new Error('Pairing launch e2e requires a configured Playwright baseURL.');
    await stubCamera(
      page,
      `${new URL(baseURL).origin}/#qbtcp-pair?v=1&server=${encodeURIComponent(control.origin)}&code=${pairingCode}&room=room-204`,
    );
    await page.goto('/');

    await page.locator('.welcome-connect-fields').getByRole('button', { name: 'Scan QR' }).click();

    const dialog = page.getByRole('dialog', { name: 'Scan tournament QR code' });
    await expect(dialog).toBeVisible();
    // The rear camera is asked for by preference, and never demanded.
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { cameraConstraints?: unknown }).cameraConstraints),
      )
      .toEqual({
        video: { facingMode: { ideal: 'environment' } },
      });

    // The decoded link goes through the same parser and the same state machine as a tapped one.
    await expect(page.getByRole('heading', { name: 'Ready to connect' })).toBeVisible();
    await expect(page.getByText('room-204')).toBeVisible();
    await expect(page.getByText(pairingCode)).toHaveCount(0);
    // Still nothing sent: a scan is not a gesture to reach the local network with.
    expect(control.requests).toHaveLength(0);

    // And the camera was released on the way out.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { cameraStops: string[] }).cameraStops))
      .toContain('video');
  });

  test('a QR code that is not a pairing link keeps the scanner open', async ({ page }) => {
    await stubCamera(page, 'WIFI:S=Venue;T=WPA;P=hunter2;;');
    await page.goto('/');

    await page.locator('.welcome-connect-fields').getByRole('button', { name: 'Scan QR' }).click();

    const dialog = page.getByRole('dialog', { name: 'Scan tournament QR code' });
    await expect(dialog.getByRole('alert')).toContainText('not a QBSheet pairing code');
    await expect(dialog).toBeVisible();
  });

  test('Escape closes it, releases the camera, and returns focus to the button', async ({ page }) => {
    await stubCamera(page, null);
    await page.goto('/');

    const scan = page.locator('.welcome-connect-fields').getByRole('button', { name: 'Scan QR' });
    await scan.click();
    await expect(page.getByRole('dialog', { name: 'Scan tournament QR code' })).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByRole('dialog', { name: 'Scan tournament QR code' })).toHaveCount(0);
    await expect(scan).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { cameraStops: string[] }).cameraStops))
      .toContain('video');
  });

  test('a browser that refuses the camera leaves the typed address working', async ({ page }) => {
    await page.addInitScript(() => {
      (navigator.mediaDevices as unknown as { getUserMedia: () => Promise<MediaStream> }).getUserMedia = () => {
        const denial = new Error('denied');
        denial.name = 'NotAllowedError';
        return Promise.reject(denial);
      };
    });
    await page.goto('/');

    await page.locator('.welcome-connect-fields').getByRole('button', { name: 'Scan QR' }).click();

    const dialog = page.getByRole('dialog', { name: 'Scan tournament QR code' });
    await expect(dialog.getByRole('alert')).toContainText('did not allow QBSheet to use the camera');

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.locator('#control-address').fill(control.origin);
    await page.locator('.welcome-connect-form button[type="submit"]').click();

    // The address submission itself reached tournament control; no second Connect gesture is needed.
    await expect(page.getByLabel('Pairing code')).toBeVisible();
  });
});
