import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { CodexApiKeyCredential, type CodexProviderOptions } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigModule, parseHappyAgentConfigToml } from "../../sources/config/index.js";
import { agentProviders, smartProviderRoute } from "../../sources/config/impl/agentCatalog.js";
import {
    codexAccessProgramSchema,
    createConfiguredCodexProvider,
} from "../../sources/config/impl/codexAccessPrograms.js";
import { testConfigRootedAt } from "../support/configModule.js";

const selectedSchema = Type.Object({
    cyberAccessProgram: Type.Optional(codexAccessProgramSchema),
});
const sdk = vi.hoisted(() => ({
    programs: undefined as unknown,
    ignoreSelection: false,
    requests: [] as unknown[],
}));

// Model the published SDK boundary without linking the local unpublished provider package.
vi.mock("@slopus/happy-providers", async (original) => {
    const actual = await original<typeof import("@slopus/happy-providers")>();
    return {
        ...actual,
        CodexProvider: class extends actual.CodexProvider {
            static get cyberAccessPrograms(): unknown {
                return sdk.programs;
            }
            readonly cyberAccessProgram: Static<typeof codexAccessProgramSchema> | undefined;
            constructor(options: CodexProviderOptions) {
                super(options);
                sdk.requests.push(options);
                this.cyberAccessProgram =
                    !sdk.ignoreSelection && Value.Check(selectedSchema, options)
                        ? options.cyberAccessProgram
                        : undefined;
            }
        },
    };
});

