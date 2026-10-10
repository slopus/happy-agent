import * as original from "../../../../happy-agent-modules/sources/skills/Skills.ts";
import { SkillsModule } from "../../../../happy-agent-modules/sources/skills/SkillsModule.ts";
import { parseSkillFrontmatter } from "../../../../happy-agent-modules/sources/skills/impl/parseSkillFrontmatter.ts";
import { sourcePrivateSchema } from "../../../scripts/source-private-schema.mjs";
import { invokeSlashCommandRequestSchema, slashCommandSchema } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { writeNativeCapture as writeFileSync } from "../../../scripts/write-native-capture.mjs";
const helpers = await sourcePrivateSchema(
    new URL("../../../../happy-agent-modules/sources/skills/SkillsModule.ts", import.meta.url),
    [
        "discoveredRootSchema",
        "directoryPageSchema",
        "skillInvocationSchema",
        "skillInvocationsSchema",
        "skillReadRequestsSchema",
        "readSkillRequestSchema",
        "formatInstructions",
        "formatInvokedSkill",
        "fitListPage",
        "renderList",
    ],
);
const compute = {
    cwd: "/source",
    fs: Object.fromEntries(
        ["exists", "lstat", "lstatMany", "readFileBuffer", "readdirPage", "realpath", "stat"].map(
            (name) => [name, () => undefined],
        ),
    ),
};
const module = new SkillsModule({ resolve: async () => compute });
export const skillsTools = await module
    .beforeStart(undefined, undefined)
    .tools(undefined, { agent: { id: "source-agent" } });
export const skillsSchemas = {
    ownerDiscoveredSkill: original.skillEntrySchema,
    ownerDiscoveredSkillDocument: original.skillDocumentSchema,
    ownerDiscoveredSkillList: original.skillListResultSchema,
    ownerDiscoveredSkillListInput: original.skillListInputSchema,
    ownerDiscoveredSkillReadInput: original.skillReadInputSchema,
    ownerDiscoveredSkillRoot: helpers.discoveredRootSchema,
    ownerDiscoveredSkillDirectoryPage: helpers.directoryPageSchema,
    ownerDiscoveredSkillInvocation: helpers.skillInvocationSchema,
    ownerDiscoveredSkillInvocations: helpers.skillInvocationsSchema,
    ownerDiscoveredSkillReadRequests: helpers.skillReadRequestsSchema,
    ownerDiscoveredSkillReadRequest: helpers.readSkillRequestSchema,
    ownerDiscoveredSkillSlashRequest: invokeSlashCommandRequestSchema,
    ownerDiscoveredSkillSlashCommand: slashCommandSchema,
    ownerDiscoveredSkillSlashPreparation: Type.Object(
        {
            agentId: Type.String({ minLength: 1, maxLength: 256 }),
            request: invokeSlashCommandRequestSchema,
            document: original.skillDocumentSchema,
            messageId: helpers.skillInvocationSchema.properties.messageId,
        },
        { additionalProperties: false },
    ),
};
for (const tool of skillsTools) skillsSchemas[`ownerTool_${tool.name}`] = tool.parameters;
const entries = [
    {
        name: "build",
        description: "Build <release> & inspect",
        location: "/source/.agents/skills/build/SKILL.md",
        source: "project",
    },
    {
        name: "deploy",
        description: "Publish safely",
        location: "/home/.agents/skills/deploy/SKILL.md",
        source: "user",
        disableModelInvocation: true,
    },
];
const frontmatter = [
    '---\nname: quoted\ndescription: "Build & inspect"\n---\nFull instructions\n',
    "--- # comment\nname: block\ndescription: >-\n  First line\n  second line\n\n  paragraph\n --- # closing\nbody",
    "---\n{ name: flow, description: 'Publish, then inspect', disable-model-invocation: true }\n---\nbody",
    "---\nname: &name alias\ndescription: *name\n---\nbody",
    "---\nname: false\ndescription: [ignored]\n---\nbody",
    '---\nname: duplicates\ndescription: first\ndescription: true\ndescription: final\ndisable-model-invocation: true\ndisable-model-invocation: "true"\n---\nbody',
    "---\nname: reserved\ndescription: User only\ndisable-model-invocation: TRUE # comment\n---\nbody",
    "---\nname: ignored-runtime\ndescription: Plain instructions\npermissionMode: full_access\ninvoke: auto\nmetadata:\n  placement: pre\n---\nbody",
    "name: no-frontmatter\ndescription: Missing delimiters",
    "\ufeff---\nname: bom\ndescription: Missing opening marker\n---\nbody",
    '---\nname: malformed\ndescription: "unterminated\n---\nbody',
    '---\nname: long-description\ndescription: "' + "😀".repeat(513) + '"\n---\nbody',
];
const parserCases = frontmatter.map((content) => {
    try {
        return {
            content,
            directory: "fallback",
            metadata: parseSkillFrontmatter(content, "fallback"),
        };
    } catch (error) {
        return { content, directory: "fallback", error: error.message };
    }
});
const pages = [
    [0, 1],
    [0, 256],
    [1, 1],
    [99, 1],
].map(([offset, limit]) => ({
    offset,
    limit,
    result: helpers.fitListPage(entries, offset, limit),
}));
const invocation = {
    name: "deploy",
    messageId: "source-message",
    location: entries[1].location,
    content: "Complete <instructions>\n",
};
const sortNames = [
    "a",
    "A",
    "a-a",
    "a_a",
    "a.a",
    "a0",
    "aa",
    "Build",
    "build",
    "0",
    "9",
    "x",
    "a-B",
    "A-b",
    "a-b",
    "a--",
    "a-_",
];
const documents = new Map(
    sortNames.map((name) => [
        `/source/.agents/skills/${name}/SKILL.md`,
        `---\nname: ${JSON.stringify(name)}\ndescription: Sort order\n---\nbody`,
    ]),
);
const directoryNames = (path) =>
    [
        ...new Set(
            [...documents.keys()]
                .filter((candidate) => candidate.startsWith(path + "/"))
                .map((candidate) => candidate.slice(path.length + 1).split("/")[0]),
        ),
    ].sort();
