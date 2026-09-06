# Install and host

QBSheet is a static web application. It needs no backend server. You can host it on any static host,
and you can also open a build from a local directory.

## Build the application

You need Node 22 or a later version.

```sh
git clone https://github.com/gbyo/qbsheet.git
```

```sh
cd qbsheet && npm ci
```

Then run the checks and the build:

```sh
npm run lint
```

```sh
npm run typecheck
```

```sh
npm test -- --run
```

```sh
npm run build
```

The build writes the site to `dist/`.

## Asset paths

Vite writes relative asset paths by default. So one build works at the root of a domain, below a
repository path, and from a local directory.

A deployment that needs an absolute path can set `BASE_PATH`:

```sh
BASE_PATH=/qbsheet/ npm run build
```

Run this form of the build before a pull request. It catches a change that only works at the root of a
domain.

## Host on GitHub Pages

1. Open the repository settings.
2. Open the **Pages** section.
3. Set the source to **GitHub Actions**.

The workflow publishes `dist/` with the official Pages actions. It needs no repository secret.

## The service worker

The build creates a service worker. It works like this:

- It precaches the application shell and the content-hashed assets.
- It uses a network-first strategy for a navigation, with the cached shell as the offline fallback.
- **It never caches a response from a tournament control server.**

The last rule is deliberate. A cached assignment or a cached acknowledgement is a correctness bug, not
a performance win. It is a confident wrong answer.

## Run the application for development

```sh
npm start
```

Vite normally serves the application at `http://localhost:5173`.

The application is fully usable with a QBJ file and no server at all. Open a game file and score.

## Test the connected path locally

1. Start the Local Tournament Server in Fruity.
2. Add the Vite address to the QBSheet origin setting of that server.
3. Type the local network address of the server in the scoresheet.

The origin allowlist covers CORS only. A room credential and a session credential still authenticate
every room operation.

## Rules for a host

Keep these constraints. They are features, not current limits.

- No analytics, no telemetry, no font host, and no script host.
- No call to any origin except a tournament control server that the operator typed in.
- The assets must work at the root of a domain, below a repository path, and from a local directory.
- The application must stay usable when storage is unavailable. It then says that storage is not
  durable.

## Use the core package in other software

The repository also publishes a browser-independent core. Fruity consumes it as a Git dependency, so
the desktop application and the browser application run the same scoring engine.

```sh
npm run build:core
```

The entry point is `src/core/index.ts`. It must stay free of React imports, DOM imports, and
persistence imports.

## Related pages

- [Prepare a device](Prepare-a-device)
- [Develop and contribute](Develop-and-contribute)
- [QBTCP for implementers](QBTCP-for-implementers)