let root: string;
let authFile: string;
beforeEach(async () => {
    sdk.programs = undefined;
    sdk.ignoreSelection = false;
    sdk.requests.length = 0;
    root = await mkdtemp(join(tmpdir(), "happy-codex-access-"));
    authFile = join(root, "auth.json");
    await writeFile(
        authFile,
        JSON.stringify({
            auth_mode: "chatgpt",
            tokens: { access_token: "fake-token", account_id: "fake-account", id_token: null },
        }),
    );
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

function profile(id: string, program?: string): string {
    return (
        `[providers.${id}]\ntype = "codex"\nenabled = true\nauth_file = ${JSON.stringify(authFile)}\n` +
        (program === undefined ? "" : `cyber_access_program = ${JSON.stringify(program)}\n`)
    );
}

describe("Codex access profiles", () => {
    it.each(["standard", "daybreak_blue", "daybreak_red"])(
        "normalizes %s and preserves it across runtime rewrites",
        async (program) => {
            const toml = profile("account", program);
            expect(parseHappyAgentConfigToml(toml).unknownSettings).toEqual([]);
            const config = await testConfigRootedAt(root, toml);
            expect(config.configuration.values.providers.account).toMatchObject({
                cyberAccessProgram: program,
            });
            await config.updateRuntimeProviderStates(createRootContext(), {
                account: { autoEnable: true },
            });
            const reloaded = await ConfigModule.load(config.configuration.paths.happyHome);
            expect(reloaded.configuration.values.providers.account).toMatchObject({
                cyberAccessProgram: program,
            });
        },
    );

    it.each(['"blue"', '"red"', "true", "1"])("rejects invalid setting %s", (value) => {
        expect(() =>
            parseHappyAgentConfigToml(
                `[providers.account]\ntype = "codex"\ncyber_access_program = ${value}\n`,
            ),
        ).toThrow();
    });

    it("omits the option for ordinary access and forwards separate helper modes", async () => {
        sdk.programs = ["standard", "daybreak_blue", "daybreak_red"];
        const config = await testConfigRootedAt(
            root,
            profile("codex") +
                profile("codex-standard", "standard") +
                profile("codex-blue", "daybreak_blue") +
                profile("codex-red", "daybreak_red"),
        );
        for (const id of ["codex", "codex-standard", "codex-blue", "codex-red"])
            expect(config.models.some((model) => model.providerId === id)).toBe(true);
        expect(config.isSubagentModelAllowed("codex-blue", "openai/gpt-6-sol")).toBe(true);
        expect(config.isSubagentModelAllowed("codex-red", "openai/gpt-6-luna")).toBe(true);
        const providers = agentProviders(config.configuration);
        const ordinary = await providers.resolve("codex", "openai/gpt-6-sol");
        const standard = await providers.resolve("codex-standard", "openai/gpt-6-sol");
        const blue = await providers.resolve("codex-blue", "openai/gpt-6-sol");
        const red = await providers.resolve("codex-red", "openai/gpt-6-luna");
        expect(ordinary).toMatchObject({ cyberAccessProgram: undefined });
        expect(standard).toMatchObject({ cyberAccessProgram: "standard" });
        expect(blue).toMatchObject({ cyberAccessProgram: "daybreak_blue" });
        expect(red).toMatchObject({ cyberAccessProgram: "daybreak_red" });
        expect(Object.hasOwn(sdk.requests[0] ?? {}, "cyberAccessProgram")).toBe(false);
        expect(sdk.requests.slice(1)).toMatchObject([
            { cyberAccessProgram: "standard" },
            { cyberAccessProgram: "daybreak_blue" },
            { cyberAccessProgram: "daybreak_red" },
        ]);
        expect(ordinary).not.toBe(blue);
        expect(blue).not.toBe(red);
    });

    it("does not offer unsupported profiles or silently route their smart aliases to Standard", async () => {
        const config = await testConfigRootedAt(
            root,
            profile("codex") +
                profile("codex-blue", "daybreak_blue") +
                '[providers.router]\ntype = "smart"\nenabled = true\nproviders = ["codex-blue", "codex"]\n',
        );
        expect(config.isProviderEnabled("codex")).toBe(true);
        expect(config.isProviderEnabled("codex-blue")).toBe(false);
        expect(config.isSubagentModelAllowed("codex-blue", "openai/gpt-6-sol")).toBe(false);
        expect(
            config.catalog.some(
                (model) => model.providerId === "codex-blue" || model.providerId === "router",
            ),
        ).toBe(false);
        await expect(
            agentProviders(config.configuration).resolve("codex-blue", "openai/gpt-6-sol"),
        ).rejects.toThrow(/published.*SDK/);
        expect(sdk.requests).toEqual([]);
    });

    it("rejects an SDK that advertises the mode but ignores its option", async () => {
        sdk.programs = ["daybreak_blue"];
        sdk.ignoreSelection = true;
        const config = await testConfigRootedAt(root, profile("codex-blue", "daybreak_blue"));
        await expect(
            agentProviders(config.configuration).resolve("codex-blue", "openai/gpt-6-sol"),
        ).rejects.toThrow(/published.*SDK/);
    });

    it("rejects API-key credentials for explicit access", async () => {
        sdk.programs = ["standard"];
        const credential = await CodexApiKeyCredential.tryLoad({ apiKey: "fake-key" });
        if (credential === null) throw new Error("Missing fake API credential.");
        expect(() => createConfiguredCodexProvider({ credential }, "standard")).toThrow(
            /ChatGPT Codex session/,
        );
        expect(sdk.requests).toEqual([]);
    });

    it("keeps smart routing within one program and treats omitted access as Standard", async () => {
        sdk.programs = ["standard", "daybreak_blue", "daybreak_red"];
        const config = await testConfigRootedAt(
            root,
            profile("codex") +
                profile("blue", "daybreak_blue") +
                profile("blue2", "daybreak_blue") +
                profile("red", "daybreak_red") +
                profile("ordinary", "standard") +
                '[providers.blue-router]\ntype = "smart"\nproviders = ["blue", "red", "codex", "blue2"]\n' +
                '[providers.ordinary-router]\ntype = "smart"\nproviders = ["codex", "ordinary", "blue"]\n',
        );
        const blue = smartProviderRoute(config.configuration, "blue-router");
        const ordinary = smartProviderRoute(config.configuration, "ordinary-router");
        expect(blue?.models.length).toBeGreaterThan(0);
        expect(
            blue?.models.every(
                (route) => JSON.stringify(route.candidates) === JSON.stringify(["blue", "blue2"]),
            ),
        ).toBe(true);
        expect(
            ordinary?.models.every(
                (route) =>
                    JSON.stringify(route.candidates) === JSON.stringify(["codex", "ordinary"]),
            ),
        ).toBe(true);
    });
});
