import { describe, expect, it } from "vitest";

import {
    layoutMedia,
    mediaFallback,
    normalizeQuickReply,
    quickRepliesProblems,
    quickReplyUiProblems,
    splitQuickReplies,
    redactUiValue,
    uiActionDefinition,
    uiActionPermission,
    uiComponents,
} from "../sources/index.js";

describe("chat UI bundles", () => {
    it("leaves undeclared fields and secrets out of a stored payload", () => {
        const found = uiActionDefinition("provider_sign_in.submit_token")!;
        expect(
            redactUiValue(found.definition.payload, { token: "sk-ant-oat01-x", smuggled: "y" }),
        ).toEqual({});
    });

    it("chooses a sign-in's permission by its target", () => {
        const signIn = uiActionDefinition("provider_sign_in.sign_in")!.definition;
        expect(uiActionPermission(signIn, { provider: "claude", target: "team" })).toBe(
            "providers.manage",
        );
        expect(uiActionPermission(signIn, { provider: "claude" })).toBe("providers.own");
    });
});

describe("quick replies", () => {
    it("collapses whitespace and checks 1 to 6 unique plain options", () => {
        expect(normalizeQuickReply("  Fix   the\tlogin \n")).toBe("Fix the login");
        expect(quickRepliesProblems(["Yes", "Not now"])).toEqual([]);
        expect(quickRepliesProblems([])).toEqual(["Suggest 1 to 6 replies."]);
        expect(quickRepliesProblems(["Same", "Same"])).toEqual([
            'Replies must be unique; "Same" repeats.',
        ]);
        expect(quickRepliesProblems(["x".repeat(201)])).toHaveLength(1);
        expect(quickRepliesProblems(["right-to-left \u202e"])).toHaveLength(1);
    });
});

describe("reply components", () => {
    it("stores ui beside the options, null for bare ones, and checks each against the catalog", () => {
        const split = splitQuickReplies([
            { text: "Claude", ui: { type: "provider", props: { provider: "claude" } } },
            "Skip for now",
        ]);
        expect(split).toEqual({
            options: ["Claude", "Skip for now"],
            ui: [{ type: "provider", props: { provider: "claude" } }, null],
        });
        expect(quickReplyUiProblems(split.options, split.ui!)).toEqual([]);
        expect(splitQuickReplies(["Yes", { text: "No" }])).toEqual({ options: ["Yes", "No"] });
        expect(
            quickReplyUiProblems(["Gemini"], [{ type: "provider", props: { provider: "gemini" } }]),
        ).toHaveLength(1);
    });
});

describe("media layout", () => {
    const square = { kind: "image", width: 100, height: 100 };
    const screenshot = { kind: "image", width: 1920, height: 1080 };

    it("keeps a lone item at most twice the row height, left-aligned", () => {
        expect(layoutMedia([square], 900, 220).frames).toEqual([
            { x: 0, y: 0, width: 440, height: 440 },
        ]);
        expect(layoutMedia([square], 300, 220).frames).toEqual([
            { x: 0, y: 0, width: 300, height: 300 },
        ]);
    });

    it("fills a row to the width and leaves the last row at the target height", () => {
        // 220 + 6 + 220 fits 600; a third would fill at 196, nearer 220 than 297, so it joins.
        const laid = layoutMedia([square, square, square, square], 600, 220);
        expect(laid.frames.map((frame) => frame.width)).toEqual([196, 196, 196, 220]);
        expect(laid.frames[2]).toEqual({ x: 404, y: 0, width: 196, height: 196 });
        expect(laid.frames[3]).toEqual({ x: 0, y: 202, width: 220, height: 220 });
        // Two 16:9 shots share a row at 786 though they don't fit at 220: 219 is nearer.
        expect(layoutMedia([screenshot, screenshot], 786, 220).frames).toEqual([
            { x: 0, y: 0, width: 390, height: 219 },
            { x: 396, y: 0, width: 390, height: 219 },
        ]);
    });

    it("adds a label line to a row with any label, and clamps aspects to 0.4 to 3", () => {
        const laid = layoutMedia(
            [
                { ...square, label: "Home" },
                { kind: "image", width: 100, height: 1000 },
            ],
            900,
            220,
        );
        expect(laid.frames[1]).toEqual({ x: 226, y: 0, width: 88, height: 220 });
        expect(laid.labels).toEqual([{ x: 0, y: 224, width: 220, height: 18 }, null]);
        expect(laid.height).toBe(242);
    });

    it("counts pictures as images and anything else as files", () => {
        expect(mediaFallback([{ kind: "image" }, { kind: "image", label: "Login" }])).toBe(
            "2 images: Login",
        );
        expect(mediaFallback([{ kind: "video" }])).toBe("1 file");
    });
});
