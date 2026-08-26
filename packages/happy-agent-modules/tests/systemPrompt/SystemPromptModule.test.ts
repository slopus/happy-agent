import {
    withAgentConfig,
    type AgentModel,
    type AgentModuleAgent,
    type AgentModuleScope,
    type MaybePromise,
} from "@slopus/happy-agent-base";
import type { ProviderModelCompatibilityType } from "@slopus/happy-providers";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { AGENTS_MD_SPEC } from "../../sources/systemPrompt/AgentsMd.js";
import {
    SystemPromptModule,
    MAX_SYSTEM_PROMPT_OUTPUT_BYTES,
    MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES,
    MAX_SYSTEM_PROMPT_AVAILABLE_MODELS,
    systemPromptSelectionSchema,
} from "../../sources/systemPrompt/SystemPromptModule.js";
import { systemPromptIdentitySchema } from "../../sources/systemPrompt/SystemPromptIdentity.js";
import {
    systemPromptAvailableModelSchema,
    systemPromptAvailableModelsSchema,
} from "../../sources/systemPrompt/SystemPromptAvailableModel.js";
import { formatAvailableModels } from "../../sources/systemPrompt/impl/assembleEnvironmentPrompt.js";
import { systemPromptForModel } from "../../sources/systemPrompt/impl/systemPromptForModel.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { catalogModel, systemPromptWorld } from "./support/systemPromptWorld.js";

const ctx: Context = createRootContext();
const testEnvironment = {
    osVersion: "25.5.0",
    platform: "darwin" as const,
    workingDirectory: "/workspace",
    shell: "/bin/zsh",
};
const twoModelCatalog: readonly AgentModel[] = [
    catalogModel("Claude Opus", "anthropic/opus-5", "anthropic"),
    catalogModel("Codex", "openai/gpt-5.6-sol", "openai"),
];

/** A scope naming only what the module reads: which model the agent is running on. */
function scopeOf(
    model: string | undefined,
    providerKind: ProviderModelCompatibilityType | undefined,
): AgentModuleScope {
    const agent: AgentModuleAgent = {
        effort: undefined,
        id: "agent",
        metadata: undefined,
        model,
        permissionMode: "auto",
        provider: "provider",
        providerKind,
        tier: undefined,
    };
    return { agent } as AgentModuleScope;
}

function contextWithEnvironment(environment = testEnvironment): Context {
    return withAgentConfig(ctx, { environment });
}

/** A module whose configuration serves exactly the catalog a test names. */
async function moduleWithCatalog(models: readonly AgentModel[] = []): Promise<{
    readonly module: SystemPromptModule;
    readonly docsHome: string;
    readonly instructions: (promptCtx: Context, scope: AgentModuleScope) => MaybePromise<string>;
}> {
    const world = await systemPromptWorld({ models });
    const hooks = await resolveModuleHooks(ctx, world.module);
    return {
        module: world.module,
        docsHome: world.config.configuration.paths.docsHome,
        instructions: hooks.instructions!,
    };
}

function catalogWithBytes(targetBytes: number): AgentModel[] {
    const fieldLength = 158;
    const catalog = Array.from({ length: MAX_SYSTEM_PROMPT_AVAILABLE_MODELS }, () => ({
        name: "x".repeat(fieldLength),
        id: "x".repeat(fieldLength),
        providerId: "x".repeat(fieldLength),
    }));
    const baseBytes = new TextEncoder().encode(formatAvailableModels(catalog)).byteLength;
    let remaining = targetBytes - baseBytes;
    if (remaining < 0 || remaining > (256 - fieldLength) * catalog.length) {
        throw new Error("The test catalog target is outside the available adjustment range.");
    }
    for (let index = 0; remaining > 0; index += 1) {
        const added = Math.min(256 - fieldLength, remaining);
        catalog[index]!.name = "x".repeat(fieldLength + added);
        remaining -= added;
    }
    return catalog.map(({ name, id, providerId }) => catalogModel(name, id, providerId));
}

