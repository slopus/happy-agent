import { Value } from "@sinclair/typebox/value";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { FakeCompute } from "../support/FakeCompute.js";
import { computeToolset } from "../support/computeTools.js";

const ctx = createRootContext().named("happy-agent-modules-codex-surface");

/** An agent with no chosen model is handed Codex's surface, which is what these tests read. */
async function machine() {
    const compute = new FakeCompute();
    return { compute, ...(await computeToolset(ctx, compute)) };
}

/**
 * Codex's own parameters, copied from
 * `packages/happy-providers/sources/vendors/codex/tools/*.ts`. The value says whether the vendor
 * marks that field required. Descriptions are deliberately not compared: Happy Agent's live wording
 * extends the vendor's, and this is a check on shape.
 */
const VENDOR_PARAMETERS: Readonly<Record<string, Readonly<Record<string, boolean>>>> = {
    exec_command: {
        cmd: true,
        justification: false,
        login: false,
        max_output_tokens: false,
        prefix_rule: false,
        sandbox_permissions: false,
        shell: false,
        tty: false,
        workdir: false,
        yield_time_ms: false,
    },
    view_image: { detail: false, path: true },
    write_stdin: {
        chars: false,
        max_output_tokens: false,
        session_id: true,
        yield_time_ms: false,
    },
};

/**
 * Fields Codex declares that this module deliberately does not offer.
 *
 * `login` and `prefix_rule` describe approval machinery Happy Agent does not have, and Happy Agent's own
 * `exec_command` drops them too. There is no secret resolver here either, so no `secrets` field
 * appears in any of these tools.
 */
const OMITTED_BY_MODULE: Readonly<Record<string, readonly string[]>> = {
    exec_command: ["login", "prefix_rule"],
    view_image: [],
    write_stdin: [],
};

/** The argument schema of one tool, reduced to what a fidelity check is about. */
function parameterShape(tool: { readonly parameters?: unknown }): {
    readonly properties: readonly string[];
    readonly required: readonly string[];
    readonly additionalProperties: unknown;
} {
    const schema = tool.parameters as {
        properties?: Readonly<Record<string, unknown>>;
        required?: readonly string[];
        additionalProperties?: unknown;
    };
    return {
        properties: Object.keys(schema.properties ?? {}).sort(),
        required: [...(schema.required ?? [])].sort(),
        additionalProperties: schema.additionalProperties,
    };
}

