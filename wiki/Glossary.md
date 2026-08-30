# Glossary

This wiki uses one word for one thing. This page gives the meaning of each term.

## Application terms

**Active writer** — The one device that can write to a session now. One session has one writer.

**Assignment** — The game that a room must score now. An assignment is a QBJ document.

**Blocker** — A problem that stops a result. QBSheet does not send a result while a blocker is open.

**Connected game** — A game that a room scores while it is paired with tournament control software.

**Device check** — The screen that tests this browser. Select **Check this device** to open it.

**File-only game** — A game that a room scores from a file, with no server.

**Journal** — The record of every scoring event on this device. The journal is the exact recovery
source.

**Partial** — A QBJ file that holds a game in progress. Its name ends in `.partial.qbj`.

**Practice mode** — A guided game that teaches the scoresheet. It changes no tournament data.

**Result** — A QBJ file that holds a completed game. Its name ends in `.result.qbj`.

**Room** — A scoring position in the tournament. A room pairs and authenticates.

**Scorekeeper** — The person who operates the scoresheet.

**Scoresheet** — The client that scores one game at a time. QBSheet is one scoresheet.

**Select** — Click with a mouse, or touch on a touch screen.

**Session** — The work of one scoresheet on one assigned game.

**Snapshot** — The current game state, sent to the server. Each snapshot replaces the last one.

**Tournament control software** — The software that owns the schedule and collects the results. Fruity
is one such program.

**Warning** — A message worth a look, which does not stop a result. Compare with a blocker.

## Format and protocol terms

**Capability token** — An opaque string that grants one scope. It names what the holder can do, not who
the holder is.

**Discovery** — The unauthenticated request that tells a client the version and the capabilities of a
server.

**Fingerprint** — A value computed over the statistical content of a result. Two copies of one game give
one fingerprint.

**GameDefinition** — The internal shape that the scorer runs on. It is not a file format and not a wire
format.

**Match-only QBJ** — A QBJ file that holds a bare match object, with no outer envelope. Other tools
write this shape.

**Pairing code** — A short code that a person types once, to receive a room token.

**PWA** — A progressive web application. An installed copy starts without a network connection.

**QBJ** — The quiz bowl interchange format. Every public QBSheet file is QBJ.

**QBTCP** — The Quiz Bowl Tournament Control Protocol. It runs over HTTP with JSON bodies. It is not a
transport protocol.

**Room token** — A capability token for one room. The header is `x-yf-room-token`.

**Round revision** — An integer that names which issue of a round's pairings an assignment came from.

**Serialised QBJ** — The official envelope, `{version, objects}`. This is the preferred shape.

**Session token** — A capability token for one session. The header is `x-yf-session-token`.

**`.qbg`** — The legacy game package. QBSheet reads it. Nothing writes it.

**`_qbtcp`** — A small optional block on a match. It holds operational information that QBJ cannot
express.

## Storage terms

**IndexedDB** — The browser database that holds the game package, the record state, and the finished
QBJ document.

**`localStorage`** — The browser store that holds the event journal. QBSheet writes it synchronously.

**Persistent storage** — A browser state. The browser then does not delete the site data for space.

**Service worker** — The script that lets QBSheet start with no network connection.

## Related pages

- [Home](Home)
- [Files and formats](Files-and-formats)
- [QBTCP for implementers](QBTCP-for-implementers)
