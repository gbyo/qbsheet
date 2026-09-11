/** The tournament-day instructions, in the application rather than only in a README. */

const steps = `Before the tournament
1. Create and configure the tournament in YellowFruit.
2. Save the .yft.
3. Deploy the QBTCP Cloudflare relay and note its URL, tournament id, and setup token.
4. Open QBSheet Bridge.
5. Load the .yft.
6. Connect the relay.
7. Add a room for each room in use.

Each round
1. Choose the round.
2. Pick the two teams for every room.
3. Click Publish Round.
4. Scorekeepers scan the room's QR or type its pairing code into QBSheet Scorer.
5. Games are scored normally. The scorer already has the format; nobody sets one up in the room.

After games finish
1. Completed results appear here as they arrive.
2. Choose a results folder and click Save New Results.
3. In YellowFruit choose File → Import Games Only.
4. Select the saved .qbj files.
5. Review YellowFruit's import validation and import them.

If the relay goes away
Nothing local is lost. Rooms already holding an assignment keep scoring, QBBridge retries on its
next poll, and a failed publish says so rather than pretending the rooms were updated.

What QBBridge does not do
It does not schedule, seed, advance, rank, or keep statistics, and it never edits the .yft or
imports anything into YellowFruit for you. YellowFruit stays the tournament's authority.`;

export default function HelpView() {
  return (
    <section className="panel">
      <h2>Tournament day</h2>
      <pre className="help">{steps}</pre>
    </section>
  );
}