describe("codex compute tool surface", () => {
    it("offers exactly Codex's tools, in Codex's order", async () => {
        const { tools } = await machine();

        expect(tools.map((tool) => tool.name)).toEqual([
            "exec_command",
            "write_stdin",
            "kill_session",
            "apply_patch",
            "view_image",
        ]);
        for (const tool of tools) {
            expect(tool.description ?? "").not.toBe("");
        }
    });

    it("matches the vendor's argument shape wherever it offers the field", async () => {
        const { tool } = await machine();

        for (const [name, vendor] of Object.entries(VENDOR_PARAMETERS)) {
            const shape = parameterShape(tool(name));
            const omitted = OMITTED_BY_MODULE[name] ?? [];
            expect(shape.properties).toEqual(
                Object.keys(vendor)
                    .filter((field) => !omitted.includes(field))
                    .sort(),
            );
            expect(shape.required).toEqual(
                Object.entries(vendor)
                    .filter(([field, required]) => required && !omitted.includes(field))
                    .map(([field]) => field)
                    .sort(),
            );
            expect(shape.additionalProperties).toBe(false);
        }
    });

    it("carries no secrets field anywhere on the surface", async () => {
        const { tools } = await machine();

        for (const tool of tools) {
            expect(parameterShape(tool).properties).not.toContain("secrets");
        }
    });

    it("reloads image reads without making command or mutation tools replayable", async () => {
        const { tool } = await machine();

        expect(tool("view_image").reloadable).toBe(true);
        for (const name of ["exec_command", "write_stdin", "kill_session", "apply_patch"]) {
            expect(tool(name).reloadable, name).not.toBe(true);
        }
    });

    it("takes apply_patch as ordinary JSON rather than as a freeform grammar tool", async () => {
        const { tool } = await machine();
        const applyPatch = tool("apply_patch");

        // Agent Base parses tool arguments as JSON before a tool sees them, so Codex's freeform
        // calling convention cannot reach here and the patch travels in a normal field.
        expect(applyPatch.grammar).toBeUndefined();
        expect(parameterShape(applyPatch)).toEqual({
            properties: ["patch", "workdir"],
            required: ["patch"],
            additionalProperties: false,
        });
        expect(applyPatch.description ?? "").toContain("`patch` field");
        expect(applyPatch.description ?? "").toContain("*** Begin Patch");
        expect(applyPatch.description ?? "").not.toContain("FREEFORM");
    });

    it("names a session by number on kill_session", async () => {
        const { tool } = await machine();

        expect(parameterShape(tool("kill_session"))).toEqual({
            properties: ["session_id"],
            required: ["session_id"],
            additionalProperties: false,
        });
    });

    it("escalates only through Codex's own sandbox_permissions field", async () => {
        const { tool } = await machine();
        const execCommand = tool("exec_command");

        expect(await execCommand.shouldReviewInAutoMode({ cmd: "ls" }, ctx)).toBe(false);
        expect(await execCommand.shouldRunInFullAccessInAutoMode?.({ cmd: "ls" }, ctx)).toBe(false);
        expect(
            await execCommand.shouldReviewInAutoMode(
                { cmd: "ls", sandbox_permissions: "use_default" },
                ctx,
            ),
        ).toBe(false);
        expect(
            await execCommand.shouldReviewInAutoMode(
                { cmd: "ls", sandbox_permissions: "require_escalated" },
                ctx,
            ),
        ).toBe(true);
        expect(
            await execCommand.shouldRunInFullAccessInAutoMode?.(
                { cmd: "ls", sandbox_permissions: "require_escalated" },
                ctx,
            ),
        ).toBe(true);
        // Another vendor's escalation field is not this vendor's surface at all.
        expect(
            Value.Check(execCommand.parameters!, {
                cmd: "ls",
                dangerouslyDisableSandbox: true,
            }),
        ).toBe(false);
    });

    it("describes the exact command and boundary a reviewer decides on", async () => {
        const { tool } = await machine();

        expect(
            tool("exec_command").describeAutoPermissionAction?.(
                {
                    cmd: "npm publish",
                    sandbox_permissions: "require_escalated",
                    justification: "the registry is outside the sandbox",
                },
                ctx,
            ),
        ).toBe(
            'running "npm publish". Working directory: "/workspace". Shell: "the machine\'s default shell". Access: unrestricted filesystem and network access outside the workspace sandbox. Reason given: the registry is outside the sandbox',
        );
    });

    it("reviews typing into a session without ever elevating it", async () => {
        const { tool } = await machine();
        const writeStdin = tool("write_stdin");

        expect(await writeStdin.shouldReviewInAutoMode({ session_id: 1 }, ctx)).toBe(false);
        expect(await writeStdin.shouldReviewInAutoMode({ session_id: 1, chars: "" }, ctx)).toBe(
            false,
        );
        expect(await writeStdin.shouldReviewInAutoMode({ session_id: 1, chars: "y\n" }, ctx)).toBe(
            true,
        );
        // Input reaches nothing the session could not already reach, so it is decided on but
        // never handed a wider boundary than the session already had.
        expect(writeStdin.shouldRunInFullAccessInAutoMode).toBeUndefined();
        expect(
            writeStdin.describeAutoPermissionAction?.({ session_id: 4, chars: "y\n" }, ctx),
        ).toContain('sending "y\\n" to shell session 4');
    });

    it("never asks a reviewer about stopping work Happy Agent itself started", async () => {
        const { tool } = await machine();

        expect(await tool("kill_session").shouldReviewInAutoMode({ session_id: 1 }, ctx)).toBe(
            false,
        );
        expect(tool("kill_session").shouldRunInFullAccessInAutoMode).toBeUndefined();
    });

    it("reviews an image outside the workspace and allows one inside it", async () => {
        const { tool } = await machine();
        const viewImage = tool("view_image");

        expect(await viewImage.shouldReviewInAutoMode({ path: "diagram.png" }, ctx)).toBe(false);
        expect(await viewImage.shouldReviewInAutoMode({ path: "/etc/diagram.png" }, ctx)).toBe(
            true,
        );
        expect(
            await viewImage.shouldRunInFullAccessInAutoMode?.({ path: "/etc/diagram.png" }, ctx),
        ).toBe(true);
        expect(viewImage.describeAutoPermissionAction?.({ path: "/etc/diagram.png" }, ctx)).toBe(
            'viewing "/etc/diagram.png". Access: unrestricted filesystem access outside the workspace sandbox',
        );
    });

    it("shows an image it read and remembers having read it", async () => {
        const { compute, tool, call } = await machine();
        compute.writeBuffer("/workspace/diagram.png", new Uint8Array([1, 2, 3, 4]));

        const result = await tool("view_image").execute(ctx, { path: "diagram.png" }, call);

        expect(result.path).toBe("/workspace/diagram.png");
        expect(result.detail).toBe("high");
        expect(result.image.mime_type).toBe("image/png");
        expect(result.image.bytes).toBe(4);
        expect(tool("view_image").toLLM(result)).toEqual([
            { type: "text", text: "Image: /workspace/diagram.png" },
            { type: "image", data: result.image.data, mimeType: "image/png" },
        ]);
    });

    it("carries the requested detail through without pretending to rescale", async () => {
        const { compute, tool, call } = await machine();
        compute.writeBuffer("/workspace/diagram.png", new Uint8Array([9]));

        const result = await tool("view_image").execute(
            ctx,
            { path: "diagram.png", detail: "original" },
            call,
        );

        expect(result.detail).toBe("original");
    });

    it("refuses a file that is not an image it can show", async () => {
        const { compute, tool, call } = await machine();
        compute.write("/workspace/notes.txt", "not an image\n");

        await expect(tool("view_image").execute(ctx, { path: "notes.txt" }, call)).rejects.toThrow(
            /not a supported image file/,
        );
    });
});
