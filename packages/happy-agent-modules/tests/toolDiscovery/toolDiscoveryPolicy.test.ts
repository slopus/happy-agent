import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assembleComputeTools } from "../../sources/compute/tools/assembleComputeTools.js";
import { assembleReviewerTools } from "../../sources/compute/tools/assembleReviewerTools.js";

const sourcesRoot = join(dirname(fileURLToPath(import.meta.url)), "../../sources");
// Every vendor's machine tools are eager; present_files is a common tool and stays deferred.
const eagerDirectories = [
    "codeMode",
    "codexExec",
    "compute/tools/claude",
    "compute/tools/codex",
    "compute/tools/grok",
    "compute/tools/kimi",
    "compute/tools/glm",
    "userInput",
];
/**
 * Prioritizing's whole tool array, which it receives without tool search, and the feature tools
 * both native harnesses expose eagerly: Agent/spawn_agent and SendMessage/send_message.
 */
const eagerFiles = [
    "spaces/tools/prioritizingTools.ts",
    "collaboration/tools/create_agent.ts",
    "collaboration/tools/send_message.ts",
];

interface ToolDefinition {
    readonly file: string;
    readonly line: number;
    readonly properties: ReadonlyMap<string, string>;
}

describe("tool discovery policy", () => {
    it("declares an action description on every directly reviewable module tool", () => {
        const definitions = collectToolDefinitions(sourcesRoot);
        expect(definitions.length).toBeGreaterThan(0);
        for (const definition of definitions) {
            const review = definition.properties.get("shouldReviewInAutoMode");
            if (review === undefined || review === "() => false") continue;
            expect
                .soft(
                    definition.properties.has("describeAutoPermissionAction"),
                    `${definition.file}:${String(definition.line)}`,
                )
                .toBe(true);
        }
    });

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

            const eager =
                eagerFiles.includes(definition.file) ||
                eagerDirectories.some((directory) => definition.file.startsWith(`${directory}/`));
            expect.soft(definition.properties.get("defer"), location).toBe(String(!eager));
            expect.soft(definition.properties.get("capabilities"), location).toBeDefined();
            if (eager) {
                expect.soft(definition.properties.get("searchKeywords"), location).toBeUndefined();
            } else {
                expect.soft(definition.properties.get("searchKeywords"), location).toBeDefined();
            }
        }
    });

    it.each(["claude", "codex", "grok", "kimi", "glm"] as const)(
        "keeps every %s compute and reviewer tool eager",
        (vendor) => {
            const compute = {} as never;
            const reads = {} as never;
            const surfaces = [
                assembleComputeTools(
                    vendor,
                    compute,
                    reads,
                    new AbortController().signal,
                    undefined,
                ),
                assembleReviewerTools(vendor, compute, reads, new AbortController().signal),
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
            for (const property of [
                "shouldReviewInAutoMode",
                "describeAutoPermissionAction",
            ] as const) {
                const value = new RegExp(`\\b${property}\\s*:\\s*([^,\\n]+)`).exec(call)?.[1];
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
