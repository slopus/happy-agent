import { describe, expect, it } from "vitest";

import {
    firstTokenDelay,
    streamLikeInference,
} from "../../sources/api/impl/streamLikeInference.js";

const TEXT =
    "Hi, I'm Happy, your main agent. I help you get things done with agents of your own. The sidebar shows an example of what that looks like.";

describe("streamLikeInference", () => {
    it("joins back into exactly the text, in whole words", () => {
        for (let seed = 0; seed < 50; seed += 1) {
            let state = seed + 1;
            const random = () => {
                state = (state * 16_807) % 2_147_483_647;
                return state / 2_147_483_647;
            };
            const chunks = streamLikeInference(TEXT, random);
            expect(chunks.map((chunk) => chunk.text).join("")).toBe(TEXT);
            for (const chunk of chunks) {
                expect(chunk.text.trim()).not.toBe("");
                expect(chunk.text.split(/\s+/u).filter(Boolean).length).toBeLessThanOrEqual(5);
                expect(chunk.afterMs).toBeGreaterThanOrEqual(30);
                expect(chunk.afterMs).toBeLessThanOrEqual(60);
            }
        }
    });

    it("lands two sentences in about a second", () => {
        const total =
            firstTokenDelay() +
            streamLikeInference(TEXT).reduce((sum, chunk) => sum + chunk.afterMs, 0);
        expect(total).toBeGreaterThan(400);
        expect(total).toBeLessThan(2_000);
        const delay = firstTokenDelay();
        expect(delay).toBeGreaterThanOrEqual(300);
        expect(delay).toBeLessThanOrEqual(500);
    });
});
