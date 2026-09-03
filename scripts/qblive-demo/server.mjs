/**
 * A QBLive backend that serves a demo tournament, for driving QBSheet Live without a real one.
 *
 * # What this is for
 *
 * QBSheet Live is a spectator client with no data of its own: the QR code says where a tournament's
 * backend is, and everything comes from there. That makes the app impossible to look at — in the
 * iOS Simulator, in a browser, on a device on the same network — until some backend is answering.
 * Standing up Cloudflare, or running a tournament in Director, is a lot of ceremony for "does the
 * Standings tab look right".
 *
 * So this speaks the public half of QBLive v1 — manifest, snapshot, events, stream — over plain
 * HTTP on a loopback or LAN address, with a demo tournament that plays itself: rounds are released,
 * games go live, scores tick up a tossup at a time, results are accepted, standings reorder, and a
 * final is played between whichever two teams earned it.
 *
 * # What it is not
 *
 * Not a QBLive backend implementation to learn from — the real one is
 * `apps/qblive-backend-cloudflare`, and the conformance suite (`npm run qblive:conformance`) is
 * what says whether a backend is correct. This has no management API, no authentication, no
 * persistence, and no durability: it holds one tournament in memory and forgets it on exit. It is a
 * development affordance, like the app's `-qblive-bootstrap` launch argument, and nothing here
 * ships or is deployed anywhere.
 *
 *     node scripts/qblive-demo/server.mjs               # 30× speed, starts just before round 1
 *     node scripts/qblive-demo/server.mjs --speed 1     # real time
 *     node scripts/qblive-demo/server.mjs --at 3h       # start mid-tournament
 *     node scripts/qblive-demo/server.mjs --no-stream   # make the client fall back to polling
 *
 * See docs/QBLIVE_IOS.md § Simulating a tournament.
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';

import { changedSections, pickSections, projectLiveSnapshot } from '@qbsheet/qblive-projection';
import { parseManifest, parseSnapshot } from '@qbsheet/qblive-protocol';

import { createDemoTournament, demoSettings, demoTimeZone, todayIn } from './tournament.mjs';

const defaults = {
  port: 8788,
  host: '0.0.0.0',
  /** Seconds of tournament time per real second. A whole day is about twenty minutes at 30×. */
  speed: 30,
  /** Where the demo clock starts, relative to the first round. Two minutes before the first tossup. */
  at: '-2m',
  seed: 20260905,
  settings: 'maximal',
  stream: true,
  timeZone: demoTimeZone,
  /** How many events to keep for replay. A reconnecting client older than this is told to resync. */
  eventHistory: 200,
};

/** `-45m`, `2h`, `1h30m`, `90s`, or `0`. Minutes when a bare number. */
function parseOffset(value) {
  const text = String(value).trim();
  if (/^-?\d+$/.test(text)) return Number(text) * 60_000;
  const pattern = /^(-)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (!pattern) throw new Error(`Could not read a time offset from "${value}". Try -45m, 0, 2h, or 1h30m.`);
  const [, sign, hours, minutes, seconds] = pattern;
  const total = (Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)) * 1000;
  return sign ? -total : total;
}

function parseArguments(argv) {
  const options = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} needs a value.`);
      index += 1;
      return value;
    };
    switch (argument) {
      case '--port':
        options.port = Number(next());
        break;
      case '--host':
        options.host = next();
        break;
      case '--speed':
        options.speed = Number(next());
        break;
      case '--at':
        options.at = next();
        break;
      case '--seed':
        options.seed = Number(next());
        break;
      case '--day':
        options.day = next();
        break;
      case '--tz':
        options.timeZone = next();
        break;
      case '--settings':
        options.settings = next();
        break;
      case '--no-stream':
        options.stream = false;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option ${argument}. Try --help.`);
    }
  }
  return options;
}

const usage = `
QBSheet Live demo backend — serves a self-playing tournament over QBLive v1.

  --port <n>          Port to listen on (default ${defaults.port})
  --host <address>    Address to bind (default ${defaults.host}, so a phone on the LAN can reach it)
  --speed <n>         Tournament seconds per real second (default ${defaults.speed}; 0 freezes the clock)
  --at <offset>       Where the demo clock starts, relative to round 1 (default ${defaults.at})
  --day <YYYY-MM-DD>  The tournament's date (default: today in its own zone)
  --tz <zone>         The tournament's IANA zone (default ${defaults.timeZone})
  --seed <n>          The scoring seed. The same seed always plays the same tournament.
  --settings <kind>   maximal (everything published) or default (Director's real defaults)
  --no-stream         Advertise no WebSocket, so a client falls back to polling
`;

// ----------------------------------------------------------------- WebSocket
//
// A hand-rolled server rather than `ws`: this repository has no runtime dependency on a WebSocket
// library, a development script is not the place to acquire one, and the server half of the
// protocol QBSheet Live needs is a handshake plus text frames.

const websocketGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return createHash('sha1')
    .update(key + websocketGuid)
    .digest('base64');
}

