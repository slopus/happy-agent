import { readFileSync } from "node:fs";

export function readPackageVersion(): string {
    try {
        const contents = readFileSync(new URL("../package.json", import.meta.url), "utf8");
        const manifest = JSON.parse(contents) as { version?: unknown };
        return typeof manifest.version === "string" ? manifest.version : "0.0.0";
    } catch {
        return "0.0.0";
    }
}
