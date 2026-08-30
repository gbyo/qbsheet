# QBSheet

QBSheet is an electronic scoresheet for quiz bowl. It runs in a web browser. It works offline.

A room can score a complete game from one QBJ file. The room does not need an account, a database,
or a network connection.

QBSheet reads and writes QBJ files. QBSheet also connects to tournament control software with
QBTCP.

## Where to start

| Your role | Read this page |
| --- | --- |
| You score games in a room | [Start here](Start-here) |
| You run a tournament and you hand out files | [Score a game from a file](Score-a-game-from-a-file) |
| You run tournament control software | [Score a connected game](Score-a-connected-game) |
| You prepare Chromebooks before an event | [Prepare a device](Prepare-a-device) |
| You lost a game and you want it back | [Recovery and backups](Recovery-and-backups) |
| You write other quiz bowl software | [QBTCP for implementers](QBTCP-for-implementers) |
| You host the application | [Install and host](Install-and-host) |
| You change the code | [Develop and contribute](Develop-and-contribute) |

## The three ideas behind QBSheet

1. **Files are QBJ.** One format holds an assignment, a result, and a mid-game backup.
2. **The network is QBTCP.** QBTCP is the live conversation between a scoresheet and tournament
   control software.
3. **The device keeps the game.** The browser writes every scored question to local storage first.
   A lost network connection does not stop the scoresheet.

## What QBSheet does not do

- QBSheet does not calculate tournament standings. Tournament control software does that.
- QBSheet does not guess a scoring format. If the file does not give the rules, QBSheet asks you.
- QBSheet does not send a game to any server other than the tournament control server that you
  type in. There is no analytics code and no telemetry code.
- QBSheet does not delete your local copy of a game because a server accepted it.

## Related pages

- [During the game](During-the-game)
- [Finish a game](Finish-a-game)
- [Files and formats](Files-and-formats)
- [Troubleshooting](Troubleshooting)
- [Glossary](Glossary)

## Licence

QBSheet is available under the GNU Affero General Public Licence, version 3 or later. QBSheet comes
from the first-party scorer in YellowFruit and Fruity. The `NOTICE.md` file in the repository
records that history.
