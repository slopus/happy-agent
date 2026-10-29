import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSourceAdapters } from "../scripts/build-binary.js";

/**
 * Tests and the desktop gym stand in for Tailcat through `HAPPY_AGENT_TAILCAT_PATH`, so phone
 * pairing never leaves the computer. The release binary's resolver must honour it before falling
 * back to the embedded executable.
 */
function bundledResolver(): (embedded: string) => string {
    const adapters = resolveSourceAdapters({
        arch: "arm64",
        bunTarget: "bun-darwin-arm64",
        key: "darwin-arm64",
        platform: "darwin",
    });
    const path = [...adapters.keys()].find((key) =>
        key.endsWith(join("dist", "tailcat", "impl", "resolveTailcatExecutable.js")),
    );
    expect(path, "Missing standalone adapter for the Tailcat resolver").toBeDefined();
    const adapter = adapters.get(path!);
    expect(adapter!.required).toBe(true);
    const source = adapter!.adapt(readFileSync(path!, "utf8"));
    expect(source).toContain('import { getTailcatExecutable } from "happy-agent:binary-assets";');
    // Run the bundled resolver with the embedded executable supplied in place of the asset module.
    const body = source
        .replace(/^import .*\n/mu, "")
        .replace("export function", "function")
        .concat("\nreturn resolveTailcatExecutable();");
    return (embedded) =>
        new Function("getTailcatExecutable", "process", body)(() => embedded, process) as string;
}

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("standalone Tailcat resolver", () => {
    it("uses the stand-in Tailcat a test names", () => {
        vi.stubEnv("HAPPY_AGENT_TAILCAT_PATH", " /tmp/stub/tailcat ");
        expect(bundledResolver()("/embedded/tailcat")).toBe("/tmp/stub/tailcat");
    });

    it("falls back to the embedded Tailcat otherwise", () => {
        vi.stubEnv("HAPPY_AGENT_TAILCAT_PATH", "");
        expect(bundledResolver()("/embedded/tailcat")).toBe("/embedded/tailcat");
        delete process.env.HAPPY_AGENT_TAILCAT_PATH;
        expect(bundledResolver()("/embedded/tailcat")).toBe("/embedded/tailcat");
    });
});
