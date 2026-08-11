/**
 * Pressing the button.
 *
 * `Diagnostics.test.ts` proves the bundle is right and safe. This proves the readiness screen is actually
 * wired to it — that the checks it renders are the checks that reach the file, and that a device holding a
 * live room token produces a file without it. Both halves have been wrong before in other software: a
 * diagnostics export that reports defaults instead of the screen's real findings is worse than none,
 * because somebody then debugs the wrong device.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import DeviceReadiness from '../src/app/DeviceReadiness';
import { connectionTimeline } from '../src/app/ConnectionTimeline';

/**
 * Capture what a download would have written, instead of writing it.
 *
 * The same shape as the capture in `QbjFileWorkflow.test.tsx`: jsdom's `Blob` has no readable body and
 * no `createObjectURL`, so the text is recorded as the blob is constructed. Recording at the anchor click
 * rather than at blob construction is deliberate — it means these tests only see files the browser was
 * actually asked to save.
 */
function captureDownloads(): { files: { name: string; contents: string }[]; restore: () => void } {
  const files: { name: string; contents: string }[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const OriginalBlob = globalThis.Blob;
  const originalClick = HTMLAnchorElement.prototype.click;
  let pending = '';

  class RecordingBlob extends OriginalBlob {
    readonly recordedText: string;

    constructor(parts: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      this.recordedText = parts.map((part) => String(part)).join('');
    }
  }
  globalThis.Blob = RecordingBlob as unknown as typeof Blob;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      pending = (blob as RecordingBlob).recordedText ?? '';
      return 'blob:captured';
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    files.push({ name: this.download, contents: pending });
  };

  return {
    files,
    restore() {
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreate });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevoke });
      globalThis.Blob = OriginalBlob;
      HTMLAnchorElement.prototype.click = originalClick;
    },
  };
}

let downloads: ReturnType<typeof captureDownloads>;

beforeEach(() => {
  connectionTimeline.clear();
  downloads = captureDownloads();
});

afterEach(() => {
  downloads.restore();
  connectionTimeline.clear();
});

/** Render the readiness screen and wait for it to have measured the device. */
async function openReadiness(props: Partial<Parameters<typeof DeviceReadiness>[0]> = {}) {
  await act(async () => {
    render(<DeviceReadiness durable onBack={() => undefined} {...props} />);
  });
}

async function pressDownload(): Promise<string> {
  await act(async () => {
    screen.getByRole('button', { name: 'Download diagnostics' }).click();
  });
  const written = downloads.files[downloads.files.length - 1];
  expect(written, 'the button should have produced a file').toBeDefined();
  return written.contents;
}

describe('the readiness screen', () => {
  test('shows the build so it can be read out over a radio', async () => {
    await openReadiness();

    expect(screen.getByText(/^Build /)).toBeInTheDocument();
  });

  test('offers the download, and says what is in it and what is not', async () => {
    await openReadiness();

    expect(screen.getByRole('button', { name: 'Download diagnostics' })).toBeInTheDocument();
    expect(screen.getByText(/no pairing code, no room or session token/i)).toBeInTheDocument();
  });
});

describe('the file it produces', () => {
  test('carries the readiness results that are on the screen', async () => {
    // `durable: false` makes a required check fail. The file has to say so; a bundle reporting defaults
    // would send somebody to debug a device that is fine.
    await openReadiness({ durable: false });

    const bundle = JSON.parse(await pressDownload());
    const storage = bundle.checks.find((check: { id: string }) => check.id === 'game-storage');

    expect(storage.state).toBe('fail');
    expect(bundle.persistence.recordStoreDurable).toBe(false);
  });

  test('carries the connection history', async () => {
    connectionTimeline.record('offline');
    connectionTimeline.record('connected');
    connectionTimeline.record('session-reopened');
    await openReadiness();

    const bundle = JSON.parse(await pressDownload());

    expect(bundle.connectionTimeline.join('\n')).toContain('session reopened');
    expect(bundle.connectionEntries).toHaveLength(3);
  });

  test('carries the room name and the games on the device', async () => {
    await openReadiness({
      roomName: 'Room 204',
      games: { saved: 7, unfinished: 1, unreadable: [] },
    });

    const bundle = JSON.parse(await pressDownload());

    expect(bundle.roomName).toBe('Room 204');
    expect(bundle.games).toEqual({ saved: 7, unfinished: 1, unreadable: [] });
  });

  test('does not carry the credentials this device is holding', async () => {
    const roomToken = 'rt_7Kq2Xb9Mn4Pl6Vz8Wc3Ha5Jd';
    const sessionToken = 'st_3Rf8Nq1Zx6Cv4Bh9Km2Ld7Ty';
    await openReadiness({
      roomName: 'Room 204',
      rememberedServer: 'http://192.168.1.24:8787',
      liveSecrets: [roomToken, sessionToken],
    });

    const text = await pressDownload();

    expect(text).not.toContain(roomToken);
    expect(text).not.toContain(sessionToken);
    // And the file was produced rather than refused, which is the other half: a check that always fires
    // would be indistinguishable from a broken button.
    expect(JSON.parse(text)).toHaveProperty('diagnosticsVersion', 1);
  });

  test('carries the server address, because a room pointed at the wrong one is a real fault', async () => {
    await openReadiness({ rememberedServer: 'http://192.168.1.24:8787' });

    const bundle = JSON.parse(await pressDownload());

    expect(bundle.server.address).toBe('http://192.168.1.24:8787');
  });

  test('is named for the build and the minute, not for the room', async () => {
    await openReadiness({ roomName: 'Room 204' });
    await pressDownload();

    const name = downloads.files[downloads.files.length - 1].name;
    expect(name).toMatch(/^qbsheet-diagnostics-.+\.json$/);
    expect(name).not.toContain('204');
  });

  test('the screen confirms the save by name', async () => {
    await openReadiness();
    await pressDownload();

    expect(screen.getByText(/^✓ Saved qbsheet-diagnostics-/)).toBeInTheDocument();
  });
});
