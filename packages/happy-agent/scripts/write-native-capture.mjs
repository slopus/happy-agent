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
        const next = JSON.stringify(JSON.parse(contents));
        try {
            if (JSON.stringify(JSON.parse(existing)) === next) return;
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
        }
    }
    writeFileSync(path, contents);
}