function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header.writeUInt8(0x81, 0);
    header.writeUInt8(126, 1);
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header.writeUInt8(0x81, 0);
    header.writeUInt8(127, 1);
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeControlFrame(opcode, payload = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

/**
 * Read what a client sends us, which is only ever a ping, a pong or a close.
 *
 * The frames a spectator client sends carry nothing this server acts on, but a close has to be
 * answered and a ping has to be ponged or a browser will drop the socket. Frames are consumed from
 * a buffer rather than assumed to arrive whole: TCP does not promise frame boundaries.
 */
function readClientFrames(socket, onClose) {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        length = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const frame = buffer.subarray(offset - (masked ? 4 : 0), offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) {
        socket.end(encodeControlFrame(0x8));
        onClose();
        return;
      }
      if (opcode === 0x9) {
        // Echo the payload back, unmasked, as a pong.
        const payload = masked ? unmask(frame) : frame;
        socket.write(encodeControlFrame(0xa, payload));
      }
    }
  });
}

function unmask(frame) {
  const key = frame.subarray(0, 4);
  const payload = Buffer.from(frame.subarray(4));
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= key[index % 4];
  return payload;
}

// -------------------------------------------------------------------- server

function localAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

function bootstrapUrl(origin, publicationId) {
  return `https://live.qbsheet.com/t/${publicationId}?b=${encodeURIComponent(origin)}&v=1`;
}

function json(response, status, body, extra = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // A demo backend is read by a browser client on another origin during development.
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    ...extra,
  });
  response.end(payload);
}

