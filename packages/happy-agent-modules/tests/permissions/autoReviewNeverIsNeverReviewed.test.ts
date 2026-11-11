import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

const SOURCES = join(import.meta.dirname, "../../sources");

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return entry.name.endsWith(".ts") ? [path] : [];
    });
}

// A foreign harness runs a tool marked `autoReview: "never"` without asking anyone, so the mark is
// only true of a tool whose own rule never asks for review.
it('marks a tool autoReview "never" only beside a rule that never asks for review', () => {
    const marked: string[] = [];
    for (const path of sourceFiles(SOURCES)) {
        const lines = readFileSync(path, "utf8").split("\n");
        lines.forEach((line, index) => {
            if (!/^\s*autoReview: "never",$/.test(line)) return;
            marked.push(path);
            expect(lines[index - 1]?.trim(), `${path}:${index + 1}`).toBe(
                "shouldReviewInAutoMode: () => false,",
            );
        });
    }
    expect(marked.length).toBeGreaterThan(100);
});
