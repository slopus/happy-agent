import { withAgentConfig } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { ChatMediaModule } from "../../sources/chatMedia/index.js";
import { ChatUiModule } from "../../sources/chatUi/index.js";
import { ComputeModule } from "../../sources/compute/index.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { HistoryModule } from "../../sources/history/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { testConfig } from "../support/computeModule.js";
import { FakeCompute } from "./support/FakeCompute.js";

const AGENT_ID = "agentone";

/** Chat UI with Compute's `media` contributed to it, on a machine the test fills. */
function mediaWorld() {
    const machine = new FakeCompute();
    const history = new HistoryModule();
    const chatUi = new ChatUiModule(testConfig, history, new DurableFunctionsModule());
    const compute = ComputeModule.withProvider(
        testConfig,
        new SecretsModule(),
        { id: "host", create: async () => machine },
        undefined,
        undefined,
        new ChatMediaModule(testConfig, history),
        chatUi,
    );
    const ctx = withAgentConfig(createRootContext().named("happy-agent-modules-media-component"), {
        modules: { compute: { cwd: machine.cwd, providerId: "host" } },
    });
    return { machine, chatUi, compute, ctx };
}

async function picture(width: number, height: number): Promise<Buffer> {
    return await sharp({
        create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } },
    })
        .png()
        .toBuffer();
}

function place(machine: FakeCompute, path: string, bytes: Uint8Array): void {
    machine.files.set(path, { content: "", bytes, mtimeMs: 1 });
}

describe("the media component", () => {
    it("is served by Compute, and only with chat media to keep the files", () => {
        expect(mediaWorld().chatUi.components).toEqual(["file_tree", "default_model", "media"]);

        const chatUi = new ChatUiModule(
            testConfig,
            new HistoryModule(),
            new DurableFunctionsModule(),
        );
        ComputeModule.withProvider(
            testConfig,
            new SecretsModule(),
            { id: "host", create: async () => new FakeCompute() },
            undefined,
            undefined,
            undefined,
            chatUi,
        );
        expect(chatUi.components).toEqual(["file_tree", "default_model"]);
    });

    it("turns the paths a model writes into indexes into the document's one media list", async () => {
        const { machine, chatUi, ctx } = mediaWorld();
        place(machine, "/workspace/before.png", await picture(8, 4));
        place(machine, "/workspace/after.png", await picture(4, 8));
        place(machine, "/workspace/report.pdf", Buffer.from("%PDF-1.7\n%fake\n"));

        const built = await chatUi.document(ctx, AGENT_ID, [
            {
                id: "shots",
                type: "media",
                props: {
                    items: [
                        { path: "before.png", label: "Before" },
                        { path: "/workspace/after.png", label: "After" },
                    ],
                },
            },
            { id: "tree", type: "file_tree", props: { paths: ["report.pdf"] } },
            { id: "paper", type: "media", props: { items: [{ path: "report.pdf" }] } },
        ]);

        if ("problems" in built) throw new Error(built.problems.join(" "));
        // One list for the whole document, in the order the components named their files.
        expect(built.items.map((item) => [item.kind, item.name])).toEqual([
            ["image", "before.png"],
            ["image", "after.png"],
            ["document", "report.pdf"],
        ]);
        expect(built.items[0]).toMatchObject({ width: 8, height: 4 });
        // The second media component's index continues where the first one's stopped.
        expect(built.document.components).toEqual([
            {
                id: "shots",
                type: "media",
                fallback: "2 images: Before · After",
                props: {
                    items: [
                        { mediaIndex: 0, label: "Before" },
                        { mediaIndex: 1, label: "After" },
                    ],
                },
            },
            {
                id: "tree",
                type: "file_tree",
                fallback: "report.pdf",
                props: { paths: ["report.pdf"] },
            },
            {
                id: "paper",
                type: "media",
                fallback: "1 file",
                props: { items: [{ mediaIndex: 2 }] },
            },
        ]);
    });

    it("tells the model which file could not be shown, and shows nothing", async () => {
        const { machine, chatUi, ctx } = mediaWorld();
        place(machine, "/workspace/empty.png", new Uint8Array());

        const built = await chatUi.document(ctx, AGENT_ID, [
            { id: "shots", type: "media", props: { items: [{ path: "empty.png" }] } },
            { id: "more", type: "media", props: { items: [{ mediaIndex: 0 }] } },
        ]);

        expect(built).toEqual({
            problems: [
                'shots: "empty.png" is empty.',
                expect.stringContaining("more: the media props are invalid"),
            ],
        });
    });

    it("asks for an Auto review only when a file lies outside the workspace", async () => {
        const { machine, chatUi, ctx } = mediaWorld();
        place(machine, "/workspace/inside.png", await picture(2, 2));
        place(machine, "/elsewhere/outside.png", await picture(2, 2));
        const media = (path: string) => [
            { id: "shots", type: "media", props: { items: [{ path }] } },
        ];

        expect(await chatUi.shouldReview(ctx, AGENT_ID, media("inside.png"))).toBe(false);
        expect(await chatUi.shouldReview(ctx, AGENT_ID, media("/elsewhere/outside.png"))).toBe(
            true,
        );
        // Props that are not the component's are never passed to its review; the call fails later.
        expect(
            await chatUi.shouldReview(ctx, AGENT_ID, [
                { id: "shots", type: "media", props: { items: "outside.png" } },
            ]),
        ).toBe(false);
        expect(chatUi.describeReview(["file_tree", "media"])).toBe(
            "showing chat UI (file_tree, media) to the person in this chat. Access: media components read local files (outside-workspace or symlink targets require full access) and copy them into this installation's private chat media",
        );
    });
});
