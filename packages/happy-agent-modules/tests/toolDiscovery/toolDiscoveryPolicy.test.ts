import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assembleComputeTools } from "../../sources/compute/tools/assembleComputeTools.js";
import { assembleReviewerTools } from "../../sources/compute/tools/assembleReviewerTools.js";

const sourcesRoot = join(dirname(fileURLToPath(import.meta.url)), "../../sources");
const eagerDirectories = ["codeMode", "compute", "userInput"];

interface ToolDefinition {
    readonly file: string;
    readonly line: number;
    readonly properties: ReadonlyMap<string, string>;
}

describe("tool discovery policy", () => {
    it("is explicit on every directly defined module tool", () => {
        const definitions = collectToolDefinitions(sourcesRoot);

        expect(definitions.length).toBeGreaterThan(0);
        for (const definition of definitions) {
            const location = `${definition.file}:${String(definition.line)}`;
            const serverOwned = definition.properties.has("server");
            if (serverOwned) {
                expect.soft(definition.properties.get("defer"), location).toBeUndefined();
                continue;
            }

            const eager = eagerDirectories.some((directory) =>
                definition.file.startsWith(`${directory}/`),
            );
            expect.soft(definition.properties.get("defer"), location).toBe(String(!eager));
            expect.soft(definition.properties.get("capabilities"), location).toBeDefined();
            if (eager) {
                expect.soft(definition.properties.get("searchKeywords"), location).toBeUndefined();
            } else {
                expect.soft(definition.properties.get("searchKeywords"), location).toBeDefined();
            }
        }
    });

    it.each(["claude", "codex", "grok"] as const)(
        "keeps every %s compute and reviewer tool eager",
        (vendor) => {
            const compute = {} as never;
            const reads = {} as never;
            const surfaces = [
                assembleComputeTools(vendor, compute, reads),
                assembleReviewerTools(vendor, compute, reads),
            ];

            for (const tools of surfaces) {
                expect(tools.length).toBeGreaterThan(0);
                for (const tool of tools) {
                    expect.soft(tool.defer, `${vendor}:${tool.name}`).toBe(false);
                    expect
                        .soft(tool.capabilities?.length, `${vendor}:${tool.name}`)
                        .toBeGreaterThan(0);
                    expect.soft(tool.searchKeywords, `${vendor}:${tool.name}`).toBeUndefined();
                }
            }
        },
    );
});

function collectToolDefinitions(root: string): readonly ToolDefinition[] {
    const definitions: ToolDefinition[] = [];
    for (const file of sourceFiles(root)) {
        const source = readFileSync(file, "utf8");
        const starts = [...source.matchAll(/defineAgentTool\(\{/g)].map((match) => match.index);
        for (const [index, start] of starts.entries()) {
            const end = starts[index + 1] ?? source.length;
            const call = source.slice(start, end);
            const policyEnd = call.indexOf("shouldReviewInAutoMode");
            const header = policyEnd === -1 ? call : call.slice(0, policyEnd);
            const properties = new Map<string, string>();
            for (const property of ["defer", "capabilities", "searchKeywords"] as const) {
                const value = new RegExp(`\\b${property}\\s*:\\s*([^,\\n]+)`).exec(header)?.[1];
                if (value !== undefined) properties.set(property, value.trim());
            }
            if (
                /\bpersistInHistory\s*:\s*false\b/.test(header) &&
                /\bvisibleToUser\s*:\s*false\b/.test(header)
            ) {
                properties.set("server", "true");
            }
            definitions.push({
                file: relative(root, file),
                line: source.slice(0, start).split("\n").length,
                properties,
            });
        }
    }
    return definitions;
}

function sourceFiles(directory: string): readonly string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    });
}
