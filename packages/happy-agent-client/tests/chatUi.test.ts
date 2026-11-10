import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    defaultModelComponent,
    knownUiComponent,
    layoutMedia,
    mediaFallback,
    normalizeQuickReply,
    providerSignInComponent,
    quickRepliesBlockSchema,
    quickRepliesProblems,
    redactUiAction,
    redactUiValue,
    uiActionAllowed,
    uiActionDefinition,
    uiActionPermission,
    uiActionRequest,
    uiActionResult,
    uiComponents,
    uiComponentSchema,
    uiDocumentProblems,
    uiDocumentSchema,
    UI_MEMBER_PERMISSIONS,
} from "../sources/index.js";

const target = {
    id: "k3c9q2m7p0a4b8c1d5e6f7g2",
    messageId: "tz4a98xxat96iws9zmbrgj3a",
    uiId: "u1x8k2m9r4t8w1y5z3a6b0c2",
    componentId: "claude",
};

describe("chat UI bundles", () => {
    it("leaves undeclared fields and secrets out of a stored payload", () => {
        const found = uiActionDefinition("provider_sign_in.submit_token")!;
        expect(
            redactUiValue(found.definition.payload, { token: "sk-ant-oat01-x", smuggled: "y" }),
        ).toEqual({});
    });

    it("needs each action's declared permission, and content.write when it declares none", () => {
        const install = uiActionDefinition("provider_sign_in.install")!.definition;
        const signIn = uiActionDefinition("provider_sign_in.sign_in")!.definition;
        expect(uiActionPermission(install, { provider: "claude" })).toBe("providers.manage");
        expect(uiActionPermission(signIn, { provider: "claude" })).toBe("providers.own");
        expect(uiActionPermission({}, {})).toBe("content.write");
        expect(uiActionAllowed(install, {}, UI_MEMBER_PERMISSIONS)).toBe(false);
        expect(uiActionAllowed(signIn, {}, new Set(UI_MEMBER_PERMISSIONS))).toBe(true);
    });

    it("derives the known-component union from the one list", () => {
        expect(uiComponentSchema.anyOf).toHaveLength(uiComponents.length);
        for (const bundle of uiComponents) {
            expect(uiComponentSchema.anyOf).toContain(bundle.componentSchema);
        }
    });
});

describe("the wire document", () => {
    const signIn = {
        id: "claude",
        type: "provider_sign_in",
        fallback: "Sign in to Claude Code in Happy on your computer.",
        props: { provider: "claude" },
    };
    const newer = {
        id: "deck",
        type: "slideshow",
        fallback: "A slideshow of 3 pictures",
        props: { count: 3 },
    };

    it("carries a component type this build does not know, to be shown as its fallback", () => {
        const document = { id: "u1x8k2m9r4t8w1y5z3a6b0c2", components: [signIn, newer] };
        expect(Value.Check(uiDocumentSchema, document)).toBe(true);
        expect(knownUiComponent(signIn)).toEqual(signIn);
        expect(knownUiComponent(newer)).toBeUndefined();
    });

    it("draws nothing from a known type whose props are not that type's", () => {
        expect(knownUiComponent({ ...signIn, props: { provider: "gemini" } })).toBeUndefined();
    });

    it("is refused when written with a type the catalog lacks", () => {
        expect(uiDocumentProblems([newer])).toEqual([
            'deck: There is no component type "slideshow".',
        ]);
        expect(uiDocumentProblems([signIn])).toEqual([]);
    });
});

describe("a typed click", () => {
    it("builds the request for one of the bundle's actions with that action's payload", () => {
        expect(
            uiActionRequest(providerSignInComponent, "submit_token", { token: "sk-ant" }, target),
        ).toEqual({
            ...target,
            action: { type: "provider_sign_in.submit_token", payload: { token: "sk-ant" } },
        });
        // @ts-expect-error A sign-in has no such action.
        uiActionRequest(providerSignInComponent, "set", {}, target);
        // @ts-expect-error The payload is the action's own.
        uiActionRequest(providerSignInComponent, "submit_token", { code: "x" }, target);
        uiActionRequest(
            defaultModelComponent,
            "set",
            { providerId: "claude", modelId: "claude-opus-5-5", effort: "high" },
            target,
        );
    });

    it("reads a result only when it is the bundle's", () => {
        const result = uiActionResult(providerSignInComponent, "sign_in", {
            result: { connected: true },
        });
        expect(result?.connected).toBe(true);
        expect(
            uiActionResult(providerSignInComponent, "sign_in", { result: { connected: "yes" } }),
        ).toBeUndefined();
        expect(
            uiActionResult(providerSignInComponent, "sign_in", { result: null }),
        ).toBeUndefined();
        // An action that declares no result has none, whatever the response holds.
        expect(
            uiActionResult(providerSignInComponent, "cancel", { result: { connected: true } }),
        ).toBeUndefined();
    });

    it("keeps an action in flight without its secrets", () => {
        expect(
            redactUiAction({
                type: "provider_sign_in.submit_token",
                payload: { token: "sk-ant-oat01-x" },
            }),
        ).toEqual({ type: "provider_sign_in.submit_token", payload: {} });
        expect(
            redactUiAction({
                type: "default_model.set",
                payload: { providerId: "claude", modelId: "m", effort: "high" },
            }).payload,
        ).toEqual({ providerId: "claude", modelId: "m", effort: "high" });
        // Nothing says which fields of an unknown action are secret.
        expect(redactUiAction({ type: "slideshow.next", payload: { pin: "1234" } })).toEqual({
            type: "slideshow.next",
            payload: {},
        });
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

    it("reads a block whose options carry drawings this build does not know", () => {
        expect(
            Value.Check(quickRepliesBlockSchema, {
                type: "quick_replies",
                options: ["Set up Claude", "Skip for now"],
                ui: [{ type: "provider", props: { provider: "claude" } }, null],
            }),
        ).toBe(true);
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
