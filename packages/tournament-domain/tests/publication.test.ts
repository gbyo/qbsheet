/**
 * Publication settings, the timeline, and publication identifiers.
 *
 * The defaults are the load-bearing part. They decide what a tournament publishes before anybody
 * has thought about it, which is the state most tournaments will actually run in.
 */

import { describe, expect, test } from 'vitest';
import {
  closedLivePublicationSettings,
  defaultLivePublicationSettings,
  emptyLivePublication,
  isPublicationId,
  newPublicationId,
  qbliveProtocolVersion,
} from '../src/publication.js';
import { normalizeTimelineEvents, timelineEventTypeLabel, timelineEventTypes } from '../src/timeline.js';
import { emptyDirectorState, directorSchemaVersion } from '../src/model.js';

describe('publication defaults', () => {
  test('publish what a wall schedule already said, and nothing that is a new disclosure', () => {
    const settings = defaultLivePublicationSettings();
    // On: everything a paper schedule taped to a wall would have carried.
    expect(settings.teamNames).toBe(true);
    expect(settings.releasedSchedule).toBe(true);
    expect(settings.roomLocations).toBe(true);
    expect(settings.acceptedResults).toBe(true);
    expect(settings.standings).toBe(true);
    // Off: the three a Director would regret.
    expect(settings.liveScores).toBe(false);
    expect(settings.playerNames).toBe(false);
    expect(settings.playerStatistics).toBe(false);
    // And publication itself is off until somebody turns it on.
    expect(settings.enabled).toBe(false);
  });

  test('the closed settings publish nothing at all', () => {
    // The projection's input whenever configuration is missing, so that a caller who forgets to
    // check publishes nothing rather than everything.
    const settings = closedLivePublicationSettings();
    expect(Object.values(settings).every((value) => value === false)).toBe(true);
  });

  test('every default setting has a closed counterpart', () => {
    // A new switch added to one and not the other would default to `undefined` in the closed set,
    // which is falsy today and a silent hole the first time somebody writes `!== false`.
    expect(Object.keys(defaultLivePublicationSettings()).sort()).toEqual(
      Object.keys(closedLivePublicationSettings()).sort(),
    );
  });
});

describe('publication identifiers', () => {
  test('are twenty characters from a vowel-free alphabet', () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const id = newPublicationId();
      expect(id).toHaveLength(20);
      expect(isPublicationId(id)).toBe(true);
      // The alphabet excludes vowels, so a printed identifier cannot accidentally spell a word,
      // and excludes `l`, which is the character most often misread off a printed page.
      expect(id).not.toMatch(/[aeioul]/);
      // Lowercase only, so reading one aloud has no case to get wrong.
      expect(id).toBe(id.toLowerCase());
    }
  });

  test('are unguessable in practice', () => {
    // The only thing keeping an unlisted publication unlisted.
    const ids = new Set(Array.from({ length: 2000 }, () => newPublicationId()));
    expect(ids.size).toBe(2000);
  });

  test('accept a deterministic random source, for tests', () => {
    const fixed = (length: number) => new Uint8Array(length).fill(0);
    expect(newPublicationId(fixed)).toBe('0'.repeat(20));
  });

  test('reject anything that is not one', () => {
    for (const value of [
      '',
      'short',
      'AEIOU',
      'a'.repeat(20),
      'b'.repeat(21),
      '../../etc/passwd',
      42,
      null,
    ]) {
      expect(isPublicationId(value)).toBe(false);
    }
  });

  test('a new publication carries no credential and no backend', () => {
    const publication = emptyLivePublication(newPublicationId(), '2026-09-05T12:00:00.000Z');
    expect(publication.credential).toBeNull();
    expect(publication.backend).toBeNull();
    expect(publication.lifecycle).toBe('disabled');
    expect(publication.outbox).toEqual([]);
    expect(publication.push.status).toBe('disabled');
  });
});

describe('the timeline', () => {
  test('every event type has a label', () => {
    for (const type of timelineEventTypes) {
      expect(timelineEventTypeLabel(type)).toBeTruthy();
    }
  });

  test('an unknown type normalizes to a generic event rather than being dropped', () => {
    const [event] = normalizeTimelineEvents([
      { id: 'x', title: 'Eclipse', type: 'solar-eclipse', visibility: 'public' },
    ]);
    expect(event.type).toBe('custom');
    expect(event.title).toBe('Eclipse');
  });

  test('an unknown visibility normalizes to hidden, not to public', () => {
    // Fails closed. An event whose visibility nobody can read must not be published.
    const [event] = normalizeTimelineEvents([{ id: 'x', title: 'Meeting', visibility: 'maybe' }]);
    expect(event.visibility).toBe('hidden');
  });

  test('an entry with no id or title is dropped', () => {
    expect(normalizeTimelineEvents([{ title: 'No id' }, { id: 'no-title' }, null, 42])).toEqual([]);
  });

  test('a non-array normalizes to an empty timeline', () => {
    expect(normalizeTimelineEvents(undefined)).toEqual([]);
    expect(normalizeTimelineEvents({ not: 'an array' })).toEqual([]);
  });
});

describe('the canonical document', () => {
  test('starts with no tournament, no timeline, and no publication', () => {
    const state = emptyDirectorState();
    expect(state.tournament).toBeNull();
    expect(state.timeline).toEqual([]);
    // Null rather than a disabled record: a tournament whose Director never opens the Live section
    // should carry no publication identity at all.
    expect(state.live).toBeNull();
    expect(state.schemaVersion).toBe(directorSchemaVersion);
  });

  test('the protocol version the domain speaks is v1', () => {
    expect(qbliveProtocolVersion).toBe(1);
  });
});
