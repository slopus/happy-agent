import { readFileSync } from "node:fs";

declare const HAPPY_AGENT_BUILD_VERSION: string | undefined;

/**
 * Reads the version of the package this module ships inside.
 *
 * The lookup is relative to the compiled module, so a standalone install reports the
 * `@slopus/happy-agent` version while a product that bundles this code into its own `dist/`
 * reports that product's version. The daemon identity therefore always matches whichever
 * executable actually launched the daemon.
 */
export function readPackageVersion(): string {
    if (typeof HAPPY_AGENT_BUILD_VERSION === "string") return HAPPY_AGENT_BUILD_VERSION;
    try {
        const contents = readFileSync(new URL("../package.json", import.meta.url), "utf8");
        const manifest = JSON.parse(contents) as { version?: unknown };
        return typeof manifest.version === "string" ? manifest.version : "0.0.0";
    } catch {
        return "0.0.0";
    }
}