describe("SystemPromptModule", () => {
    it("gives each model the prompt it was written for", async () => {
        const { instructions } = await moduleWithCatalog();

        const opus5 = await instructions(ctx, scopeOf("anthropic/opus-5", "claude"));
        const opus48 = await instructions(ctx, scopeOf("anthropic/opus-4-8", "claude"));
        const codex = await instructions(ctx, scopeOf("openai/gpt-5.6-sol", "codex"));

        expect(opus5).toContain("mid-conversation system turns");
        expect(opus48).not.toContain("mid-conversation system turns");
        expect(opus5).not.toBe(opus48);
        expect(codex).not.toBe(opus5);
        expect(codex.length).toBeGreaterThan(0);
    });

    it("follows the model rather than the provider it is served through", async () => {
        const { instructions } = await moduleWithCatalog();

        expect(await instructions(ctx, scopeOf("anthropic/opus-5", "bedrock"))).toBe(
            await instructions(ctx, scopeOf("anthropic/opus-5", "claude")),
        );
        expect(await instructions(ctx, scopeOf("xai/grok-build", "grok"))).toBe(
            await instructions(ctx, scopeOf("xai/grok-4.5", "grok")),
        );
    });

    it("falls back to the provider's family when the model is unknown or absent", async () => {
        const { instructions } = await moduleWithCatalog();

        expect(await instructions(ctx, scopeOf("openai/gpt-9-unreleased", "codex"))).toBe(
            await instructions(ctx, scopeOf("openai/gpt-5.6-sol", "codex")),
        );
        expect(await instructions(ctx, scopeOf(undefined, "grok"))).toBe(
            await instructions(ctx, scopeOf("xai/grok-4.5", "grok")),
        );
    });

    it("falls back to the simple prompt when nothing was written for the model", async () => {
        const { instructions } = await moduleWithCatalog();

        const unknown = await instructions(ctx, scopeOf("mystery/model", "gym"));

        expect(unknown).toContain("You are an expert coding assistant.");
        expect(unknown.startsWith("You are Happy Agent, built by Happy")).toBe(true);
        expect(await instructions(ctx, scopeOf(undefined, undefined))).toBe(unknown);
    });

    it("names Happy Agent in every prompt and leaves no identity marker behind", async () => {
        const { instructions } = await moduleWithCatalog();
        const [claudePrompt, codexPrompt] = await Promise.all([
            instructions(ctx, scopeOf("anthropic/opus-5", "claude")),
            instructions(ctx, scopeOf("openai/gpt-5.6-sol", "codex")),
        ]);

        for (const prompt of [claudePrompt, codexPrompt]) {
            expect(prompt.startsWith("You are Happy Agent, built by Happy")).toBe(true);
            expect(prompt).not.toContain("{{identity}}");
            expect(prompt).not.toContain("{{name}}");
        }
        expect(codexPrompt).toContain("As Happy Agent,");
    });

    it("appends the machine environment and every configured model route", async () => {
        const { instructions } = await moduleWithCatalog(twoModelCatalog);

        const prompt = await instructions(
            contextWithEnvironment(),
            scopeOf("anthropic/opus-5", "claude"),
        );

        expect(prompt).toContain("# Environment");
        expect(prompt).toContain("- Primary working directory: /workspace");
        expect(prompt).toContain("- Platform: darwin");
        expect(prompt).toContain("- Shell: /bin/zsh");
        expect(prompt).toContain("- OS version: 25.5.0");
        expect(prompt).toContain("- Current model: Claude Opus (`anthropic/opus-5`)");
        expect(prompt).toContain("- Current provider: `provider`");
        expect(prompt).toContain("- Happy Agent documentation: ");
        expect(prompt).toContain("/.happy/docs/README.md");
        expect(prompt).toContain(
            "- Happy design system: When the user asks for a temporary page unrelated to their work, or asks to use the Happy design system, read and follow ",
        );
        expect(prompt).toContain("/.happy/docs/DESIGN.md");
        expect(prompt).toContain(
            "- Scratch directory: `.context/` in the working directory. Strongly prefer it",
        );
        expect(prompt).toContain(
            "- By default the user sees only the last message you send before stopping;",
        );
        expect(prompt).toContain(
            "- When the project is a Git folder, a workspace and a worktree are the same thing:",
        );
        expect(prompt).toContain(
            "## Available models\n- Claude Opus — model ID: `anthropic/opus-5`; provider ID: `anthropic`\n- Codex — model ID: `openai/gpt-5.6-sol`; provider ID: `openai`",
        );
    });

    it("omits the environment section when the context has no environment", async () => {
        const { module, instructions } = await moduleWithCatalog(twoModelCatalog);
        const selection = { model: "anthropic/opus-5", providerKind: "claude" as const };

        const prompt = await instructions(ctx, scopeOf(selection.model, selection.providerKind));

        expect(prompt).toBe([module.promptFor(selection), AGENTS_MD_SPEC].join("\n\n"));
        expect(prompt).not.toContain("# Environment");
    });

    it("omits blank shell and an empty configured catalog", async () => {
        const { instructions } = await moduleWithCatalog();
        const prompt = await instructions(
            contextWithEnvironment({ ...testEnvironment, shell: "" }),
            scopeOf("anthropic/opus-5", "claude"),
        );

        expect(prompt).not.toContain("- Shell:");
        expect(prompt).not.toContain("## Available models");
        expect(prompt).toContain("- Current model: `anthropic/opus-5`");
    });

    it("renders the complete legacy environment text in its exact order", async () => {
        const { docsHome, module, instructions } = await moduleWithCatalog(twoModelCatalog);
        const selection = { model: "anthropic/opus-5", providerKind: "claude" as const };
        const expectedEnvironment = [
            "# Environment",
            "- Primary working directory: /workspace",
            "- Platform: darwin",
            "- Shell: /bin/zsh",
            "- OS version: 25.5.0",
            "- Current model: Claude Opus (`anthropic/opus-5`)",
            "- Current provider: `provider`",
            `- Happy Agent documentation: ${docsHome}/README.md`,
            `- Happy design system: When the user asks for a temporary page unrelated to their work, or asks to use the Happy design system, read and follow ${docsHome}/DESIGN.md.`,
            "- Scratch directory: `.context/` in the working directory. Strongly prefer it for temporary files, throwaway scripts, and notes or instructions for other agents; keep it gitignored (add the entry if missing) unless there is a real reason not to, and never commit it.",
            "- By default the user sees only the last message you send before stopping; earlier messages are collapsed. Include all essential information in that last message.",
            "- When the project is a Git folder, a workspace and a worktree are the same thing: creating a workspace creates a new worktree, and deleting a workspace archives it.",
            "",
            "## Available models",
            "- Claude Opus — model ID: `anthropic/opus-5`; provider ID: `anthropic`",
            "- Codex — model ID: `openai/gpt-5.6-sol`; provider ID: `openai`",
        ].join("\n");

        expect(
            await instructions(
                contextWithEnvironment(),
                scopeOf(selection.model, selection.providerKind),
            ),
        ).toBe([module.promptFor(selection), expectedEnvironment, AGENTS_MD_SPEC].join("\n\n"));
    });

    it("accepts the exact catalog byte boundary and refuses the next byte", async () => {
        const below = catalogWithBytes(MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES - 1);
        const equal = catalogWithBytes(MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES);
        const above = catalogWithBytes(MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES + 1);
        const scope = scopeOf("anthropic/opus-5", "claude");

        expect(new TextEncoder().encode(formatAvailableModels(equal)).byteLength).toBe(
            MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES,
        );
        await expect(
            (await moduleWithCatalog(below)).instructions(contextWithEnvironment(), scope),
        ).resolves.toContain("## Available models");
        await expect(
            (await moduleWithCatalog(equal)).instructions(contextWithEnvironment(), scope),
        ).resolves.toContain("## Available models");
        await expect(
            (await moduleWithCatalog(above)).instructions(contextWithEnvironment(), scope),
        ).rejects.toThrow("System prompt available models exceed the configured UTF-8 byte bound");
    });

    it("refuses a configured catalog past the item or Unicode UTF-8 bounds", async () => {
        const plainModel = catalogModel("Model", "model", "provider");
        const scope = scopeOf("anthropic/opus-5", "claude");
        const maximumModels = Array.from(
            { length: MAX_SYSTEM_PROMPT_AVAILABLE_MODELS },
            () => plainModel,
        );
        await expect(
            (await moduleWithCatalog(maximumModels)).instructions(contextWithEnvironment(), scope),
        ).resolves.toContain("## Available models");

        const tooManyModels = Array.from(
            { length: MAX_SYSTEM_PROMPT_AVAILABLE_MODELS + 1 },
            () => plainModel,
        );
        await expect(
            (await moduleWithCatalog(tooManyModels)).instructions(contextWithEnvironment(), scope),
        ).rejects.toThrow("System prompt available models are invalid");

        const unicodeField = "😀".repeat(128);
        const unicodeCatalog = Array.from({ length: MAX_SYSTEM_PROMPT_AVAILABLE_MODELS }, () =>
            catalogModel(unicodeField, unicodeField, unicodeField),
        );
        await expect(
            (await moduleWithCatalog(unicodeCatalog)).instructions(contextWithEnvironment(), scope),
        ).rejects.toThrow("System prompt available models exceed the configured UTF-8 byte bound");

        await expect(
            (await moduleWithCatalog([catalogModel("bad\nname", "id", "provider")])).instructions(
                contextWithEnvironment(),
                scope,
            ),
        ).rejects.toThrow("System prompt available models are invalid");
    });

    it("fits a maximal AGENTS.md chain into the remaining UTF-8 prompt budget", async () => {
        const compute = new FakeCompute("/workspace/packages/app");
        compute.directories.add("/workspace/.git");
        const document = "界".repeat(32_000);
        compute.write("/workspace/AGENTS_SECURITY.md", document);
        compute.write("/workspace/AGENTS.md", document);
        compute.write("/workspace/packages/AGENTS.md", document);
        compute.write("/workspace/packages/app/AGENTS.md", document);
        const world = await systemPromptWorld({
            models: catalogWithBytes(MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES - 1),
            globalInstructions: "界".repeat(131_072),
            compute: async () => compute,
        });
        const hooks = await resolveModuleHooks(ctx, world.module);

        const prompt = await hooks.instructions!(
            contextWithEnvironment(),
            scopeOf("anthropic/opus-5", "claude"),
        );

        expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(
            MAX_SYSTEM_PROMPT_OUTPUT_BYTES,
        );
        expect(prompt).toContain("omitted to stay within the system prompt byte limit.");
    });

    it("enforces the combined prompt output byte bound after appending the environment", async () => {
        const environmentCtx = contextWithEnvironment({
            ...testEnvironment,
            osVersion: "x".repeat(MAX_SYSTEM_PROMPT_OUTPUT_BYTES),
        });
        const { instructions } = await moduleWithCatalog();

        await expect(
            instructions(environmentCtx, scopeOf("anthropic/opus-5", "claude")),
        ).rejects.toThrow("The system prompt exceeds the configured output bound");
    });

    it("keeps the catalog it first published and validates its bounded contract", async () => {
        const models = [catalogModel("Claude Opus", "anthropic/opus-5", "anthropic")];
        const { instructions } = await moduleWithCatalog(models);
        const environmentCtx = contextWithEnvironment();
        const scope = scopeOf("anthropic/opus-5", "claude");

        expect(await instructions(environmentCtx, scope)).toContain(
            "- Claude Opus — model ID: `anthropic/opus-5`",
        );
        (models[0] as { name: string }).name = "Mutated";
        expect(await instructions(environmentCtx, scope)).toContain(
            "- Claude Opus — model ID: `anthropic/opus-5`",
        );

        expect(
            Value.Check(systemPromptAvailableModelSchema, {
                name: "Model",
                id: "model",
                providerId: "provider",
                unexpected: true,
            }),
        ).toBe(false);
        expect(
            Value.Check(systemPromptAvailableModelsSchema, [
                { name: "Model", id: "model", providerId: "provider" },
            ]),
        ).toBe(true);
        expect(
            Value.Check(systemPromptAvailableModelsSchema, [
                ...Array.from({ length: MAX_SYSTEM_PROMPT_AVAILABLE_MODELS + 1 }, () => ({
                    name: "Model",
                    id: "model",
                    providerId: "provider",
                })),
            ]),
        ).toBe(false);
    });

    it("takes only modules and keeps the identity contract closed", async () => {
        const world = await systemPromptWorld();

        expect(SystemPromptModule.length).toBe(2);
        expect(world.module.name).toBe("system-prompt");
        expect(
            Value.Check(systemPromptIdentitySchema, {
                name: "Scout",
                prompt: "{{identity}}",
            }),
        ).toBe(false);
        expect(
            Value.Check(systemPromptIdentitySchema, {
                name: "Scout\u0000",
                prompt: "You are Scout",
            }),
        ).toBe(false);
        expect(
            Value.Check(systemPromptIdentitySchema, {
                name: "Scout",
                prompt: "You are Scout",
                unexpected: true,
            }),
        ).toBe(false);
    });

    it("validates public model selection and keeps the selector provider-neutral", () => {
        expect(
            Value.Check(systemPromptSelectionSchema, {
                model: undefined,
                providerKind: "codex",
            }),
        ).toBe(true);
        expect(
            Value.Check(systemPromptSelectionSchema, {
                model: "x".repeat(257),
            }),
        ).toBe(false);
        expect(
            Value.Check(systemPromptSelectionSchema, {
                model: "openai/gpt-5.6-sol",
                extra: "not accepted",
            }),
        ).toBe(false);
        expect(() => systemPromptForModel({ providerKind: "not-a-provider" } as never)).toThrow(
            "System prompt model selection is invalid",
        );
        expect(() => systemPromptForModel({ model: "\u0000" } as never)).toThrow(
            "System prompt model selection is invalid",
        );
        expect(systemPromptForModel({ model: "__proto__" })).toContain(
            "You are an expert coding assistant.",
        );
    });
});
