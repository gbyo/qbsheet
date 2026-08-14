# Score a connected game

Use this workflow when tournament control software runs on the network. The scoresheet receives the
assignment for your room. The scoresheet sends the result back.

Fruity is one tournament control implementation. Other software can implement the same protocol.
Read [QBTCP for implementers](QBTCP-for-implementers).

## Before you start

You need three things:

- The address of the tournament control server, for example `http://192.168.1.20:8080`.
- The name or the number of your room.
- A pairing code from the tournament staff.

The scoresheet and the server must be on the same local network. The staff must add the QBSheet
address to the origin list on the server.

## Step 1. Type the server address

1. Find the section **Connect to tournament control** on the start screen.
2. Type the address in the field **Tournament control address**.
3. Select **Connect**.

QBSheet reads the discovery information from the server. QBSheet then shows the tournament name.

If QBSheet shows an error, read
[Troubleshooting](Troubleshooting#the-scoresheet-cannot-reach-the-server).

## Step 2. Pair the room

1. Choose your room in the list **Room**. Leave the value **Any room** if the staff did not give you
   a room.
2. Type the code in the field **Pairing code**.
3. Select **Pair this room**.

The server gives the browser a room token. The token is a capability for one room only. The token
cannot read another room and cannot read the tournament.

A failed pairing gives the same message for every cause. This is deliberate. A different message for
each cause would let a stranger find valid rooms.

## Step 3. Start the assigned game

1. Read the matchup on the screen. QBSheet names the two teams.
2. Select **Start scoring**.

Two other results are possible:

| The screen says | Do this |
| --- | --- |
| This room has nothing assigned yet | Wait, then select **Check again**. |
| A blocked message | Ask the staff. The server holds this room for a reason. |

QBSheet writes the assignment to the device before you score anything. After that point the network
is optional.

## Step 4. Score the game

Read [During the game](During-the-game).

While you score, QBSheet does two more things:

- QBSheet sends a snapshot of the game to the server. Each snapshot replaces the last one. A failed
  snapshot never blocks your scoring and never changes the score.
- QBSheet sends a heartbeat, so the tournament director can see that the room is alive.

The connection indicator shows the current state. A lost connection is not an error in the game.
Continue to score.

## Step 5. Send the result

1. End the game. Read [Finish a game](Finish-a-game).
2. QBSheet sends the result to the server. The screen shows **Result sent**.
3. Download the QBJ file as a backup.

Send the result twice and the server records one game. The server matches the game on the
identifiers and on a fingerprint of the statistics. A second copy is a duplicate, not an error.

## When two devices score one game

A device can die in the middle of a game. A second device can then take over. One session has one
writer at a time.

1. Open the game on the second device.
2. QBSheet reports that another device is scoring this game.
3. Select the takeover action. A person must do this.

The first device learns that it lost the writer role at its next write. The first device tells its
operator. It does not throw away the work.

**Caution:** QBSheet never takes over by itself after a failed write. Two live devices that both
believe that they are authoritative produce two different scoresheets.

## What the server never receives

The scoresheet sends only QBJ documents and the operational fields that the protocol defines. The
scoresheet does not send the private recovery journal.

The files that you download are also clean. A portable file never holds a room token, a session
token, a pairing code, a device identifier, or a server address.

## Related pages

- [QBTCP for implementers](QBTCP-for-implementers)
- [Prepare a device](Prepare-a-device)
- [Troubleshooting](Troubleshooting)
