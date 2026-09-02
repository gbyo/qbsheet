import { afterEach, describe, expect, test, vi } from 'vitest';
import { QbliveClient } from '@qbsheet/qblive-protocol';
import defaultSnapshot from '@qbsheet/qblive-protocol/fixtures/snapshot-default.json';
import manifestFixture from '@qbsheet/qblive-protocol/fixtures/manifest.json';
import { LiveConnection } from '../src/state/store';

const publicationId = 'bcdfghjkmnpqrstvwxyz';
const backendOrigin = 'https://backend.example';

afterEach(() => {
  vi.restoreAllMocks();
});

function clientWithFetch(fetchImpl: typeof fetch): QbliveClient {
  return new QbliveClient({ backendOrigin, publicationId, fetch: fetchImpl });
}

function hooks() {
  return {
    onSnapshot: vi.fn(),
    onConnection: vi.fn(),
  };
}

function manifestResponse() {
  return Response.json({
    ...manifestFixture,
    revision: defaultSnapshot.revision,
    capabilities: { ...manifestFixture.capabilities, stream: false },
  });
}

describe('LiveConnection request lifecycle', () => {
  test('ignores a bootstrap response that finishes after stop', async () => {
    let resolveManifest!: (response: Response) => void;
    const pendingManifest = new Promise<Response>((resolve) => {
      resolveManifest = resolve;
    });
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/manifest')) return pendingManifest;
      return Response.json(defaultSnapshot);
    });
    const connectionHooks = hooks();
    const connection = new LiveConnection(
      clientWithFetch(fetchStub as unknown as typeof fetch),
      connectionHooks,
    );

    const starting = connection.start(null);
    connection.stop();
    resolveManifest(manifestResponse());
    await starting;

    expect(connectionHooks.onSnapshot).not.toHaveBeenCalled();
    expect(connectionHooks.onConnection).not.toHaveBeenCalled();
  });

  test('ignores an older bootstrap after another request reports removal', async () => {
    let resolveInitialManifest!: (response: Response) => void;
    const initialManifest = new Promise<Response>((resolve) => {
      resolveInitialManifest = resolve;
    });
    let manifestCalls = 0;
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/manifest')) {
        manifestCalls += 1;
        if (manifestCalls === 1) return initialManifest;
        return Response.json(
          { error: 'gone', message: 'This tournament is no longer published.' },
          { status: 410 },
        );
      }
      return Response.json(defaultSnapshot);
    });
    const connectionHooks = hooks();
    const connection = new LiveConnection(
      clientWithFetch(fetchStub as unknown as typeof fetch),
      connectionHooks,
    );

    const starting = connection.start(null);
    await connection.refresh();
    resolveInitialManifest(manifestResponse());
    await starting;

    expect(connectionHooks.onConnection).toHaveBeenCalledWith(
      'removed',
      'This tournament is no longer published.',
    );
    expect(connectionHooks.onSnapshot).not.toHaveBeenCalled();
  });
});
