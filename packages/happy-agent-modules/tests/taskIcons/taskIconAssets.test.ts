import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import catalog from "../../sources/taskIcons/assets/index.json" with { type: "json" };
import { assertTaskIconSlug, taskIconAsset } from "../../sources/taskIcons/searchTaskIcons.js";

describe("bundled task icon assets", () => {
    it("resolves every legacy icon while keeping exactly 2,000 canonical topics", () => {
        const legacy = `
            code new-feature cli-terminal refactor cleanup wip project-kickoff git pull-request
            code-review revert open-source crash hotfix flaky triage debugging investigate testing
            build ci-fix ci-watcher config dependencies dependency-upgrade deploy feature-flag
            app-store-release infra cloud database migration trend-up presentation-report login
            permissions user-account vulnerability secrets privacy incident on-call alerting marketing
            performance monitoring design dark-mode design-system navigation settings notifications
            ux accessibility localization web location links api architecture backend frontend email
            ai llm ai-agent prompt bots docs notes roadmap goals prioritize blocked urgent kanban
            brainstorm milestone-done team standup meeting feature-request user-feedback support
            pricing billing revenue home travel apple-macos windows android app-store google-play
            javascript typescript swift nodejs react expo-react-native aws docker postgres github
            slack figma claude openai linux kotlin python rust nextjs electron kubernetes vercel
            cloudflare redis stripe linear bun golang java ruby firebase homebrew datadog
            raspberry-pi local-models delete-code rename move-files types typo formatting lint
            waveform microphone headphones
        `
            .trim()
            .split(/\s+/u);
        expect(legacy).toHaveLength(139);
        for (const slug of legacy) {
            expect(taskIconAsset(slug), slug).toBeDefined();
            expect(() => assertTaskIconSlug(slug)).not.toThrow();
        }
        expect(taskIconAsset("waveform")).toEqual(taskIconAsset("audio"));
        expect(catalog).toHaveLength(2_000);
        expect(catalog.some((icon) => icon.slug === "waveform")).toBe(false);
    });

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
