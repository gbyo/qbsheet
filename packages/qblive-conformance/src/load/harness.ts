/**
 * The QBLive load harness.
 *
 * # What it is for
 *
 * A tournament's backend runs in a tournament director's own Cloudflare account, on their own
 * budget. Before recommending a shape, QBSheet should know what that shape costs at the scale a
 * real tournament produces: a few hundred phones in one building, all opened within a minute of
 * each other, all watching the same eight games.
 *
 * # What it deliberately does not do
 *
 * It does not run in ordinary CI. A hundred concurrent WebSockets against a Durable Object is a
 * useful measurement and a poor unit test — it is slow, it is sensitive to the machine, and a flake
 * would train everybody to ignore a red build. It runs on demand and in a scheduled workflow.
 *
 * ```bash
 * npm run load --workspace=@qbsheet/qblive-conformance -- \
 *   --origin http://127.0.0.1:8788 --publication <id> --viewers 300 --seconds 60
 * ```
 */

export interface LoadOptions {
  origin: string;
  publicationId: string;
  /** Concurrent WebSocket spectators. */
  viewers: number;
  /** How long to hold the connections. */
  seconds: number;
  /** Spread connections over this many milliseconds, to model arrival rather than a thundering herd. */
  rampMs?: number;
  /** Publish a score update every this many milliseconds. Requires a management token. */
  updateIntervalMs?: number;
  managementToken?: string;
  fetchImpl?: typeof fetch;
  webSocketImpl?: typeof WebSocket;
  /** Called with a one-line progress note. */
  onProgress?: (line: string) => void;
}

export interface LoadReport {
  viewers: number;
  connected: number;
  failedToConnect: number;
  /** Frames delivered across all sockets. */
  framesReceived: number;
  /** Updates the harness published. */
  updatesPublished: number;
  /**
   * How many of the published updates each connected socket saw, on average.
   *
   * The number that matters. A backend that accepts three hundred connections and then delivers to
   * forty of them has not passed.
   */
  deliveryRatio: number;
  /** Milliseconds from publish to arrival. */
  latency: { p50: number; p95: number; p99: number; max: number };
  connectMs: { p50: number; p95: number; max: number };
  durationMs: number;
  disconnects: number;
}

interface Viewer {
  socket: WebSocket;
  frames: number;
  seenRevisions: Set<number>;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
}

