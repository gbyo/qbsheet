# QBSheet

QBSheet is an offline-first electronic scoresheet for quiz bowl. It runs entirely in a web browser.

You can use QBSheet to score a game from a QBJ file. You can also connect it to tournament-control software with QBTCP. For practices and scrimmages, you can create a game directly in QBSheet.

QBSheet works as a website or an installable PWA. Standalone scoring does not require an account, a database, or an internet connection.

The repository also includes QBSheet Director, the desktop tournament-control application. It is a
separate application under [`apps/director`](apps/director) with its own Vite config and Tauri shell,
and it is not part of the website: the deployed site has no URL that launches tournament control. See
[running Director](#run-director) below, and the product page at `/about/director/`.

## The QBSheet family

| | What it is |
| --- | --- |
| **QBSheet Web / Scorer** | The browser scoresheet. Offline-first, no account, QBTCP client. |
| **QBSheet Director** | The desktop tournament-management application. Authoritative tournament state, local SQLite, QBTCP server. |
| **QBSheet Live** | The participant-facing half: a native iOS app, an App Clip, a responsive web client, and an open protocol for publishing a tournament. |

The website carries the scorer plus a marketing page for each of the other two, at `/about/director/`
and `/about/qblive/`. Director is installed on the tournament-control computer; QBSheet Live Web is
served from `live.qbsheet.com`. Neither runs on the QBSheet website.

**Director runs the tournament. Live publishes the tournament.**

QBSheet Live is entirely optional and is never required for scoring, QBTCP, scheduling, result
acceptance, advancement, statistics, recovery, or persistence. If the internet disappears mid-day,
the tournament continues normally and Live catches up afterwards. A tournament's public data lives in
the tournament director's own infrastructure — QBSheet does not host it and does not pay for it.

See [the QBSheet Live architecture](docs/QBLIVE_ARCHITECTURE.md) and
[the QBLive protocol](docs/QBLIVE.md).

## Features

* **Offline scoring**: Score games without an internet connection.
* **QBJ support**: Open and export Quiz Bowl JSON files.
* **Tournament integration**: Connect to compatible tournament-control software with [QBTCP](docs/QBTCP.md).
* **Create a game**: Enter teams, players, and scoring rules directly in QBSheet.
* **Local recovery**: QBSheet saves an in-progress game on the device.
* **Corrections and substitutions**: Correct scoring errors and change lineups during a game.
* **Portable results**: Download completed or in-progress games as QBJ files.
* **Tournament spreadsheet copy**: Copy one completed game to a new spreadsheet tab; see [the spreadsheet clipboard workflow](docs/SPREADSHEET_CLIPBOARD.md).
* **Guided practice**: Learn how to use the scorer with a built-in tutorial.
* **Static hosting**: Host QBSheet without a QBSheet application server.
* **Publish a tournament**: Give participants schedules, standings, results, and updates with [QBSheet Live](docs/QBLIVE_ARCHITECTURE.md), on a server the tournament controls.

## Use QBSheet

There are three primary ways to start a game.

### Open a QBJ file

Open a QBJ assignment or tournament file.

If the file contains more than one game, select the game that you want to score.

After the game, export the result as a QBJ file.

QBSheet can also read legacy `.qbg` files for compatibility.

### Connect to tournament control

QBSheet can connect to tournament-control software that supports QBTCP.

Enter the tournament server address. Pair the room with the server. QBSheet can then receive game assignments and send results to the tournament system.

QBSheet also keeps local recovery data on the device.

For protocol information, see [QBTCP](docs/QBTCP.md).

### Create a game

You do not need a tournament system to use QBSheet.

Select **Create game**. Enter the two teams, the players, and the scoring rules. You can then start the game.

This mode is useful for practices, scrimmages, tryouts, and pickup games.

Created games use the same scorer, corrections, recovery features, and QBJ export as other QBSheet games.

## QBJ and QBTCP

QBSheet uses two standards for interoperability.

* **[QBJ](docs/QBJ_ASSIGNMENT_PROFILE.md)** contains game and tournament data.
* **[QBTCP](docs/QBTCP.md)** provides live communication between QBSheet and tournament-control software.

QBTCP uses QBJ for game data. File-based games and connected games therefore use the same game format.

## Development

QBSheet requires Node.js 20 or later.

```sh
git clone https://github.com/gbyo/qbsheet.git
cd qbsheet
npm ci
npm start
```

Vite starts the local development server.

### Run Director

Director is a separate application and does not run from the root Vite server.

```sh
npm run director:dev        # the Director user interface, on http://127.0.0.1:1420
npm run director:tauri:dev  # the real desktop application, with its native storage and QBTCP server
npm run director:build      # typecheck and build the Director frontend
npm run director:test       # the Director shell's own suite
```

The local QBTCP listener and the durable tournament store exist only in the native shell, so the
browser-served user interface can plan a tournament but cannot run one. See
[`apps/director/README.md`](apps/director/README.md).

Run these checks before you submit a change:

```sh
npm run lint
npm run typecheck
npm test -- --run
npm run build
```

QBSheet Live has its own suites. The Cloudflare and iOS ones need `workerd` and Xcode, so they run in
a separate workflow rather than in the main gate:

```sh
npm run qblive:test     # protocol, public projection privacy, Live Activity payloads, conformance
npm run live:test       # QBSheet Live Web
npm run live:dev        # QBSheet Live Web against a running backend
```

Run the browser end-to-end tests with:

```sh
npm run test:browser
```

For more development information, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Deployment

QBSheet builds as a static site. You can host it on GitHub Pages, Cloudflare Pages, or another static host.

Build the production version with:

```sh
npm ci
npm run build
```

The build output is in `dist/`.

QBSheet uses relative asset paths by default. The same build can work at a domain root, in a repository path, or from a local copy.

Set `BASE_PATH` if the deployment requires a specific base path:

```sh
BASE_PATH=/qbsheet/ npm run build
```

The service worker provides the application shell for offline use.

## Documentation

| Document                                                 | Description                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| [QBTCP](docs/QBTCP.md)                                   | Protocol for communication with tournament-control software |
| [QBJ assignment profile](docs/QBJ_ASSIGNMENT_PROFILE.md) | How QBSheet reads and writes QBJ                            |
| [Transfers](docs/TRANSFERS.md)                           | Moving assignments and results by USB, folders, and downloads |
| [QBG migration](docs/QBG_MIGRATION.md)                   | Compatibility information for the older QBG and API formats |
| [Spreadsheet clipboard](docs/SPREADSHEET_CLIPBOARD.md)   | Copy one complete game into a shared tournament spreadsheet |
| [Test file generation](docs/TEST_FILE_GENERATION.md)     | Information about test files and development fixtures       |
| [QBSheet Live architecture](docs/QBLIVE_ARCHITECTURE.md) | How Live fits together, and the canonical domain decision   |
| [QBLive protocol](docs/QBLIVE.md)                        | The normative public protocol for publishing a tournament   |
| [QBSheet Live for iOS](docs/QBLIVE_IOS.md)               | iOS targets, universal links, App Store Connect checklist   |
| [Live Activity](docs/QBLIVE_ACTIVITY.md)                 | ActivityKit sharding and measured broadcast payload sizes   |
| [APNs prototype result](docs/QBLIVE_PUSH_PROTOTYPE.md)   | What was measured about reaching Apple's push endpoints     |
| [Live load results](docs/QBLIVE_LOAD.md)                 | WebSocket load, and APNs channel-consumption modelling      |
| [Live verification status](docs/QBLIVE_STATUS.md)        | What is demonstrated, what is tested, and what is not        |

## Contributing

Bug reports, tournament testing, documentation, and code contributions are welcome.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request.

The [Code of Conduct](CODE_OF_CONDUCT.md) applies to project participation.

Report security problems as described in [SECURITY.md](SECURITY.md). Do not report a security problem in a public issue.

## License

QBSheet is available under the [GNU Affero General Public License version 3 or later](LICENSE).

QBSheet includes work derived from the YellowFruit project. See [NOTICE.md](NOTICE.md) for attribution and project history.
