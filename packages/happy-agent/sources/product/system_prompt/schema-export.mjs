import * as documents from "../../../../happy-agent-modules/sources/systemPrompt/AgentsMd.ts";
import { SystemPromptModule } from "../../../../happy-agent-modules/sources/systemPrompt/SystemPromptModule.ts";
import { systemPromptSelectionSchema } from "../../../../happy-agent-modules/sources/systemPrompt/SystemPromptSelection.ts";
import { systemPromptIdentitySchema } from "../../../../happy-agent-modules/sources/systemPrompt/SystemPromptIdentity.ts";
import { systemPromptAvailableModelsSchema } from "../../../../happy-agent-modules/sources/systemPrompt/SystemPromptAvailableModel.ts";
import {
    assembleEnvironmentPrompt,
    formatAvailableModels,
} from "../../../../happy-agent-modules/sources/systemPrompt/impl/assembleEnvironmentPrompt.ts";
import { systemPromptForModel } from "../../../../happy-agent-modules/sources/systemPrompt/impl/systemPromptForModel.ts";
import { AgentsMdInstructions } from "../../../../happy-agent-modules/sources/systemPrompt/impl/agentsMdInstructions.ts";
import { sourcePrivateSchema } from "../../../scripts/source-private-schema.mjs";
import { writeNativeCapture as writeFileSync } from "../../../scripts/write-native-capture.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGlobalInstructions } from "../../../../happy-agent-modules/sources/config/impl/readGlobalInstructions.ts";
const helpers = await sourcePrivateSchema(
    new URL(
        "../../../../happy-agent-modules/sources/systemPrompt/impl/agentsMdInstructions.ts",
        import.meta.url,
    ),
    [
        "computeFileStatSchema",
        "fingerprintSchema",
        "noticeMetadataSchema",
        "pendingNoticeSchema",
        "turnSnapshotSchema",
        "formatInstructions",
        "formatBody",
        "createFingerprint",
        "isSoundStoredSnapshot",
    ],
);
const promptHelpers = await sourcePrivateSchema(
    new URL(
        "../../../../happy-agent-modules/sources/systemPrompt/SystemPromptModule.ts",
        import.meta.url,
    ),
    ["truncateUtf8WithNotice"],
);
export const systemPromptSchemas = {
    ownerSystemPromptSelection: systemPromptSelectionSchema,
    ownerSystemPromptIdentity: systemPromptIdentitySchema,
    ownerSystemPromptModels: systemPromptAvailableModelsSchema,
    ownerAgentsMdAgentId: documents.agentsMdAgentIdSchema,
    ownerAgentsMdPath: documents.agentsMdPathSchema,
    ownerAgentsMdDocument: documents.agentsMdDocumentSchema,
    ownerAgentsMdGlobalDocument: documents.agentsMdGlobalDocumentSchema,
    ownerAgentsMdSnapshot: documents.agentsMdSnapshotSchema,
    ownerAgentsMdStat: helpers.computeFileStatSchema,
    ownerAgentsMdFingerprint: helpers.fingerprintSchema,
    ownerAgentsMdNotice: helpers.noticeMetadataSchema,
    ownerAgentsMdPending: helpers.pendingNoticeSchema,
    ownerAgentsMdTurnSnapshot: helpers.turnSnapshotSchema,
};
const selections = [
    ...[
        "anthropic/opus-5-5",
        "anthropic/opus-5",
        "anthropic/sonnet-5-5",
        "anthropic/sonnet-5",
        "anthropic/fable-5-1",
        "anthropic/fable-5",
        "anthropic/opus-4-8",
        "openai/gpt-6.1-sol",
        "moonshotai/kimi-k3",
        "zai/glm-5.3",
    ].map((model) => ({ model })),
    { model: "anthropic/future", providerKind: "codex" },
    { model: "openai/future", providerKind: "claude" },
    { model: "xai/future", providerKind: "bedrock" },
    ...["claude", "codex", "grok", "gym", "bedrock"].map((providerKind) => ({ providerKind })),
    {},
];
const promptModule = new SystemPromptModule({}, {});
const prompts = selections.map((selection) => ({
    selection,
    template: systemPromptForModel(selection),
    prompt: promptModule.promptFor(selection),
}));
const models = [
    { name: "Sol", id: "openai/gpt-6.1-sol", providerId: "personal" },
    { name: "Sol work", id: "openai/gpt-6.1-sol", providerId: "work" },
];
const environmentCases = [
    {
        environment: {
            workingDirectory: "/source",
            shell: " /bin/bash ",
            platform: "linux",
            osVersion: "6.12",
        },
        currentModel: "openai/gpt-6.1-sol",
        currentProvider: "work",
        availableModels: models,
    },
    {
        environment: {
            workingDirectory: "C:\\source",
            shell: "C:\\Git\\bash.exe",
            platform: "win32",
            osVersion: "10.0",
        },
        currentModel: "unknown",
        currentProvider: "fixture",
        availableModels: [],
    },
    {
        environment: {
            workingDirectory: "/source",
            shell: "",
            platform: "darwin",
            osVersion: "25",
        },
        currentProvider: "personal",
        availableModels: [],
    },
].map((input) => ({
    input: {
        ...input,
        designSystemPath: "/happy/docs/DESIGN.md",
        documentationPath: "/happy/docs/README.md",
    },
    output: assembleEnvironmentPrompt({
        ...input,
        designSystemPath: "/happy/docs/DESIGN.md",
        documentationPath: "/happy/docs/README.md",
    }),
}));
const snapshots = [
    undefined,
    { cwd: "/source", documents: [] },
    {
        cwd: "/source/sub",
        global: { path: "/happy/config/AGENTS.md", text: "Global <intent>" },
        security: { path: "/source/AGENTS_SECURITY.md", text: "Keep credentials private" },
        documents: [
            { path: "/source/AGENTS.md", text: "Root rules" },
            { path: "/source/sub/AGENTS.md", text: "Child rules", truncated: true },
        ],
        truncated: true,
    },
];
const formatCases = snapshots.map((snapshot) => ({
    snapshot: snapshot ?? null,
    body: helpers.formatBody(snapshot),
    instructions: helpers.formatInstructions(snapshot),
    fingerprint: helpers.formatBody(snapshot).length
        ? helpers.createFingerprint(helpers.formatBody(snapshot))
        : null,
}));
const fsCases = [
    {
        cwd: "/source/sub/deep",
        files: {
            "/source/.git": "git",
            "/source/AGENTS.md": " Root rules \n",
            "/source/AGENTS_SECURITY.md": " Security rules ",
            "/source/sub/AGENTS.md": "Child rules",
            "/AGENTS.md": "Outside",
        },
    },
    {
        cwd: "/source/sub",
        files: {
            "/source/AGENTS.md": "Outside without git",
            "/source/sub/AGENTS.md": "Current folder only",
        },
    },
    {
        cwd: "/source/sub",
        files: {
            "/source/.git": "git",
            "/source/AGENTS.md": "x".repeat(65537),
            "/source/sub/AGENTS.md": "Child still delivered",
        },
    },
    { cwd: "/source", files: { "/source/AGENTS.md": "linked" }, symbolic: ["/source/AGENTS.md"] },
];
const ctx = {};
const config = {
    configuration: { paths: { instructionsPath: "/happy/config/AGENTS.md" } },
    readGlobalInstructions: async () => undefined,
};
const readCases = [];
for (const input of fsCases) {
    const compute = {
        cwd: input.cwd,
        fs: {
            exists: async (_, path) => Object.hasOwn(input.files, path),
            lstat: async (_, path) => {
                if (!Object.hasOwn(input.files, path))
                    throw Object.assign(new Error(`No such path: ${path}`), { code: "ENOENT" });
                return {
                    isFile: true,
                    isDirectory: false,
                    isSymbolicLink: input.symbolic?.includes(path) ?? false,
                    size: Buffer.byteLength(input.files[path]),
                    mtimeMs: 1,
                };
            },
            readFileBuffer: async (_, path) => Buffer.from(input.files[path]),
        },
    };
    const reader = new AgentsMdInstructions(config, {
        resolve: async () => compute,
        permissionsForContext: () => ({ mode: "auto" }),
    });
    try {
        readCases.push({ input, snapshot: await reader.read(ctx, "source-agent") });
    } catch (error) {
        readCases.push({ input, error: error.message });
    }
}
writeFileSync(
    new URL("prompts.json", import.meta.url),
    JSON.stringify(
        prompts.map(({ selection, template }) => ({ selection, template })),
        null,
        2,
    ) + "\n",
);
writeFileSync(new URL("agents-md-spec.txt", import.meta.url), documents.AGENTS_MD_SPEC);
const outputCases = [0, 1, 20, 120, 180, 250].map((maximum) => ({
    maximum,
    input: "é😀".repeat(80),
    output: promptHelpers.truncateUtf8WithNotice("é😀".repeat(80), maximum),
}));
const globalReadCases = [];
const temporary = await mkdtemp(join(tmpdir(), "source-prompt-"));
try {
    for (const bytes of [
        Buffer.from("short"),
        Buffer.from("1234567890"),
        Buffer.from("1234567🚀tail"),
        Buffer.from("\ufeff123456789tail"),
        Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    ]) {
        const path = join(temporary, "AGENTS.md");
        await writeFile(path, bytes);
        globalReadCases.push({
            bytes: [...bytes],
            maximum: 8,
            output: await readGlobalInstructions(ctx, path, 8),
        });
    }
} finally {
    await rm(temporary, { recursive: true });
}
const noticeFiles = new Map([["/source/AGENTS.md", "First rules"]]);
const noticeCompute = {
    cwd: "/source",
    fs: {
        exists: async () => false,
        lstat: async (_, path) => {
            if (!noticeFiles.has(path))
                throw Object.assign(new Error(`No such path: ${path}`), { code: "ENOENT" });
            return {
                isFile: true,
                isDirectory: false,
                isSymbolicLink: false,
                size: Buffer.byteLength(noticeFiles.get(path)),
                mtimeMs: 1,
            };
        },
        readFileBuffer: async (_, path) => Buffer.from(noticeFiles.get(path)),
    },
};
const noticeReader = new AgentsMdInstructions(config, {
    resolve: async () => noticeCompute,
    permissionsForContext: () => ({ mode: "auto" }),
});
function kv() {
    const values = new Map();
    return {
        values,
        read: async (_, key) => values.get(key),
        write: async (_, key, value) => {
            values.set(key, structuredClone(value));
        },
        delete: async (_, key) => {
            values.delete(key);
        },
        update: async (_, key, body) => {
            const value = body(values.get(key));
            values.set(key, structuredClone(value));
            return value;
        },
    };
}
const noticeScope = { agent: { id: "source-agent" }, kv: kv(), runKV: kv() };
await noticeReader.beforeTurn(ctx, noticeScope);
await noticeReader.instructions(ctx, noticeScope);
noticeFiles.set("/source/AGENTS.md", "Replacement rules");
const replacementAction = (await noticeReader.beforeTurn(ctx, noticeScope))[0];
const repeatedAction = (await noticeReader.beforeTurn(ctx, noticeScope))[0];
if (replacementAction.id !== repeatedAction.id)
    throw new Error("Source pending notice identity changed");
await noticeReader.messageAcceptedTransact(ctx, noticeScope, {
    kind: "steering",
    id: replacementAction.id,
    message: replacementAction.message,
    metadata: replacementAction.metadata,
});
const acceptedFingerprint = noticeScope.kv.values.get("last-delivered-fingerprint");
if (noticeScope.kv.values.has("pending-notice"))
    throw new Error("Source did not accept replacement notice");
noticeFiles.delete("/source/AGENTS.md");
const removalAction = (await noticeReader.beforeTurn(ctx, noticeScope))[0];
for (const action of [replacementAction, removalAction]) {
    action.id = "sourcenotice";
    action.metadata.agentsMd.noticeId = "sourcenotice";
}
const noticeCases = { replacementAction, removalAction, acceptedFingerprint };
writeFileSync(
    new URL("source_goldens.json", import.meta.url),
    JSON.stringify(
        {
            prompts: prompts.map(({ selection, prompt }) => ({ selection, prompt })),
            models,
            modelText: formatAvailableModels(models),
            environmentCases,
            formatCases,
            readCases,
            outputCases,
            globalReadCases,
            noticeCases,
        },
        null,
        2,
    ) + "\n",
);
