import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

it("hears the person's messages in new work, files it into topic sections and a folded Distractions section, shows a session waiting for review, and never moves what the person placed", async () => {
    const h = await sidebarGym();
    try {
        const prioritizingSaw = (text: string) =>
            h.gym.inference.requests.some(
                (request) =>
                    request.instructions.includes("You are the Focus Agent") &&
                    JSON.stringify(request.messages).includes(text),
            );
        await h.read();
        const release = await h.create();
        const bread = await h.create();
        // A vague first message says too little to place the work by; Prioritizing hears it at once.
        await h.gym.send("Can you help me with something?", { sessionId: release.agent.id });
        await h.gym.send("What makes sourdough rise?", { sessionId: bread.agent.id });
        await h.gym.waitUntil(
            () => (prioritizingSaw("Can you help me with something?") ? true : undefined),
            "the first-message brief",
        );
        expect(prioritizingSaw("If its subject is clear")).toBe(true);

        // A later message in work not yet placed may make its subject clear, so it wakes
        // Prioritizing, with the agent's reply it answers.
        await h.gym.send("Ship the Android beta by Friday.", { sessionId: release.agent.id });
        const brief = [
            `Conversation in ${release.space.id}: the person wrote in row ${release.space.id}.`,
            "Agent before it: Done.",
            "Person: Ship the Android beta by Friday.",
        ].join("\\n");
        await h.gym.waitUntil(
            () => (prioritizingSaw(brief) ? true : undefined),
            "the conversation brief",
        );

        // With the subject clear, Prioritizing places both: a topic section, and Distractions folded.
        const before = await h.read();
        const row = (id: string) => `  <happy-space id="${id}"/>\n`;
        const placed = before.html
            .replace(row(release.space.id), "")
            .replace(row(bread.space.id), "")
            .replace(
                "</nav>",
                [
                    '  <happy-section id="android" label="Android release"/>',
                    row(release.space.id).trimEnd(),
                    '  <happy-section id="distractions" label="Distractions" collapsed="true"/>',
                    row(bread.space.id) + "</nav>",
                ].join("\n"),
            );
        expect((await h.edit(placed)).text).toContain("queued");
        await h.settle();
        await h.gym.waitUntil(
            async () => ((await h.read()).html === placed ? true : undefined),
            "the placement",
        );

        // A subtask that stops waiting for review is told to Prioritizing under its row, with the
        // next notice: here, the person asking for a tidy.
        const subtask = /Created subtask ([a-z0-9]+)/.exec(
            (
                await h.call(
                    "create_subtask",
                    {
                        title: "Review patch",
                        text: "Prepare the patch for review.",
                        model: h.gym.selection.modelId,
                        effort: h.gym.selection.effort,
                        provider: h.gym.selection.providerId,
                    },
                    release.agent.id,
                )
            ).text,
        )![1]!;
        await h.gym.waitUntil(async () => {
            await h.settle();
            await h.gym.http.request("POST", "/v0/spaces/tidy", {});
            return prioritizingSaw(`session ${subtask} under row ${release.space.id} stopped`)
                ? true
                : undefined;
        }, "the stopped-session brief");
        const reviewing = (await h.read()).html.replace(
            row(release.space.id),
            `  <happy-space id="${release.space.id}" expanded="true">\n    <happy-space id="${subtask}"/>\n  </happy-space>\n`,
        );
        expect((await h.edit(reviewing)).text).toContain("queued");
        await h.settle();
        await h.gym.waitUntil(
            async () => ((await h.read()).html === reviewing ? true : undefined),
            "the session shown for review",
        );

        // The person files more work after the collapsed Distractions heading: it lands first in
        // that block, folded away.
        const errand = await h.create();
        await h.gym.send("Book the dentist.", { sessionId: errand.agent.id });
        const current = await h.read();
        const filed = await h.gym.client.applySpaceSidebarOperations({
            mutationId: "file-errand",
            baseVersion: current.version,
            operations: [{ type: "move", id: errand.space.id, to: { after: "distractions" } }],
        });
        expect(filed.html).toContain(
            `  <happy-section id="distractions" label="Distractions" collapsed="true"/>\n${row(errand.space.id)}${row(bread.space.id)}`,
        );
        // Prioritizing may not move what the person placed.
        const moved = filed.html
            .replace(row(errand.space.id), "")
            .replace(
                '  <happy-section id="android" label="Android release"/>\n',
                `  <happy-section id="android" label="Android release"/>\n${row(errand.space.id)}`,
            );
        expect((await h.edit(moved)).text).toContain("Keep the person's manual placement");
        expect((await h.read()).html).toBe(filed.html);
    } finally {
        await h.gym.dispose();
    }
}, 120000);
