import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import catalog from "../../sources/taskIcons/assets/index.json" with { type: "json" };
import { taskIconAsset } from "../../sources/taskIcons/searchTaskIcons.js";

describe("bundled task icon assets", () => {
    it("ships every catalog image with the digest and size clients receive", async () => {
        for (const icon of catalog) {
            const bytes = await readFile(
                new URL(`../../sources/taskIcons/assets/${icon.slug}.webp`, import.meta.url),
            );
            expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
            expect(bytes.subarray(8, 12).toString()).toBe("WEBP");
            expect(bytes.length, icon.slug).toBe(icon.size);
            expect(createHash("sha256").update(bytes).digest("hex"), icon.slug).toBe(icon.hash);
            expect(taskIconAsset(icon.slug)?.hash).toBe(icon.hash);
        }
    });

    it("never resolves unknown slugs, prototype keys, or paths", () => {
        for (const slug of [
            "../index",
            "constructor",
            "toString",
            "__proto__",
            "missing-icon",
            "login.webp",
            "LOGIN",
        ]) {
            expect(taskIconAsset(slug)).toBeUndefined();
        }
    });
});
