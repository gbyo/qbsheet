# Troubleshooting

Find your problem in the list. Follow the steps in order.

## The browser will not save anything

The start screen shows a red warning. It says that a closed tab can lose a game scored here.

1. Close the private browser window. Open a normal window.
2. Allow site data for the QBSheet address in the browser settings.
3. Reload the page.
4. Select **Check this device**. Read **Game storage** and **Emergency journal**.

If the warning stays, you can still score. Download a QBJ file when the game starts and again when the
game ends.

## The scoresheet cannot reach the server

1. Check the address. It must include the scheme, for example `http://192.168.1.20:8080`.
2. Check that the device is on the same network as the server.
3. Ask the staff to add the QBSheet address to the origin list on the server.
4. Select **Check this device**, then run the connection test under **Tournament control**.

Two causes are common:

- **Safari.** Safari cannot use connected scoring over the current path from HTTPS to a local HTTP
  server. Use Chrome or Edge.
- **Local network permission.** Chrome and Edge ask for permission to reach a local address. Allow it.
  The connection test triggers the request.

## Pairing fails

Every pairing failure gives the same message. This is deliberate, so a stranger cannot find valid
rooms. So check each cause yourself:

1. Retype the code. Read each digit again.
2. Choose the correct room in the list, or choose **Any room**.
3. Ask the staff whether the room is enabled.
4. Wait, then try again. The server limits the rate of attempts, and it answers `429` after too many.

## The room has no assignment

The screen says that this room has nothing assigned yet.

1. Select **Check again**.
2. Ask the staff whether they released the round.

A blocked message has a different meaning. The server holds this room for a reason. Ask the staff.

## The connection dropped in the middle of a game

Continue to score. The game lives on this device.

- A failed snapshot does not change the score and does not block you.
- The scoresheet retries. It sends the current state, not a replay of what it missed.
- You can end the game and download the result with no connection at all.

## The server says that another device is scoring this game

One session has one writer. Another device holds the writer role.

1. Confirm with the room which device must score.
2. On the device that must score, select the takeover action.

**Do not run two devices as writers.** QBSheet never takes over by itself, because two authoritative
devices produce two different scoresheets.

## The device died in the middle of a game

Try these sources in order.

1. **The same device.** Open QBSheet again. Select **Resume** under **Unfinished game**.
2. **A partial QBJ file.** On another device, open the file that you downloaded. Or open the game menu
   and select **Recover from QBJ**.
3. **The server.** In a connected room, pair again on the new device and open the session. The server
   returns the state that the old device sent.

Read [Recovery and backups](Recovery-and-backups) for the limits of each source.

## QBSheet says that the file does not give enough scoring information

The QBJ file does not describe the format well enough. QBSheet will not assume a rule set.

1. Ask the staff for the format.
2. Choose or configure the format on the screen.
3. Continue to score.

## QBSheet asks for the players

The file names the teams but not the players.

1. Type each player name.
2. Set the starting lineup.

In a connected room, QBSheet sends a new player to the server. QBSheet marks a player that it did not
send yet.

## The same game is open in two tabs

QBSheet shows a duplicate-tab notice. Only one tab keeps control of the game.

1. Decide which tab to keep.
2. Close the other tab.

## A protest blocks play

The tossup button reads **Resolve protest before play**. The room procedure stops play while a protest
is open.

1. Open the game menu.
2. Select **Protests**.
3. Resolve the protest.

## QBSheet will not send the result

The review lists a blocker. A blocker is not a warning.

1. Read each blocker.
2. Fix the scoresheet.
3. Confirm the review again.

An unfinished question and a tie are warnings, not blockers. You can send a result with a warning.

## The result is on the server but I want a file too

Download it. Open the completion screen and select the download action. A message from a server is not
a backup.

QBSheet keeps a completed record on the device for seven days. The start screen lists recent games.

## Nothing here matches

1. Note whether the game was file-only or connected.
2. Note the browser and the device.
3. Open an issue in the repository and choose the form that fits.

**Do not paste a room token, a session token, or a pairing code into a public issue.**

## Related pages

- [Recovery and backups](Recovery-and-backups)
- [Prepare a device](Prepare-a-device)
- [During the game](During-the-game)