const stat = (path) =>
    documents.has(path)
        ? { isDirectory: false, isFile: true, isSymbolicLink: false }
        : directoryNames(path).length > 0
          ? { isDirectory: true, isFile: false, isSymbolicLink: false }
          : null;
const sortedCompute = {
    cwd: "/source",
    fs: {
        exists: async (_, path) => path === "/source/.git",
        lstat: async (_, path) => stat(path),
        lstatMany: async (_, paths) => paths.map(stat),
        stat: async (_, path) => stat(path),
        realpath: async (_, path) => path,
        readdirPage: async (_, path, { after, limit }) => {
            const names = directoryNames(path).filter(
                (name) => after === undefined || name > after,
            );
            return { entries: names.slice(0, limit), hasMore: names.length > limit };
        },
        readFileBuffer: async (_, path) => {
            if (!documents.has(path)) throw new Error("missing");
            return Buffer.from(documents.get(path));
        },
    },
};
const sortedModule = new SkillsModule({
    resolve: async () => sortedCompute,
    fileSystemIdentity: () => "source-filesystem",
    permissionsForContext: () => ({ mode: "full_access" }),
});
const ctx = { span: async (_, work) => work(ctx) };
const sortResult = await sortedModule.list(ctx, "source-agent");
const invocationMode = {
    providerId: "codex",
    modelId: "openai/gpt-5.6-sol",
    effort: "medium",
    serviceTier: null,
    permissionMode: "auto",
};
const invocationGoldens = [];
sortedModule.beforeStart(ctx, {
    send: async (_, agentId, message, options) => {
        options.id = "source-generated";
        options.metadata.skillInvocation.messageId = "source-generated";
        invocationGoldens.push({ agentId, message, options });
    },
    updateMetadata: async (_, agentId, metadata) => {
        invocationGoldens.at(-1).updatedMetadata = metadata;
    },
});
for (const argumentsValue of [undefined, "", "inspect authentication"])
    await sortedModule.invokeSlashCommand(ctx, "source-agent", "a", {
        mode: invocationMode,
        ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
        mutationId: "source-mutation",
    });
writeFileSync(
    new URL("source_goldens.json", import.meta.url),
    `${JSON.stringify({ entries, pages, instructions: helpers.formatInstructions(entries), emptyList: helpers.renderList({ skills: [] }), list: helpers.renderList(pages[0].result), invocation, invokedInstructions: helpers.formatInvokedSkill(invocation), parserCases, sortNames, sortedNames: sortResult.skills.map((entry) => entry.name), slashCommands: await sortedModule.slashCommands(ctx, "source-agent"), invocationGoldens }, null, 2)}\n`,
);
