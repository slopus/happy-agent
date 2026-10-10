import { readFileSync, writeFileSync } from "node:fs";

/** Preserve unchanged captures so formatting cannot invalidate every native build. */
export function writeNativeCapture(path, contents) {
    let existing;
    try {
        existing = readFileSync(path, "utf8");
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    if (existing === contents) return;
    if (existing !== undefined && String(path).endsWith(".json")) {
        if (JSON.stringify(JSON.parse(existing)) === JSON.stringify(JSON.parse(contents))) return;
    }
    writeFileSync(path, contents);
}
