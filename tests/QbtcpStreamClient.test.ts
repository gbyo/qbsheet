/**
 * The stream final settles exactly once, even when the server never answers.
 *
 * Without the settlement timer a sent-but-unanswered final would leave `submitFinal`
 * pending forever and the runtime would never fall through to HTTP.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  QbtcpStreamClient,
  finalSettlementTimeoutMs,
  type IQbtcpSocket,
} from '../src/qbtcp/QbtcpStreamClient';

const hello = JSON.stringify({ version: 1, type: 'hello', sequence: 128, payload: {} });
const receipt = JSON.stringify({
  version: 1,
  type: 'receipt',
  sequence: 134,
  session_id: 'sess-9f13',
  payload: { received: true, review_required: true, accepted_by_director: false, duplicate: false },
});

function fakeSocket(): IQbtcpSocket & { sent: string[] } {
  return {
    sent: [],
    send(data: string): void {
      this.sent.push(data);
    },
    close(): void {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
}

function liveClient(onFinalUnanswered: () => void = () => {}): {
  client: QbtcpStreamClient;
  socket: IQbtcpSocket & { sent: string[] };
} {
  const socket = fakeSocket();
  const client = new QbtcpStreamClient({
    url: 'ws://control.test/qbtcp/v1/stream',
    credentials: { sessionId: 'sess-9f13' },
    maxFrameBytes: 1_000_000,
    socketFactory: () => socket,
    events: { onFinalUnanswered: () => onFinalUnanswered() },
  });
  client.start();
  socket.onopen?.({});
  socket.onmessage?.({ data: hello });
  expect(client.isLive).toBe(true);
  return { client, socket };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('submitFinal settlement', () => {
  test('an unanswered final settles unanswered when the timer expires', async () => {
    const { client } = liveClient();
    const answered = client.submitFinal('retry-1', { tossups_read: 20 });
    await vi.advanceTimersByTimeAsync(finalSettlementTimeoutMs);
    await expect(answered).resolves.toEqual({ delivered: false });
    client.close();
  });

  test('a receipt before expiry delivers and disarms the timer', async () => {
    const unanswered = vi.fn();
    const { client, socket } = liveClient(unanswered);
    const answered = client.submitFinal('retry-1', { tossups_read: 20 });
    socket.onmessage?.({ data: receipt });
    await expect(answered).resolves.toMatchObject({ delivered: true });
    await vi.advanceTimersByTimeAsync(finalSettlementTimeoutMs * 2);
    expect(unanswered).not.toHaveBeenCalled();
    client.close();
  });

  test('close settles the final and disarms the timer', async () => {
    const unanswered = vi.fn();
    const { client } = liveClient(unanswered);
    const answered = client.submitFinal('retry-1', { tossups_read: 20 });
    client.close();
    await expect(answered).resolves.toEqual({ delivered: false });
    expect(unanswered).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(finalSettlementTimeoutMs * 2);
    expect(unanswered).toHaveBeenCalledTimes(1);
  });
});
