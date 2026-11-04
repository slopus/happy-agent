import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProviderUsage } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, expect, it } from "vitest";

import { testConfigRootedAt } from "../support/configModule.js";

const APP_SERVER = fileURLToPath(
    new URL("./fixtures/codexAppServerWithLimits.mjs", import.meta.url),
);

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("measures a Codex CLI account by the limits Codex reports while it works", async () => {
    const root = await mkdtemp(join(tmpdir(), "foreign-account-usage-"));
    roots.push(root);
    const config = await testConfigRootedAt(
        root,
        [
            "[providers.gateway]",
            'type = "codex"',
            'api_key = "sk-gateway"',
            "enabled = true",
            "[harnesses.codex_cli]",
            `command = ${JSON.stringify(process.execPath)}`,
            `args = [${JSON.stringify(APP_SERVER)}]`,
        ].join("\n"),
    );
    const usages: ProviderUsage[] = [];
    config.onProviderAccountUsage((usage) => usages.push(usage));

    const provider = await config.resolveProviderUnchecked("gateway", "codex-cli/gpt-6.1-sol");
    const session = await provider!.session("agent-1", { instructions: "Be Happy.", tools: [] });
    try {
        for await (const event of session.run(createRootContext().named("account-usage-test"), {
            context: {
                instructions: "Be Happy.",
                messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
            },
            model: "codex-cli/gpt-6.1-sol",
        })) {
            if (event.type === "done") break;
        }
    } finally {
        await session.destroy();
    }

    expect(usages.map((usage) => ({ ...usage, capturedAt: 0 }))).toEqual([
        {
            providerId: "gateway",
            vendor: "codex",
            capturedAt: 0,
            planName: null,
            exhausted: false,
            windows: {
                fiveHour: {
                    usedPercent: 42,
                    resetsAt: 1793791365_000,
                    startsAt: 1793791365_000 - 5 * 60 * 60 * 1_000,
                    durationMs: 5 * 60 * 60 * 1_000,
                },
                weekly: {
                    usedPercent: 7,
                    resetsAt: 1793874165_000,
                    startsAt: 1793874165_000 - 7 * 24 * 60 * 60 * 1_000,
                    durationMs: 7 * 24 * 60 * 60 * 1_000,
                },
                monthly: null,
            },
            credits: null,
        },
    ]);
}, 30_000);
