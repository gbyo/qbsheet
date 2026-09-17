# Finish a game

This page tells you how to close a game and what QBSheet asks for after the last question.

## Step 1. End regulation play

1. Open the Game / More menu.
2. Select **End regulation**.

If the format needs overtime, QBSheet starts overtime with the rules from the format.

## Step 2. Review and submit

QBSheet shows a review before it sends anything. This screen is where you make the result correct.

1. Read every warning. A warning names an unfinished question or a tie.
2. Fix every blocker. QBSheet does not send a result while a blocker is open.
3. Select **Final score confirmed with both teams**.
4. Select **Submit result**.

## Step 3. Read the completion screen

The completion screen tells you two things: the final score, and where the result is. It then gives
you one action.

There is always one main button. The button is the next thing to do. If QBSheet asks for nothing,
the button takes you out of the screen.

### A connected game that the server accepted

```
FINAL
Round 6 · Room 3

Asheville A       345
Asheville B       280

✓ Result sent
Tournament control has this result.

        [ Back to Room 3 ]

          Game details
```

1. Read the line **Result sent**. The server has the result.
2. Select **Back to Room 3**.

The room screen shows the next assignment, or it shows that the room waits.

A connected game is complete when the server accepts the result. QBSheet does not ask for a file and
does not ask for a confirmation. You can leave.

Two other lines mean the same thing:

| Line | Meaning |
| --- | --- |
| **Result received** | The server has the result. A director will look at it. |
| **Result already on record** | The server had this result before. This is not an error. |

You can leave the screen in all three cases.

### A connected game that is still sending

```
Sending result…
QBSheet is still trying automatically.
```

QBSheet repeats the request by itself. Do not wait for it.

1. Select **Download QBJ**. This file is the result.
2. Hand the file over as your room instructs.
3. Select **I handed off the result**.

If the server accepts the result while you are on this screen, the screen changes by itself. The line
becomes **Result sent** and the way out opens.

### A connected game that the server refused

```
Result was not accepted

Round 6 has already been closed by tournament control.

Your game is still saved on this device.

        [ Download QBJ ]
```

QBSheet shows the reason from tournament control. Read the reason to the staff. The reason tells the
staff what to do.

1. Select **Download QBJ**.
2. Hand the file over as your room instructs.
3. Select **I handed off the result**.

The game stays on this device. Nothing is lost.

### A file-only game

A file-only game has no server. The QBJ file **is** the result.

```
FINAL

Asheville A       345
Asheville B       280

Result needs to be handed over
Save the tournament result file before leaving.

        [ Download QBJ ]
```

1. Select **Download QBJ**.
2. Give the file to the staff. Follow the instruction for your room.

A file-only game is complete after QBSheet writes the QBJ file without an error. QBSheet does not ask
for a confirmation, because no instruction asked for one.

### A game with an explicit handoff instruction

Some tournaments attach an instruction to the assignment. QBSheet shows the instruction on the
completion screen, in the words of the tournament.

An instruction asks for the file, even when the server accepted the result.

1. Read the instruction.
2. Select **Download QBJ**.
3. Do what the instruction says.
4. Select **I handed off the result**.

QBSheet keeps the screen locked until it records the confirmation.

**Caution:** the confirmation records what you say you did. QBSheet cannot look in a shared drive, a
folder, or an email. Do the handoff before you select the button.

### A practice, a scrimmage, or a game you made on this device

```
FINAL

Asheville A       345
Asheville B       280

✓ Saved on this device

          [ Done ]

        Game details
```

Nobody waits for this result. QBSheet asks for no file and no confirmation.

Select **Done**.

## Game details

**Game details** opens the tools that are not part of an ordinary finish. Select it when you need
one of them.

| Section | Holds |
| --- | --- |
| Result details | The teams, the round, the room, the final score, the tossups heard, and the delivery times. |
| Statistics | The player lines, and **Copy stats** for a spreadsheet. |
| Actions & files | **Correct result**, **Download QBJ**, **Download Excel scoresheet**, and **Start a rematch**. |

### Correct a result

1. Select **Game details**.
2. Select **Correct result**.

QBSheet opens the saved game in the scoresheet. Make the correction. If you already sent the result,
submit it again.

### The two files

| File | Use |
| --- | --- |
| QBJ | The portable result. Use this file for a handoff and for recovery. |
| Excel | A readable scoresheet. Use this file for review. |

A QBJ is useful after a good delivery. A server message is not a backup. Download one when you have a
moment. QBSheet does not ask for one, because the result already arrived.

## What happens to the record

- QBSheet keeps a completed record on the device for seven days.
- QBSheet keeps a record of a game you made on this device for thirty days.
- QBSheet does not delete a record because a server accepted the result.
- QBSheet does not delete a record because you downloaded a QBJ file.
- QBSheet does not delete a record because you left the completion screen.
- The start screen lists recent games. You can open a record again from that list.

## A result keeps the identity of the assignment

A result carries the same identifiers as the assignment. The tournament, the phase, the round, the
match, the teams, and the players keep their identifiers.

Because of this, tournament control software finds the game with a direct lookup. It does not guess
from a file name.

## Related pages

- [Recovery and backups](Recovery-and-backups)
- [Files and formats](Files-and-formats)
- [Score a connected game](Score-a-connected-game)
- [Score a game from a file](Score-a-game-from-a-file)
