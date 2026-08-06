import { describe, expect, it } from "vitest";

import { telegramEmojiFingerprint } from "./telegramEmojiFingerprint.js";

describe("telegramEmojiFingerprint", () => {
    it("matches Telegram-iOS fixed vectors", () => {
        expect(telegramEmojiFingerprint(new Uint8Array(32))).toEqual(["😉", "😉", "😉", "😉"]);
        expect(
            telegramEmojiFingerprint(Uint8Array.from({ length: 32 }, (_, index) => index)),
        ).toEqual(["💍", "☔️", "📅", "🍞"]);
    });

    it("requires the complete SHA-256 hash", () => {
        expect(() => telegramEmojiFingerprint(new Uint8Array(31))).toThrow("exactly 32 bytes");
    });
});
