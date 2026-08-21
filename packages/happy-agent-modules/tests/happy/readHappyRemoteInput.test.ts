import { describe, expect, it } from "vitest";

import { readHappyRemoteInput } from "../../sources/happy/index.js";

describe("reading a message from Happy", () => {
    it("reads the plain shape the phone sends", () => {
        expect(
            readHappyRemoteInput({ content: { text: "hello", type: "text" }, role: "user" }),
        ).toEqual({ kind: "text", selection: {}, text: "hello" });
    });

    it("reads a message wrapped in a session envelope", () => {
        expect(
            readHappyRemoteInput({
                content: {
                    data: { ev: { t: "text", text: "wrapped" }, role: "user" },
                    type: "session",
                },
                role: "session",
            }),
        ).toEqual({ kind: "text", selection: {}, text: "wrapped" });
    });

    it("reads an envelope that was never wrapped", () => {
        expect(
            readHappyRemoteInput({
                content: { ev: { t: "text", text: "bare" }, role: "user" },
                role: "session",
            }),
        ).toEqual({ kind: "text", selection: {}, text: "bare" });
    });

    it("recognizes Happy Agent's own message coming back around", () => {
        expect(
            readHappyRemoteInput({
                content: { text: "mine", type: "text" },
                meta: { sentFrom: "rig" },
                role: "user",
            }),
        ).toEqual({ kind: "echo" });
    });

    it("reads an attachment", () => {
        expect(
            readHappyRemoteInput({
                content: {
                    data: {
                        ev: {
                            mimeType: "image/png",
                            name: "screenshot.png",
                            ref: "blob-1",
                            size: 2048,
                            t: "file",
                        },
                        role: "user",
                    },
                    type: "session",
                },
                role: "session",
            }),
        ).toEqual({
            kind: "attachment",
            mimeType: "image/png",
            name: "screenshot.png",
            ref: "blob-1",
            size: 2048,
        });
    });

    it("takes what the person chose alongside what they said", () => {
        expect(
            readHappyRemoteInput({
                content: { text: "go", type: "text" },
                meta: {
                    model: "gpt-5.6-sol",
                    modelProviderId: "codex",
                    permissionMode: "read_only",
                    thinkingLevel: "high",
                },
                role: "user",
            }),
        ).toEqual({
            kind: "text",
            selection: {
                effort: "high",
                modelId: "gpt-5.6-sol",
                permissionMode: "read_only",
                providerId: "codex",
            },
            text: "go",
        });
    });

    it("prefers the reasoning level under whichever name it arrived", () => {
        const reasoning = readHappyRemoteInput({
            content: { text: "go", type: "text" },
            meta: { reasoning: "low" },
            role: "user",
        });
        expect(reasoning).toEqual({ kind: "text", selection: { effort: "low" }, text: "go" });
    });

    it("takes the envelope's own choices over the outer ones", () => {
        expect(
            readHappyRemoteInput({
                content: {
                    data: {
                        ev: { t: "text", text: "inner" },
                        meta: { model: "inner-model" },
                        role: "user",
                    },
                    type: "session",
                },
                meta: { model: "outer-model" },
                role: "session",
            }),
        ).toEqual({
            kind: "text",
            selection: { modelId: "inner-model" },
            text: "inner",
        });
    });

    it("says nothing rather than guess at a message it does not know", () => {
        expect(readHappyRemoteInput(undefined)).toBeUndefined();
        expect(readHappyRemoteInput("hello")).toBeUndefined();
        expect(readHappyRemoteInput({ role: "agent" })).toBeUndefined();
        expect(
            readHappyRemoteInput({
                content: { data: { ev: { t: "sidechain" }, role: "user" }, type: "session" },
                role: "session",
            }),
        ).toBeUndefined();
    });

    it("ignores an envelope that is not from the person", () => {
        expect(
            readHappyRemoteInput({
                content: {
                    data: { ev: { t: "text", text: "agent talking" }, role: "agent" },
                    type: "session",
                },
                role: "session",
            }),
        ).toBeUndefined();
    });
});
