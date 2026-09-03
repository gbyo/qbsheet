# Director Product Principles

How tournament directors actually run quiz bowl, and what that means for
QBSheet Director. Read this before adding, moving, or gating a Director
surface.

## The core rule

**Complexity should be caused by the tournament, not by QBSheet.**

A ten-team Saturday event with Rounds 1–5, lunch, then Rounds 6–9 must not
require the director to learn phases, pools, advancement objects, assignment
revisions, prepared/released states, transports, QBTCP, timeline-event
visibility, or transfer locations. Those concepts appear only when the
tournament itself uses them.

Corollary: **make the common thing one action; make the unusual thing
possible.** Never remove an advanced capability to simplify the interface.
Hide it until it is relevant.

## Principles

1. **Complexity comes from the tournament, not the application.**
   If a control is visible, it should answer a question this tournament
   actually asks. A dormant subsystem is not a navigation item, a blocker,
   or a warning.

2. **Internal state machines are not automatically user workflows.**
   `planned → prepared → released → closed` is storage truth, not a button
   sequence. Routine operations get one high-level action (`Start Round 4`)
   that performs the safe internal sequence and reports partial readiness
   honestly. Low-level transitions stay available for recovery/diagnostics.

3. **A tournament may be sequential without being clock-scheduled.**
   Day order is explicit persisted sequence, never inferred from timestamps.
   Times are optional everywhere; nothing nags about missing times, and Live
   shows sequence ("Up next: Round 5"), never invented clock times.

4. **One-stage tournaments should not have to understand stages.**
   Exactly one ordinary stage means no "Stages" section, no "Preliminary
   phase" labels, no stage-scoped selectors where every option means the
   same thing. Adding a second stage reveals stage navigation, naming,
   advancement, and scoped standings — because the tournament grew, not
   because the app has modes. There is one Director; there is no
   Simple | Advanced switch.

5. **Optional systems never become blockers until used.**
   Preflight protects the workflow the director chose: no QBTCP in use
   means no server warnings; no USB workflow means no transfer blockers;
   no staff assignments means no staffing blockers. Every blocker must say
   what is wrong, why it prevents the requested action, and where to fix it.

6. **Common actions are contextual.**
   The round owns its life: packet, rooms, pairings, planned time, USB
   handoff, and Start/Finish live next to the round. Specialist pages
   (Rooms, Packets, Transfers) remain as bulk-management and history tools,
   reachable by deep link when something needs attention
   ("Room 203 is missing an assignment → Fix room").

7. **Advanced capabilities remain available without dominating the interface.**
   Progressive disclosure, not removal: playoffs reveal stages/advancement/
   carryover; pools reveal pool membership and reseeding; USB drives reveal
   "Put Round 4 on USB". Primary navigation stays stable — tools sit in a
   steady secondary menu while their controls disclose contextually.

8. **Never fabricate tournament/statistical information.**
   Unknown is unknown: missing TUH, unplayed games, absent times, and
   unresolved ties render as unknown, never as zeroes, estimates, or
   invented schedules. Ranking criteria that require missing data decline
   or warn instead of ranking on fiction.

9. **Preserve raw historical truth; overrides are explicit.**
   Corrections, rebracketing, and final-placement overrides never rewrite
   results. They are stored as explicit, attributed, timestamped, auditable
   overlays with reasons, and calculated truth stays recoverable. Generated
   plans become ordinary editable data the moment they are applied.

10. **Offline operation is a first-class requirement.**
    Planning, rounds, results, USB, QBTCP LAN, standings, reports, exports,
    corrections, and final rankings all work with no connectivity. Cloud
    publication (QBSheet Live) is optional and its absence is never a
    warning. The browser/ChromeOS experience degrades honestly where native
    capabilities are unavailable.

## Review check

Before shipping a Director change, test it against this sentence:

> "I have ten teams. We play Rounds 1–5, eat lunch, then play Rounds 6–9."

A director entering that tournament should not translate it into QBSheet
terminology. QBSheet translates it for them. Then test the opposite end:

> "I have 36 teams in six prelim pools, wildcard advancement into multiple
> playoff divisions, some carried-over games, mixed USB and QBTCP rooms,
> public live standings, and a final placement override."

That tournament fits in the same Director, with extra controls appearing
only because those concepts now exist.
