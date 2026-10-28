import { describe, expect, it } from "vitest";

import { chatActionSegments } from "../../sources/onboarding/impl/chatActions/chatActionBlocks.js";
import { openingMessage } from "../../sources/onboarding/impl/onboardingCopy.js";

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

    it("keeps a block with a script or a style as inert text", () => {
        const [segment] = chatActionSegments(
            '<menu><button data-action="onboarding.start" onclick="x()">Go</button></menu>\n',
        );
        expect(segment).not.toHaveProperty("block");
    });
});
