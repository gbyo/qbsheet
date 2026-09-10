import { describe, expect, it } from 'vitest';
import {
  decodeSocketAttachment,
  encodeSocketAttachment,
  frameFits,
  SOCKET_ATTACHMENT_VERSION,
} from '../src/websocket';

describe('hibernating socket attachments', () => {
  it('round-trips through serialization with a version marker', () => {
    const raw = encodeSocketAttachment({ session_id: 'sess-1', room_id: 'room-1' });
    expect(JSON.parse(raw).v).toBe(SOCKET_ATTACHMENT_VERSION);
    expect(decodeSocketAttachment(raw)).toEqual({ session_id: 'sess-1', room_id: 'room-1' });
  });

  it('survives hibernation reconstruction: garbage and wrong versions decode to null', () => {
    expect(decodeSocketAttachment('not json')).toBeNull();
    expect(decodeSocketAttachment(JSON.stringify({ v: 999, session_id: 'x' }))).toBeNull();
    expect(decodeSocketAttachment(JSON.stringify(['array']))).toBeNull();
    expect(decodeSocketAttachment('')).toBeNull();
    expect(decodeSocketAttachment(null)).toBeNull();
  });

  it('guards frame sizes without trusting the bound', () => {
    expect(frameFits(100, 1024)).toBe(true);
    expect(frameFits(1025, 1024)).toBe(false);
    expect(frameFits(-1, 1024)).toBe(false);
    expect(frameFits(100, 0)).toBe(false);
    expect(frameFits(NaN, 1024)).toBe(false);
  });
});
