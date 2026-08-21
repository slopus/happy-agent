import { Value } from "@sinclair/typebox/value";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { FakeCompute } from "../support/FakeCompute.js";
import { computeToolset } from "../support/computeTools.js";

const ctx = createRootContext().named("happy-agent-modules-compute-grok-surface");

/** A model ID that selects Grok's own surface. */
const GROK_MODEL = "xai/grok-4.5";

/**
 * The vendor's own argument schemas, transcribed from
 * `packages/happy-providers/sources/vendors/grok/tools/*.ts`.
 *
 * The module must not import the vendor descriptors, so the check they anchor is written out
 * here: property names and the required/optional split, never descriptions, which Happy Agent's live
 * tools deliberately reword. Anything this surface adds or leaves out is named explicitly, so a
 * schema quietly drifting back toward a shared shape fails rather than passes.
 */
const vendorSchemas: Readonly<
    Record<
        string,
        {
            readonly properties: readonly string[];
            readonly required: readonly string[];
            /** Vendor arguments this machine cannot honestly offer. */
            readonly omitted?: readonly string[];
            /** Arguments Happy Agent's live Grok tool adds on top of the vendor's. */
            readonly added?: readonly string[];
            /** Vendor-optional arguments this surface insists on. */
            readonly alsoRequired?: readonly string[];
        }
    >
> = {
    read_file: {
        properties: ["target_file", "offset", "limit", "pages", "format"],
        required: ["target_file"],
        // Neither belongs on a machine that cannot render a PDF.
        omitted: ["pages", "format"],
    },
    write: {
        properties: ["file_path", "content"],
        required: ["file_path", "content"],
    },
    search_replace: {
        properties: ["file_path", "old_string", "new_string", "replace_all"],
        required: ["file_path", "old_string", "new_string"],
    },
    list_dir: {
        properties: ["target_directory"],
        required: ["target_directory"],
    },
    grep: {
        properties: [
            "pattern",
            "path",
            "glob",
            "-B",
            "-A",
            "-C",
            "-i",
            "type",
            "head_limit",
            "multiline",
        ],
        required: ["pattern"],
    },
    run_terminal_command: {
        properties: ["command", "timeout", "description", "background"],
        required: ["command", "description"],
        // Happy Agent's own additions. `secrets` is deliberately not among them: this module has no
        // secret resolver, so offering the argument would promise something it cannot do.
        added: ["tty", "sandbox_permissions"],
    },
    get_command_or_subagent_output: {
        properties: ["task_ids", "timeout_ms"],
        required: [],
        // A call with no task IDs has nothing to answer, so Happy Agent requires them and so do we.
        alsoRequired: ["task_ids"],
    },
    kill_command_or_subagent: {
        properties: ["task_id"],
        required: ["task_id"],
    },
};

/**
 * `send_command_input` has no vendor descriptor — Happy Agent invented it — so its shape is checked
 * against `packages/happy-agent-modules/sources/compute/tools/grok/send_command_input.ts` instead.
 */
const happyAgentOnlySchemas: Readonly<
    Record<string, { readonly properties: readonly string[]; readonly required: readonly string[] }>
> = {
    send_command_input: {
        properties: ["task_id", "input", "timeout_ms"],
        required: ["task_id", "input"],
    },
};

function argumentShape(tool: { readonly parameters?: unknown }): {
    properties: string[];
    required: string[];
} {
    const parameters = tool.parameters as {
        properties: Record<string, unknown>;
        required?: readonly string[];
        additionalProperties?: boolean;
    };
    return {
        properties: Object.keys(parameters.properties).sort(),
        required: [...(parameters.required ?? [])].sort(),
    };
}

describe("Grok's compute tool surface", () => {
    it("is Grok's own nine tools, in Grok's own order", async () => {
        const { tools } = await computeToolset(ctx, new FakeCompute(), { model: GROK_MODEL });

        expect(tools.map((tool) => tool.name)).toEqual([
            "run_terminal_command",
            "read_file",
            "write",
            "search_replace",
            "list_dir",
            "grep",
            "get_command_or_subagent_output",
            "kill_command_or_subagent",
            "send_command_input",
        ]);
    });

    it("gives Grok no image tool, because no Grok surface has one", async () => {
        const { tools } = await computeToolset(ctx, new FakeCompute(), { model: GROK_MODEL });

        expect(tools.some((tool) => /image/iu.test(tool.name))).toBe(false);
    });

    it("describes every tool to the model", async () => {
        const { tools } = await computeToolset(ctx, new FakeCompute(), { model: GROK_MODEL });

        for (const tool of tools) {
            expect(tool.description ?? "").not.toBe("");
        }
    });

    it("owns its Auto decision on every tool, and explains every reviewable one", async () => {
        const { tools } = await computeToolset(ctx, new FakeCompute(), { model: GROK_MODEL });

        for (const tool of tools) {
            expect(typeof tool.shouldReviewInAutoMode).toBe("function");
            expect(tool.requiresAutoOrFullAccess).toBeUndefined();
        }
        // Everything but the three that only touch work Happy Agent itself started can be reviewed.
        for (const name of [
            "run_terminal_command",
            "read_file",
            "write",
            "search_replace",
            "list_dir",
            "grep",
            "send_command_input",
        ]) {
            const tool = tools.find((candidate) => candidate.name === name);
            expect(typeof tool?.describeAutoPermissionAction).toBe("function");
        }
    });

    it("keeps every argument schema exactly as Grok shapes it", async () => {
        const { tools } = await computeToolset(ctx, new FakeCompute(), { model: GROK_MODEL });

        for (const [name, vendor] of Object.entries(vendorSchemas)) {
            const tool = tools.find((candidate) => candidate.name === name);
            expect(tool, `${name} is missing`).toBeDefined();
            const shape = argumentShape(tool!);
            const expectedProperties = [
                ...vendor.properties.filter(
                    (property) => !(vendor.omitted ?? []).includes(property),
                ),
                ...(vendor.added ?? []),
            ].sort();
            const expectedRequired = [...vendor.required, ...(vendor.alsoRequired ?? [])].sort();
            expect(shape.properties, `${name} properties`).toEqual(expectedProperties);
            expect(shape.required, `${name} required`).toEqual(expectedRequired);
        }
        for (const [name, happyAgent] of Object.entries(happyAgentOnlySchemas)) {
            const tool = tools.find((candidate) => candidate.name === name);
            const shape = argumentShape(tool!);
            expect(shape.properties, `${name} properties`).toEqual(
                [...happyAgent.properties].sort(),
            );
            expect(shape.required, `${name} required`).toEqual([...happyAgent.required].sort());
        }
    });

    it("refuses arguments Grok never had, including another vendor's escalation field", async () => {
        const { tool } = await computeToolset(ctx, new FakeCompute(), { model: GROK_MODEL });
        const parameters = tool("run_terminal_command").parameters!;

        expect(
            Value.Check(parameters, {
                command: "ls",
                description: "List the workspace.",
                dangerouslyDisableSandbox: true,
            }),
        ).toBe(false);
        expect(
            Value.Check(parameters, {
                command: "ls",
                description: "List the workspace.",
                secrets: ["github"],
            }),
        ).toBe(false);
        expect(Value.Check(parameters, { command: "ls", description: "List the workspace." })).toBe(
            true,
        );
    });
});
