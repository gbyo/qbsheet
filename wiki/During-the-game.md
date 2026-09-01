# During the game

This page tells you how to score each question, how to correct a mistake, and how to use the game
menu. On a wide screen it is labelled **Game**; on a phone it is labelled **More**.

The scoresheet works the same way for a file-only game and for a connected game.

QBSheet follows the rules of the tournament during normal play. But a scoresheet must never trap a
room when the real game is different from the setup. Use **Game details** to correct the game itself,
and **Full scoresheet review** to correct what happened on a question. An unusual ruling from a
tournament director goes on the record without a change to the normal way you score. See
[When the setup does not match the room](#when-the-setup-does-not-match-the-room).

## The screen

| Area | Purpose |
| --- | --- |
| The two team panels | The players, the score, and the buzz buttons for each team |
| The question area | The current tossup or bonus, and the question number |
| The recent rail | The last questions, so you can look back without a dialog |
| The Game / More menu | Actions that are not a buzz. It is labelled **More** on a phone. |
| The connection indicator | Shown for a connected game only |

## Score a tossup

1. A player buzzes.
2. Select the player on that team panel.
3. Select the ruling for the answer.

QBSheet offers only the rulings that the format allows. A team that already answered is no longer
eligible for the same tossup.

To record a tossup that nobody answered:

- Select **No buzz**, or
- Push the space bar.

The space bar works only when the keyboard is not in a button, a field, or a dialog. In a control,
the space bar belongs to that control.

When one team is still eligible, the button reads *`<team>` has no answer*.

## Score a bonus

QBSheet shows the bonus prompt after a correct tossup answer, and asks for the bonus the way the
format defines one.

Where bonuses bounce back, the prompt asks who scored each part. Each part offers a button per
answer and every one of them says what it is: the team that took the tossup, the other team, or *No
points*. The totals for both teams are worked out as you go. When every part has an answer, press
*Record bonus* — it takes the keyboard focus at that point, so Enter records the bonus too. Choose
*Enter totals instead* if you were given the totals rather than the parts.

Where bonuses do not bounce back, the prompt offers the totals the format can produce and one press
records the bonus. *Score by part* is there if you would rather record each part.

A format whose bonus parts are not all worth the same asks for a number for each team instead, since
there is no fixed part value to offer.

## Undo a mistake

| Action | Keyboard |
| --- | --- |
| Undo | `Ctrl+Z`, or `Cmd+Z` on a Mac |
| Redo | `Ctrl+Shift+Z`, or `Cmd+Shift+Z` on a Mac |

The shortcut works only when no dialog is open and the keyboard is not in a control.

## Correct an earlier question

Undo is for the last action. Use a correction for an earlier question.

1. Open the Game / More menu.
2. Select **Full scoresheet review**.
3. Find the question.
4. Change the record for that question.

The menu also offers **Replace question `<number>`** for the current question.

## The game menu

The menu shows only the items that apply at this moment.

### Game

| Item | Purpose |
| --- | --- |
| **Notes** | Free text about the game |
| **Game details** | The game itself: the teams, the rosters, the rules, and the room procedure |

Use **Flag** in the footer to open a protest or report an issue. Those live-play workflows do not
appear a second time in this menu.

### Round

| Item | Purpose |
| --- | --- |
| **Lightning / worksheet** | Shown only when the format has a lightning round |
| **Timeout** | Start a timeout |
| **Resume play** | Leave a timeout or another break |
| **End first half** or **End this half** | Close the current half |
| **End regulation** | Close regulation play. Overtime can follow. |

### Review

| Item | Purpose |
| --- | --- |
| **Full scoresheet review** | Every question, and the place to correct one |
| **Replace question `<number>`** | Replace the current question |
| **Adjust score** | Change a score directly, when no question-level fix fits |

### Files

| Item | Purpose |
| --- | --- |
| **Export / backup…** | Open the export dialog. It contains the backup and any supported portable forms. |
| **Recover from QBJ** | Read a partial QBJ file back into the scoresheet |
| **Print scoresheet** | Print the scoresheet from the browser |

### End game

| Item | Purpose |
| --- | --- |
| **End game early…** | Stop the game before the end. This action is destructive. |
| **Record forfeit** | Record a forfeit. This action is destructive. |

## When the setup does not match the room

QBSheet follows the rules of the tournament during normal play. But a scoresheet must never trap a
room when the real game is different from the setup.

There are two different situations, and QBSheet keeps them apart.

| Situation | What to do |
| --- | --- |
| QBSheet recorded something wrong | Correct it |
| The room was told to do something different | Record the ruling |

### Correct the game

Open **Game details** from the Game / More menu. The page shows what this game is: the teams, the
rosters, the scoring rules, and the room procedure.

Each line has a small action next to it when you can change that line.

| Line | Action |
| --- | --- |
| A team | **Correct…** the name. Every question stays with the same team. |
| A roster | **Correct…** a player name. All the statistics of that player follow the new name. |
| Moderator | **Edit** the name of the reader |
| Scoring rules | **Correct…** the rules. QBSheet calculates every question again. |
| Room procedure | **Change…** the timeouts, the breaks, or the lineup rule |

QBSheet shows what a correction does before it writes anything.

Two names on one roster can be the same player. QBSheet does not combine them without a request. To
combine them, select **They are the same person — combine them**.

To correct what happened on a question, use **Full scoresheet review**. See
[Correct an earlier question](#correct-an-earlier-question).

### Record a ruling

A tournament director can allow something the procedure does not. For example, an extra timeout, or
a lineup change at a point the rules do not give.

QBSheet offers the route where the block happens.

1. Do the action. QBSheet refuses it and gives the reason.
2. Select **Procedure changed?** next to the reason, or **Allowed another one?** under the team.
3. Select **We were told we could, this once**.
4. Say why. A reason is necessary.
5. Select **Record this ruling**.

The action is now available one time. QBSheet records the ruling on the result, and shows it in
**Game details** and in the scoresheet review.

If the room was set up wrong from the start, select **This room was set up wrong** instead. That
changes the procedure for the rest of the game and keeps everything already recorded.

### Overtime that a correction removes

A correction can change the result of regulation. If regulation is no longer a tie, the overtime
tossups can be wrong.

QBSheet says this in **Full scoresheet review**. You have two answers:

- **Strike out the overtime**, and QBSheet calculates the score from regulation alone; or
- keep the tossups and record the ruling that allows them.

## Protests

A protest can stop play. The room procedure decides when.

1. Select **Flag** in the footer.
2. Select **Protest / disputed ruling**.
3. Record the protest.

When an open protest stops play, the tossup button reads **Resolve protest before play**. Resolve the
protest, then continue.

The procedure can also stop a checkpoint. Overtime and sudden death are two such checkpoints.

## Lineups and players

- Change a lineup at a halftime, at a timeout, or at a phase checkpoint. The room procedure decides.
- Add a player to a roster at any time before the game is complete.
- In a connected game, QBSheet sends a new player to the server. QBSheet marks a player that it did
  not send yet.
- A player who arrives late gets only the tossups after the change of lineup.
- To correct the name of a player, use **Game details**. To correct when a lineup started, open
  **Full scoresheet review** and change the effective tossup of that lineup.

## Two things QBSheet says before you finish

QBSheet separates a warning from a blocker.

| Kind | Meaning |
| --- | --- |
| A warning | Worth a look, but you can send the result. An unfinished question and a tie are two examples. |
| A blocker | QBSheet does not send the result until you fix this. |

## Related pages

- [Finish a game](Finish-a-game)
- [Recovery and backups](Recovery-and-backups)
- [Troubleshooting](Troubleshooting)
