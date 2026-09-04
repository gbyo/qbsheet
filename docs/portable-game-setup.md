# Portable game setup QR codes

The standalone `game-package-creator/index.html` Vite entry uses the same controlled
`ManualGameEditor` as Create Game. `ManualGameSetup` owns scorer navigation, starting,
and successful presets. Each editor wrapper uses `useManualGameDraft` with its own key:

- Scorer: `qbsheet.manual-game-draft.v1`
- Creator: `qbsheet.game-package-creator-draft.v1`

Recent successful scorer presets are intentionally available in both editors. Generating a
package does not create a game, change a scorer draft, or save a successful-game preset.

## Version 1 wire format

`QBSHEET-SETUP:1:<Base45 payload>` is plain text, not a URL. The payload is the UTF-8
JSON representation of an explicitly projected `IManualGameInput`, compressed with zlib
(DEFLATE), then encoded with the RFC 9285 Base45 alphabet. Spaces are meaningful and must
not be trimmed. Property order is fixed by the projection; optional undefined fields are
omitted. Form row keys remain local editor row keys, not tournament or game identities.

Only manual fields are copied. Team and player text, basic/advanced scoring inputs, timing,
breaks, timeouts, and substitution policy are retained. Credentials, control addresses,
starting lineups, tournament identifiers, and unrelated properties are never copied.
The codec checks structure and calls `defineManualGame` before encoding and after decoding.
Required invalid rules are rejected rather than replaced by defaults. Future envelope
versions are rejected in full.

## Limits and reliability

The creator uses `uqr` 0.1.3, a zero-dependency MIT-licensed ES module derived from
Nayuki's QR encoder. Its automatic alphanumeric mode handles the envelope and Base45 text;
the shared helper also supports byte-mode URLs for Director. SVG output retains the
existing single-path renderer, black/white contrast, and four-module quiet zone.

Portable generation is limited to **QR version 22 at error correction M**, or 105×105
modules before the quiet zone. This provides about 5.6 pixels per module when the code
fills the scanner fallback's 640-pixel frame. SVG round-trip tests rasterize both basic
and advanced examples, and a version-22 boundary example, at that frame size and decode
with the existing `jsQR`. These are ideal raster checks, not a physical-device camera
certification: lighting, focus, display size and print quality still affect scanning.
The creator refuses a denser setup with a shortening/alternate-transfer message. It never
truncates data or generates multiple codes.

Independent decoding limits are 8,192 encoded characters, 4,096 compressed bytes, and
65,536 decompressed bytes. Inflation uses a fixed 65,537-byte output buffer; its sentinel
byte detects overflow without allowing fflate to grow the allocation. The compressed cap
also bounds DEFLATE processing work. A zlib Adler-32 check detects corruption because
fflate itself does not check that checksum. UTF-8 is decoded strictly before JSON parsing.

Existing field limits are reused: 200 players per team, 200 characters per player/team
name, 50 answer types, 500 characters for general labels/row keys, 32 scheduled breaks,
and 60 characters per break label. Raw roster text is bounded as well. Collection entries
are individually checked before normal validation. Known numeric fields are finite and
limited to magnitude 10,000; normal validation additionally enforces scoring semantics,
break positions, half lengths, and timeout limits. Unknown nested fields are discarded;
JSON size is bounded before parsing, and the projection never recursively traverses them.

## Scan and start lifecycle

`QrScannerDialog` remains camera → text → callback. `ScannedQbsheetCode` dispatches portable
text separately from the unchanged QBTCP pairing parser. Unrelated or malformed scans
return a short error and leave the scanner open.

Home and ConnectedSetup retain a scanned setup only in component state and show
`PortableGameReview`. Cancel closes it without storage changes. The pairing form remains
mounted, retaining its address, room, code, stage and warnings. Start reruns
`defineManualGame` and invokes App's existing `createManualGame` callback, preserving local
manual record identity and the normal lineup/scoring flow. Edit passes `initialInput` to
Create Game; only then does ordinary scorer draft persistence take over.

## Deployment

The Settings link opens `./game-package-creator/index.html` in a separate tab with
`noopener noreferrer`. It resolves under root, project prefixes, explicit index documents,
and file copies. The creator is a real HTML entry, not a scorer route, and does not register
a service worker. Its document, entry script, and own stylesheet are outside the scorer
precache and fetch interception. Shared editor/codec assets stay available offline to the
scorer. Build tests cover relative assets, `/`, and `/school/qbsheet/`.

No `.qbg` export, URL payload, multi-QR transfer, portable starting lineup, or future-version
interpretation is provided. Setups outside the transport/field/density limits need a
different transfer method; no existing scorer routing or QBTCP security rules are relaxed.
