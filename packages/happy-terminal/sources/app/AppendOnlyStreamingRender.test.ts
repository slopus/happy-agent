import { describe, expect, it } from "vitest";

import { AppendOnlyStreamingRender } from "./AppendOnlyStreamingRender.js";

describe("AppendOnlyStreamingRender", () => {
    it("keeps newline-complete rows immutable when later source reinterprets them", () => {
        const stream = new AppendOnlyStreamingRender<object>();
        const entry = {};
        const render = (text: string): string[] => {
            const lines = text.trimEnd().split("\n");
            const definitionPresent = text.includes("[guide]:");
            return lines.map((line) =>
                definitionPresent && line.includes("[guide]") ? "linked guide" : line,
            );
        };

        expect(
            stream.render({
                entry,
                isStreaming: true,
                render,
                text: "Read [guide]\n\nfirst paragraph\npartial",
                width: 80,
            }),
        ).toEqual(["Read [guide]", "", "first paragraph", "partial"]);

        expect(
            stream.render({
                entry,
                isStreaming: true,
                render,
                text: "Read [guide]\n\nfirst paragraph\npartial done\n[guide]: target",
                width: 80,
            }),
        ).toEqual(["Read [guide]", "", "first paragraph", "partial done", "linked guide"]);
    });

    it("preserves the frozen prefix after completion and rebuilds after a width change", () => {
        const stream = new AppendOnlyStreamingRender<object>();
        const entry = {};
        const render = (text: string): string[] => text.trimEnd().split("\n");

        stream.render({
            entry,
            isStreaming: true,
            render,
            text: "stable\nsecond\nmutable",
            width: 80,
        });
        expect(
            stream.render({
                entry,
                isStreaming: false,
                render: () => ["changed stable", "final second", "final mutable"],
                text: "changed stable\nfinal second\nfinal mutable",
                width: 80,
            }),
        ).toEqual(["stable", "final second", "final mutable"]);
        expect(
            stream.render({
                entry,
                isStreaming: false,
                render: () => ["changed again", "settled second", "settled mutable"],
                text: "changed again\nsettled second\nsettled mutable",
                width: 80,
            }),
        ).toEqual(["stable", "settled second", "settled mutable"]);

        stream.render({
            entry,
            isStreaming: true,
            render,
            text: "old width\nmutable",
            width: 80,
        });
        expect(
            stream.render({
                entry,
                isStreaming: true,
                render,
                text: "new width\nmutable",
                width: 60,
            }),
        ).toEqual(["new width", "mutable"]);
    });

    it("does not freeze wrapped rows from an incomplete source line", () => {
        const stream = new AppendOnlyStreamingRender<object>();
        const entry = {};
        const render = (text: string): string[] => {
            const lines = text.trimEnd().split("\n");
            return lines.flatMap((line) => line.match(/.{1,4}/gu) ?? [""]);
        };

        expect(
            stream.render({
                entry,
                isStreaming: true,
                render,
                text: "stable\npartial",
                width: 4,
            }),
        ).toEqual(["stab", "le", "part", "ial"]);
        expect(
            stream.render({
                entry,
                isStreaming: true,
                render,
                text: "stable\npartial line",
                width: 4,
            }),
        ).toEqual(["stab", "le", "part", "ial ", "line"]);
    });

    it("does not freeze the temporary empty row after an opening code fence", () => {
        const stream = new AppendOnlyStreamingRender<object>();
        const entry = {};
        const command = "(cd packages/ghostty-web && pnpm publish --access public)";
        const render = (text: string): string[] =>
            text.includes(command)
                ? ["intro", "```sh", command, "```"]
                : ["intro", "```sh", "", "```"];

        expect(
            stream.render({
                entry,
                isStreaming: true,
                render,
                text: "intro\n```sh\n",
                width: 80,
            }),
        ).toEqual(["intro", "```sh", "", "```"]);

        expect(
            stream.render({
                entry,
                isStreaming: true,
                render,
                text: `intro\n\`\`\`sh\n${command}\n\`\`\``,
                width: 80,
            }),
        ).toEqual(["intro", "```sh", command, "```"]);

        expect(
            stream.render({
                entry,
                isStreaming: false,
                render,
                text: `intro\n\`\`\`sh\n${command}\n\`\`\``,
                width: 80,
            }),
        ).toEqual(["intro", "```sh", command, "```"]);
    });
});
