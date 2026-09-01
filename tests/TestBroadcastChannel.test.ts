/**
 * The test realm's `BroadcastChannel`.
 *
 * Every DOM test runs against this rather than Node's, so the duplicate-tab guard's behaviour is
 * only as trustworthy as the channel underneath it. These are the four things `claimGame` depends
 * on: peers in this file hear each other, a sender never hears itself, a closed channel is out of
 * the conversation, and delivery is asynchronous the way a real one is.
 */
import { describe, expect, test } from 'vitest';

const received = (channel: BroadcastChannel, into: unknown[]) => {
  channel.addEventListener('message', (event) => into.push((event as MessageEvent).data));
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the test realm broadcast channel', () => {
  test('a peer on the same name hears the message', async () => {
    const speaker = new BroadcastChannel('qbsheet.test');
    const listener = new BroadcastChannel('qbsheet.test');
    const heard: unknown[] = [];
    received(listener, heard);

    speaker.postMessage({ kind: 'holding' });
    await settle();

    expect(heard).toEqual([{ kind: 'holding' }]);
    speaker.close();
    listener.close();
  });

  test('the sender does not hear itself, and another name is another conversation', async () => {
    const speaker = new BroadcastChannel('qbsheet.test');
    const elsewhere = new BroadcastChannel('qbsheet.other');
    const ownEcho: unknown[] = [];
    const crossTalk: unknown[] = [];
    received(speaker, ownEcho);
    received(elsewhere, crossTalk);

    speaker.postMessage({ kind: 'who-holds' });
    await settle();

    expect(ownEcho).toEqual([]);
    expect(crossTalk).toEqual([]);
    speaker.close();
    elsewhere.close();
  });

  test('a closed channel neither hears nor is heard', async () => {
    const speaker = new BroadcastChannel('qbsheet.test');
    const leaving = new BroadcastChannel('qbsheet.test');
    const heard: unknown[] = [];
    received(leaving, heard);

    leaving.close();
    speaker.postMessage({ kind: 'claim' });
    await settle();

    expect(heard).toEqual([]);
    expect(() => leaving.postMessage({ kind: 'claim' })).toThrow();
    speaker.close();
  });

  test('delivery does not happen before postMessage returns', () => {
    const speaker = new BroadcastChannel('qbsheet.test');
    const listener = new BroadcastChannel('qbsheet.test');
    const heard: unknown[] = [];
    received(listener, heard);

    speaker.postMessage({ kind: 'candidate' });

    expect(heard).toEqual([]);
    speaker.close();
    listener.close();
  });
});
