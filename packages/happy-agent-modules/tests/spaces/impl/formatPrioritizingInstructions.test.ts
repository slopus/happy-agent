import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import {
    formatPrioritizingInstructions,
    PRIORITIZING_REVISION,
} from "../../../sources/spaces/impl/formatPrioritizingInstructions.js";

/**
 * Every revision of Prioritizing's instructions, oldest first, with the digest of its text. A
 * running Prioritizing hears about new instructions only when the revision rises, so changing the
 * text means adding a row here with the next revision and raising PRIORITIZING_REVISION to match.
 */
const REVISIONS: readonly { readonly revision: number; readonly sha256: string }[] = [
    { revision: 2, sha256: "f40d25bc2aa5cb091a3b4bfe151cdbec77e10941f0b251521853e6fdb4f7d11f" },
    { revision: 3, sha256: "3be0ce92f1a88c95d86102bdf3796d04b74e2f64d95be34fe8aee15ed2f8dee7" },
    { revision: 4, sha256: "1c13954d59d979586cd4d915fe306d901b44514e8c872cf6a0e6dd233a408114" },
    { revision: 5, sha256: "c87cbae3a88dc77de349217f7b9f8e51d5f1389546dfc46c2909572d0f4476c5" },
    { revision: 6, sha256: "cf9d747ef58f3502258b761c14f9498a86983c28dd2c0b81d08d09df6eb5c759" },
    { revision: 7, sha256: "1294100c86d9f140be3ed18b792b27d21fe71c72f0fe67aa97b3aefd2a5af3e8" },
    { revision: 8, sha256: "496b1a5d3eb7a90727057e47673140ca78c402608a361621e4f9783223149d59" },
    { revision: 9, sha256: "b7be2920703a24f9c185d83dd8b6495fcdd0d702ebe32a8017ce303bc898732e" },
    { revision: 10, sha256: "aa28578fede6329b1d5e181f0a182c46b302e510cc09113151f88788ef6062c4" },
];

it("offers the voice icons", () => {
    const text = formatPrioritizingInstructions();
    for (const slug of ["waveform", "microphone", "headphones"]) expect(text).toContain(slug);
});

it("orders free-form sections by importance below a fixed header, within the budget", () => {
    const text = formatPrioritizingInstructions();
    expect(text).toContain("You are the Focus Agent");
    // Priorities come from the person's words only, and are guessed aloud until they state any.
    expect(text).toContain('end your reply with one line "Priorities: …"');
    expect(text).toContain("Only their explicit words change it");
    expect(text).toContain('"Priorities (my guess): …"');
    // A fixed header, then sections it names freely; order is the one rule.
    expect(text).toContain("<happy-search/>, <happy-create/>, Happy's row, then your own row");
    expect(text).toContain("Names may change from day to day");
    expect(text).toContain(
        "The one rule is order: sections run from most to least important, and rows inside each section do too.",
    );
    // Waiting on the person is the row's dot, not a section.
    expect(text).toContain('"Waiting on you" is not a section.');
    expect(text).not.toContain('label="Waiting on you"');
    expect(text).not.toContain('label="In hand"');
    // The day starts by agreeing on what matters.
    expect(text).toContain("What matters today?");
    expect(text).toContain("At most 10 rows shown");
    expect(text).toContain("fold the lowest sections first");
    expect(text).toContain("At most 6 sections");
    expect(text).toContain("Over budget is not a resting state");
    expect(text).not.toContain("Doing nothing is usually right");
    // Shipping needs explicit evidence, and real work is never nagged about.
    expect(text).toContain("Approval alone is not shipping.");
    expect(text).toContain("Never nudge about releases, regressions, bug fixes");
    // Its own row is part of the header, never nested under Happy.
    expect(text).toContain("Your own row is part of the header: right after Happy's row");
    expect(text).toContain("never nest your conversation under Happy");
    // After the update, one bold reorganization through the ordinary proposal.
    expect(text).toContain("make one bold proposal that brings the sidebar to this layout");
});

it("cleans up aggressively, archiving by itself only what explicitly shipped", () => {
    const text = formatPrioritizingInstructions();
    expect(text).toContain("is a real target, not a guideline: fold the lowest sections first");
    // Every proposal offers what qualifies; Focus archives by itself only what explicitly shipped.
    expect(text).toContain(
        'Every proposal carries an <happy-section id="archive" label="Archive"/> block',
    );
    for (const reason of ["shipped:", "idle for over 48 hours", "greeting-only", "superseded:"])
        expect(text).toContain(reason);
    expect(text).toContain(
        "with archive_shipped_task only once its work has explicitly shipped or finished",
    );
    expect(text).toContain("Approval, a passing test, or a quiet conversation is not shipping.");
    expect(text).toContain(
        "Everything else that qualifies is archived only when the person accepts a proposal.",
    );
    expect(text).not.toContain("You never archive anything yourself");
    // A teammate's mention reaches the sidebar only through the person's own Focus.
    expect(text).toContain("Add it with join_task only when it concerns what they do or follow");
    // A proposal that sits undecided shrinks rather than grows.
    expect(text).toContain("revise it down to a smaller one");
    // Sessions show only while they wait on the person, bulk-shown ones included.
    expect(text).toContain("only while it waits on the person");
    expect(text).toContain("Running or changing code alone is never a reason.");
    expect(text).toContain("including ones a bulk Show subtasks put in");
    expect(text).not.toContain("one changing code in a repository");
});

it("raises the instructions revision with every change to their text", () => {
    const sha256 = createHash("sha256").update(formatPrioritizingInstructions()).digest("hex");
    const latest = REVISIONS.at(-1)!;
    expect(
        { revision: PRIORITIZING_REVISION, sha256 },
        "Prioritizing's instructions changed: add a row to REVISIONS with the next revision and this digest, and raise PRIORITIZING_REVISION to it, so running Prioritizing agents are told on the next start.",
    ).toEqual(latest);
    // Every revision is newer than the one before it, and no text comes back under a new number.
    REVISIONS.forEach((row, index) => {
        if (index > 0) expect(row.revision).toBeGreaterThan(REVISIONS[index - 1]!.revision);
    });
    expect(new Set(REVISIONS.map((row) => row.sha256)).size).toBe(REVISIONS.length);
});
