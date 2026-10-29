import { describe, expect, it } from "vitest";

import { chatActionSegments } from "../../sources/onboarding/impl/chatActions/chatActionBlocks.js";
import { openingMessage } from "../../sources/onboarding/impl/onboardingCopy.js";
import { proposalBlock } from "../../sources/onboarding/impl/workCopy.js";

describe("the inline action grammar the daemon checks presses with", () => {
    it("finds Happy's opening button as a pressable action", () => {
        const blocks = chatActionSegments(openingMessage()).flatMap((segment) =>
            segment.type === "actions" && segment.block !== undefined ? [segment.block] : [],
        );
        expect(blocks).toEqual([
            {
                kind: "buttons",
                buttons: [
                    {
                        label: "Start onboarding",
                        action: { id: "onboarding.start" },
                        emphasized: true,
                    },
                ],
            },
        ]);
    });

    it("draws the live phone pairing figure, which carries nothing of its own", () => {
        const [segment] = chatActionSegments("<figure data-phone-pair></figure>\n");
        expect(segment).toMatchObject({ type: "actions", block: { kind: "phonePair" } });
        const [withContent] = chatActionSegments(
            "<figure data-phone-pair><small>token</small></figure>\n",
        );
        expect(withContent).toMatchObject({ type: "actions" });
        expect(withContent).not.toHaveProperty("block");
    });

    it("draws a provider CLI and a setting figure by what they name", () => {
        const blocks = chatActionSegments(
            'Connecting.\n\n<figure data-provider-cli="codex"></figure>\n\n<figure data-setting="default-model"></figure>\n',
        ).flatMap((segment) => (segment.type === "actions" ? [segment.block] : []));
        expect(blocks).toEqual([
            { kind: "providerCli", cliId: "codex" },
            { kind: "setting", setting: "default-model" },
        ]);
        const [empty] = chatActionSegments('<figure data-provider-cli=""></figure>\n').filter(
            (segment) => segment.type === "actions",
        );
        expect(empty).not.toHaveProperty("block");
    });

    it("gives the proposal's Looks right the label it takes while nothing is ticked", () => {
        const [segment] = chatActionSegments(
            `${proposalBlock([
                {
                    id: "p1-work-1",
                    title: "Ship onboarding",
                    icon: "rocket",
                    topic: "Onboarding",
                    why: "12 commits",
                    firstMessage: "Plan it.",
                    ongoing: false,
                },
            ])}\n`,
        );
        expect(segment).toMatchObject({
            type: "actions",
            block: {
                kind: "checklist",
                submit: { label: "Looks right", emptyLabel: "Continue without these" },
            },
        });
    });

    it("keeps a block with a script or a style as inert text", () => {
        const [segment] = chatActionSegments(
            '<menu><button data-action="onboarding.start" onclick="x()">Go</button></menu>\n',
        );
        expect(segment).not.toHaveProperty("block");
    });
});
