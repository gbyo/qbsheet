from pathlib import Path

source = Path('src/integrations/fruity/FruityServerClient.ts')
text = source.read_text()
old = """  async discover(): Promise<IQbtcpDiscovery | null> {
    const result = await this.request<unknown>(qbtcpRoutes.discovery);
    this.discovery = result.ok ? readDiscovery(result.value) : null;
    const routes = routesFor(this.discovery);
    this.adapter =
      routes === qbtcpRoutes
        ? new QbtcpAdapter(this.requestFn, this.discovery as IQbtcpDiscovery)
        : routes.protocol === 'qbtcp/unsupported'
          ? new UnsupportedQbtcpAdapter(this.discovery as IQbtcpDiscovery)
          : new LegacyAdapter(this.requestFn);
    // Settled only when something answered. A `404` is an answer — it is how a pre-QBTCP server
    // says so — but nothing answering is not, and latching on it would pin a room to the deprecated
    // surface for the whole game because its Wi-Fi happened to be out at the moment it started.
    this.discoveryAttempted = result.ok || result.status !== undefined;
    return this.discovery;
  }
"""
new = """  async discover(): Promise<IQbtcpDiscovery | null> {
    const result = await this.request<unknown>(qbtcpRoutes.discovery);
    const discovery = result.ok ? readDiscovery(result.value) : null;
    const definitiveLegacy = !result.ok && result.status === 404;

    if (discovery) {
      this.discovery = discovery;
      const routes = routesFor(discovery);
      this.adapter =
        routes === qbtcpRoutes
          ? new QbtcpAdapter(this.requestFn, discovery)
          : routes.protocol === 'qbtcp/unsupported'
            ? new UnsupportedQbtcpAdapter(discovery)
            : new LegacyAdapter(this.requestFn);
      this.discoveryAttempted = true;
    } else if (definitiveLegacy) {
      // A missing discovery route is the definitive signal that this is a pre-QBTCP server.
      this.discovery = null;
      this.adapter = new LegacyAdapter(this.requestFn);
      this.discoveryAttempted = true;
    } else {
      // A transport failure, retryable HTTP response, or malformed successful body does not identify
      // a protocol. Keep discovery unresolved so the next operation probes again instead of pinning
      // this client to the deprecated surface until the scorekeeper reloads.
      this.discovery = null;
      this.discoveryAttempted = false;
    }
    return this.discovery;
  }
"""
if text.count(old) != 1:
    raise SystemExit('expected FruityServerClient discovery block exactly once')
source.write_text(text.replace(old, new, 1))

tests = Path('tests/Qbtcp.test.ts')
text = tests.read_text()
anchor = "  test('help request uses the room-scoped QBTCP envelope and returns normalized state', async () => {\n"
addition = """  test.each([429, 500, 502, 503])(
    'a transient %i discovery response is retried by the same client',
    async (status) => {
      let discoveryAttempts = 0;
      const { calls, fetchImpl } = recordingFetch((path) => {
        if (path === '/qbtcp/v1') {
          discoveryAttempts += 1;
          return discoveryAttempts === 1
            ? { status, body: { error: 'temporary discovery failure' } }
            : { body: qbtcpDiscovery };
        }
        if (path.startsWith('/api/v1')) return { status: 503, body: { error: 'legacy unavailable' } };
        return { body: assignmentDocument() };
      });
      const client = new FruityServerClient('http://control.test', fetchImpl);

      const first = await client.assignment(identity);
      expect(first.ok).toBe(false);
      expect(client.describeProtocol()).toEqual({ protocol: 'unknown' });

      const second = await client.assignment(identity);
      expect(second.ok).toBe(true);
      expect(client.isQbtcp).toBe(true);
      expect(client.describeProtocol()).toMatchObject({ protocol: 'qbtcp' });
      expect(discoveryAttempts).toBe(2);
      expect(calls.filter((call) => call.path === '/qbtcp/v1')).toHaveLength(2);
    },
  );

  test('a malformed successful discovery response is not latched as legacy', async () => {
    let discoveryAttempts = 0;
    const { fetchImpl } = recordingFetch((path) => {
      if (path === '/qbtcp/v1') {
        discoveryAttempts += 1;
        return discoveryAttempts === 1 ? { body: { status: 'ok' } } : { body: qbtcpDiscovery };
      }
      if (path.startsWith('/api/v1')) return { status: 404, body: { error: 'Not found' } };
      return { body: assignmentDocument() };
    });
    const client = new FruityServerClient('http://control.test', fetchImpl);

    await client.assignment(identity);
    expect(client.describeProtocol()).toEqual({ protocol: 'unknown' });

    const second = await client.assignment(identity);
    expect(second.ok).toBe(true);
    expect(client.isQbtcp).toBe(true);
    expect(discoveryAttempts).toBe(2);
  });

"""
if text.count(anchor) != 1:
    raise SystemExit('expected Qbtcp test insertion point exactly once')
tests.write_text(text.replace(anchor, addition + anchor, 1))