export async function runLoadTest(options: LoadOptions): Promise<LoadReport> {
  const doFetch = options.fetchImpl ?? fetch;
  const WebSocketImpl = options.webSocketImpl ?? globalThis.WebSocket;
  if (!WebSocketImpl) throw new Error('No WebSocket implementation is available in this runtime.');
  const progress = options.onProgress ?? (() => undefined);

  const origin = options.origin.replace(/\/$/, '');
  const base = `${origin}/qblive/v1/tournaments/${encodeURIComponent(options.publicationId)}`;
  const streamUrl = new URL(`${base}/stream`);
  streamUrl.protocol = streamUrl.protocol === 'https:' ? 'wss:' : 'ws:';

  const manifest = (await (await doFetch(`${base}/manifest`)).json()) as { revision: number };
  let revision = manifest.revision;

  const viewers: Viewer[] = [];
  const connectTimes: number[] = [];
  const latencies: number[] = [];
  const publishedAt = new Map<number, number>();
  let failedToConnect = 0;
  let disconnects = 0;
  let updatesPublished = 0;

  const started = Date.now();
  const ramp = options.rampMs ?? Math.min(10_000, options.viewers * 20);

  progress(`connecting ${options.viewers} spectators over ${ramp} ms…`);

  await Promise.all(
    Array.from({ length: options.viewers }, async (_unused, index) => {
      // Spread arrivals. Three hundred phones do not open a link in the same millisecond, and
      // pretending they do measures a burst nobody experiences instead of the load they cause.
      await new Promise((resolve) => setTimeout(resolve, (index / options.viewers) * ramp));
      const connectStarted = Date.now();
      await new Promise<void>((resolve) => {
        let settled = false;
        const socket = new WebSocketImpl(streamUrl.toString());
        const viewer: Viewer = { socket, frames: 0, seenRevisions: new Set() };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          failedToConnect += 1;
          resolve();
        }, 20_000);
        socket.addEventListener('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          connectTimes.push(Date.now() - connectStarted);
          viewers.push(viewer);
          resolve();
        });
        socket.addEventListener('message', (event: MessageEvent) => {
          viewer.frames += 1;
          try {
            const frame = JSON.parse(String(event.data)) as { type?: string; event?: { revision?: number } };
            const eventRevision = frame.event?.revision;
            if (frame.type === 'event' && typeof eventRevision === 'number') {
              viewer.seenRevisions.add(eventRevision);
              const sentAt = publishedAt.get(eventRevision);
              if (sentAt !== undefined) latencies.push(Date.now() - sentAt);
            }
          } catch {
            // A frame that is not JSON is not a latency sample. Counted as a frame and ignored.
          }
        });
        socket.addEventListener('close', () => {
          if (settled) disconnects += 1;
        });
        socket.addEventListener('error', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          failedToConnect += 1;
          resolve();
        });
      });
    }),
  );

  progress(`${viewers.length} connected, ${failedToConnect} failed. Holding for ${options.seconds}s…`);

  const updateInterval = options.updateIntervalMs ?? 3000;
  const deadline = Date.now() + options.seconds * 1000;
  if (options.managementToken) {
    while (Date.now() < deadline) {
      revision += 1;
      const at = Date.now();
      publishedAt.set(revision, at);
      const response = await doFetch(
        `${origin}/qblive/v1/manage/tournaments/${encodeURIComponent(options.publicationId)}/sections`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${options.managementToken}` },
          body: JSON.stringify({
            baseRevision: revision - 1,
            revision,
            generatedAt: new Date(at).toISOString(),
            sections: {
              liveGames: [
                {
                  gameId: 'load-game',
                  roundId: 'load-round',
                  teamIds: ['team-a', 'team-b'],
                  roomId: null,
                  scores: [
                    { teamId: 'team-a', score: revision * 5 },
                    { teamId: 'team-b', score: revision * 3 },
                  ],
                  tossupsRead: revision % 21,
                },
              ],
            },
          }),
        },
      );
      if (response.ok) updatesPublished += 1;
      else revision -= 1;
      await new Promise((resolve) => setTimeout(resolve, updateInterval));
    }
    // Let the last update land before measuring delivery.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  } else {
    await new Promise((resolve) => setTimeout(resolve, options.seconds * 1000));
  }

  const framesReceived = viewers.reduce((total, viewer) => total + viewer.frames, 0);
  const delivered = viewers.reduce((total, viewer) => total + viewer.seenRevisions.size, 0);
  for (const viewer of viewers) viewer.socket.close();

  return {
    viewers: options.viewers,
    connected: viewers.length,
    failedToConnect,
    framesReceived,
    updatesPublished,
    deliveryRatio:
      updatesPublished === 0 || viewers.length === 0 ? 1 : delivered / (updatesPublished * viewers.length),
    latency: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies.length === 0 ? 0 : Math.max(...latencies),
    },
    connectMs: {
      p50: percentile(connectTimes, 0.5),
      p95: percentile(connectTimes, 0.95),
      max: connectTimes.length === 0 ? 0 : Math.max(...connectTimes),
    },
    durationMs: Date.now() - started,
    disconnects,
  };
}

export function formatLoadReport(report: LoadReport): string {
  return [
    '',
    'QBLive load test',
    `  spectators requested   ${report.viewers}`,
    `  connected              ${report.connected}`,
    `  failed to connect      ${report.failedToConnect}`,
    `  disconnected mid-test  ${report.disconnects}`,
    `  connect p50 / p95 / max  ${report.connectMs.p50} / ${report.connectMs.p95} / ${report.connectMs.max} ms`,
    '',
    `  updates published      ${report.updatesPublished}`,
    `  frames received        ${report.framesReceived}`,
    `  delivery ratio         ${(report.deliveryRatio * 100).toFixed(1)}%`,
    `  latency p50 / p95 / p99 / max  ${report.latency.p50} / ${report.latency.p95} / ${report.latency.p99} / ${report.latency.max} ms`,
    '',
    `  duration               ${(report.durationMs / 1000).toFixed(1)}s`,
    '',
  ].join('\n');
}

/**
 * Model APNs channel consumption for a set of tournaments.
 *
 * Not a network test — arithmetic over the sharding rules, run as a check that the design's central
 * claim holds: channel count scales with *active shards*, never with viewers. It is here rather
 * than in a comment because the claim is the reason Apple's 10 000-channel ceiling is not a
 * constraint, and a claim like that should be checkable.
 */
export interface ChannelModelTournament {
  teams: number;
  /** Fraction of teams somebody actually started a Live Activity for. */
  adoption: number;
}

export interface ChannelModelReport {
  tournaments: number;
  teams: number;
  /** If a channel existed per team. */
  naiveChannels: number;
  /** If every shard were created eagerly. */
  eagerChannels: number;
  /** What lazy creation actually consumes. */
  lazyChannels: number;
  ceiling: number;
  withinBudget: boolean;
}

export function modelChannelUsage(
  tournaments: ChannelModelTournament[],
  teamsPerShard = 16,
  ceiling = 8000,
): ChannelModelReport {
  let teams = 0;
  let naive = 0;
  let eager = 0;
  let lazy = 0;
  for (const tournament of tournaments) {
    const shards = Math.ceil(tournament.teams / teamsPerShard);
    teams += tournament.teams;
    naive += tournament.teams;
    eager += shards;
    // Lazy: a shard exists once anybody in it starts an Activity. With adoption `a` and `n` teams
    // per shard, the chance a given shard has nobody is (1-a)^n.
    const shardActive = 1 - Math.pow(1 - tournament.adoption, teamsPerShard);
    lazy += Math.ceil(shards * shardActive);
  }
  return {
    tournaments: tournaments.length,
    teams,
    naiveChannels: naive,
    eagerChannels: eager,
    lazyChannels: lazy,
    ceiling,
    withinBudget: lazy <= ceiling,
  };
}