export function createDemoBackend(options = {}) {
  const settings = { ...defaults, ...options };
  const capabilities = {
    snapshot: true,
    events: true,
    stream: settings.stream,
    // Broadcast push needs an APNs key and the real push gateway. Off, and the app degrades to
    // foreground realtime exactly as it does at a tournament that has not enabled it.
    applePush: false,
  };
  const publicationSettings = demoSettings(settings.settings);
  const tournament = createDemoTournament({
    timeZone: settings.timeZone,
    day: settings.day ?? todayIn(settings.timeZone),
    seed: settings.seed,
  });

  const startedAtReal = Date.now();
  const clockOrigin = tournament.firstRound.getTime() + parseOffset(settings.at);

  let revision = 0;
  let snapshot = null;
  const events = [];
  const sockets = new Set();

  /** Where the tournament's clock stands now. Frozen at the end of the day, and by `--speed 0`. */
  function tournamentNow() {
    const elapsed = (Date.now() - startedAtReal) * settings.speed;
    return new Date(Math.min(clockOrigin + elapsed, tournament.closesAt.getTime()));
  }

  function project(at) {
    return projectLiveSnapshot({
      state: tournament.documentAt(at),
      settings: publicationSettings,
      publicationId: tournament.publicationId,
      revision: revision + 1,
      generatedAt: at,
      capabilities,
      final: at >= tournament.closesAt,
    });
  }

  /**
   * Advance the tournament and publish what changed.
   *
   * The section diff is the projection's own `changedSections`, which is what Director's publication
   * worker uses: a demo that invented its own idea of "what changed" would be exercising a code path
   * no real backend has.
   */
  function tick() {
    const at = tournamentNow();
    const next = project(at);
    const changed = changedSections(snapshot, next);
    if (snapshot !== null && changed.length === 0) return null;
    revision += 1;
    next.revision = revision;
    snapshot = next;
    const event = {
      revision,
      generatedAt: at.toISOString(),
      sections: pickSections(next, changed),
    };
    events.push(event);
    while (events.length > settings.eventHistory) events.shift();
    return event;
  }

  function manifest() {
    return {
      protocolVersion: snapshot.protocolVersion,
      publicationId: snapshot.publicationId,
      revision: snapshot.revision,
      generatedAt: snapshot.generatedAt,
      tournament: snapshot.tournament,
      capabilities,
      endpoints: {
        snapshot: `/qblive/v1/tournaments/${snapshot.publicationId}/snapshot`,
        events: `/qblive/v1/tournaments/${snapshot.publicationId}/events`,
        stream: `/qblive/v1/tournaments/${snapshot.publicationId}/stream`,
      },
      final: snapshot.final,
    };
  }

  function eventPage(after, limit) {
    const oldest = events.length > 0 ? events[0].revision : revision + 1;
    // A client further behind than the history we kept cannot be caught up incrementally, and
    // saying so is the protocol's answer: it reloads the snapshot instead.
    const resyncRequired = after > 0 && after + 1 < oldest;
    return {
      protocolVersion: snapshot.protocolVersion,
      publicationId: snapshot.publicationId,
      currentRevision: revision,
      resyncRequired,
      events: resyncRequired ? [] : events.filter((event) => event.revision > after).slice(0, limit),
    };
  }

  function broadcast(frame) {
    const encoded = encodeTextFrame(JSON.stringify(frame));
    for (const socket of sockets) {
      if (socket.writable) socket.write(encoded);
    }
  }

  // The first snapshot, validated. A demo that quietly serves something the protocol rejects would
  // send us hunting through the client for a bug that is in here.
  tick();
  parseSnapshot(snapshot);
  parseManifest(manifest());

  const routes = new RegExp(`^/qblive/v1/tournaments/([^/]+)/(manifest|snapshot|events|stream)$`);

  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'accept, content-type',
      });
      response.end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      json(response, 405, { error: 'method-not-allowed', message: 'This backend is read-only.' });
      return;
    }
    if (url.pathname === '/') {
      const origin = `http://${request.headers.host ?? `127.0.0.1:${settings.port}`}`;
      const body = [
        'QBSheet Live demo backend',
        '',
        `tournament    ${snapshot.tournament.name}`,
        `publication   ${snapshot.publicationId}`,
        `revision      ${snapshot.revision}`,
        `tournament at ${tournamentNow().toISOString()} (${settings.speed}× real time)`,
        '',
        bootstrapUrl(origin, snapshot.publicationId),
        '',
      ].join('\n');
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end(body);
      return;
    }

    const match = routes.exec(url.pathname);
    if (!match) {
      json(response, 404, { error: 'not-found', message: 'No such QBLive route.' });
      return;
    }
    const [, publicationId, document] = match;
    if (publicationId !== snapshot.publicationId) {
      json(response, 404, {
        error: 'not-found',
        message: `This demo serves ${snapshot.publicationId} and nothing else.`,
      });
      return;
    }
    switch (document) {
      case 'manifest':
        json(response, 200, manifest());
        return;
      case 'snapshot':
        json(response, 200, snapshot);
        return;
      case 'events': {
        const after = Number(url.searchParams.get('after') ?? 0);
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 64), 256);
        if (!Number.isFinite(after) || after < 0) {
          json(response, 400, { error: 'bad-request', message: '`after` must be a revision number.' });
          return;
        }
        json(response, 200, eventPage(after, limit));
        return;
      }
      case 'stream':
        // Reached only without an Upgrade header: a plain GET of a WebSocket route.
        json(response, 426, { error: 'upgrade-required', message: 'The stream is a WebSocket.' });
        return;
    }
  });

  server.on('upgrade', (request, socket) => {
    const url = new URL(request.url, 'http://localhost');
    const match = routes.exec(url.pathname);
    const key = request.headers['sec-websocket-key'];
    if (
      !capabilities.stream ||
      !match ||
      match[2] !== 'stream' ||
      match[1] !== snapshot.publicationId ||
      !key
    ) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'upgrade: websocket',
        'connection: Upgrade',
        `sec-websocket-accept: ${acceptKey(key)}`,
        '',
        '',
      ].join('\r\n'),
    );
    socket.setNoDelay(true);
    sockets.add(socket);
    const forget = () => sockets.delete(socket);
    socket.on('close', forget);
    socket.on('error', forget);
    readClientFrames(socket, forget);
    // `hello` carries the current revision so a client that has a cached snapshot knows at once
    // whether it is behind, and asks for the events it missed rather than reloading.
    socket.write(encodeTextFrame(JSON.stringify({ type: 'hello', revision })));
  });

  let timer = null;

  return {
    tournament,
    get revision() {
      return revision;
    },
    get snapshot() {
      return snapshot;
    },
    manifest,
    eventPage,
    tick,
    tournamentNow,
    listen: () =>
      new Promise((resolve) => {
        server.listen(settings.port, settings.host, () => {
          timer = setInterval(() => {
            const event = tick();
            if (!event) return;
            broadcast({ type: 'event', event });
            if (snapshot.final) broadcast({ type: 'final', revision });
          }, 1000);
          timer.unref?.();
          resolve(server.address());
        });
      }),
    close: () =>
      new Promise((resolve) => {
        if (timer) clearInterval(timer);
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
    settings,
  };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (reason) {
    console.error(reason.message);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage.trim());
    return;
  }

  const backend = createDemoBackend(options);
  const address = await backend.listen();
  const port = address.port;
  const publicationId = backend.snapshot.publicationId;
  const loopback = `http://127.0.0.1:${port}`;
  const lan = localAddresses().map((host) => `http://${host}:${port}`);

  console.log(`QBSheet Live demo backend — ${backend.snapshot.tournament.name}`);
  console.log(`  publication  ${publicationId}`);
  console.log(`  clock        ${backend.tournamentNow().toISOString()} at ${options.speed}× real time`);
  console.log(`  settings     ${options.settings}`);
  console.log(`  stream       ${options.stream ? 'WebSocket' : 'off (clients poll)'}`);
  console.log('');
  console.log('Simulator, and the Live Web dev server:');
  console.log(`  ${bootstrapUrl(loopback, publicationId)}`);
  for (const origin of lan) {
    console.log('');
    console.log('A phone on this network:');
    console.log(`  ${bootstrapUrl(origin, publicationId)}`);
  }
  console.log('');
  console.log('Open it in the iOS Simulator:');
  console.log(`  ./ios/scripts/simulate.sh --backend ${loopback}`);
  console.log('');

  const stop = async () => {
    await backend.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// Run only when invoked directly, so the tests can import the backend without starting one.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
