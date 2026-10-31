import { createId } from "@paralleldrive/cuid2";
import { agentPermissionMode, defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import type { ArtifactLive } from "@slopus/happy-agent-client";

import type { ComputeModule } from "../../compute/index.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import {
    ArtifactInputError,
    artifactTitleSchema,
    artifactTypeSchema,
    type ArtifactType,
} from "../Artifact.js";
import type { ArtifactsModule } from "../ArtifactsModule.js";
import { ARTIFACT_TYPE_RULES } from "../ArtifactTypes.js";
import { LIVE_ARTIFACT_FALLBACK, normalizeArtifactUrl } from "../impl/liveArtifact.js";
import {
    formatArtifactBackground,
    formatArtifactLink,
    formatArtifactSource,
    formatArtifactVersion,
} from "../impl/formatArtifact.js";
import {
    describeArtifactSources,
    shouldReviewArtifactSources,
    stageArtifactSources,
} from "../impl/stageArtifactSources.js";
import {
    ARTIFACT_FILES_GUIDANCE,
    ARTIFACT_PRESENTED_NOTICE,
    ARTIFACT_TOOL_CAPABILITY,
    artifactToolBackgroundSchema,
    artifactToolDisplaySchema,
    artifactToolResultSchema,
    artifactToolSourcesSchema,
    presentedArtifact,
} from "./common.js";

const createArtifactToolInputSchema = Type.Object(
    {
        type: artifactTypeSchema,
        title: artifactTitleSchema,
        display: Type.Optional(artifactToolDisplaySchema),
        background: Type.Optional(artifactToolBackgroundSchema),
        files: Type.Optional(artifactToolSourcesSchema),
        url: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 4096,
                description:
                    "A live http or https page instead of files; HTML only. localhost is your machine. Its network stays fixed for this artifact.",
            }),
        ),
    },
    { additionalProperties: false },
);
type CreateArtifactToolInput = Static<typeof createArtifactToolInputSchema>;

/**
 * Create an artifact and its first version, recorded as made by this agent where it works. The
 * model never chooses the ID.
 */
export function createArtifactTool(
    artifacts: ArtifactsModule,
    compute: ComputeModule,
    agentId: string,
) {
    // Permission descriptions are synchronous. Keep only this invocation's resolved target,
    // weakly keyed by the exact arguments Permissions passes through review and execution.
    const reviewed = new WeakMap<CreateArtifactToolInput, ArtifactLive>();
    return defineAgentTool({
        name: "create_artifact",
        defer: true,
        capabilities: [ARTIFACT_TOOL_CAPABILITY],
        searchKeywords: [
            "publish artifact",
            "share report",
            "html page",
            "markdown document",
            "inline visualization",
            "live url",
            "dev server",
            "image gallery",
            "video",
            "pdf",
        ],
        description: [
            "Create an artifact: a titled, versioned item in this installation's shared catalog, visible to everyone who uses it, whose files you then write with write_artifact_file and edit_artifact_file. It is recorded as made by you, in the bot, task, project, or workspace you are working in. The call gives you its ID.",
            'A markdown or html artifact starts with a short entry holding its title, so create it first and then write its files. An image, image series, video, or document needs its file from the start: pass it in files, such as { "fromPath": "out/chart.png" }; files copies any file on your machine in for the other types too. A copy keeps its own name unless you give it a path, so to publish a document you already wrote, copy it in as the entry: { "fromPath": "notes/plan.md", "path": "index.md" }.',
            ARTIFACT_FILES_GUIDANCE,
            "Change its title, background, or display later with update_artifact.",
            'For a running web page, use { type: "html", title, url, display? } without files. The URL is the content, never downloaded by the daemon. The client opens it through your network in a browser profile isolated to this artifact; cookies and storage are never shared with the workspace browser or other artifacts. Change the URL with update_artifact; its original network stays fixed and its fallback files cannot be edited.',
        ].join("\n\n"),
        parameters: createArtifactToolInputSchema,
        returnType: artifactToolResultSchema,
        durable: true,
        shouldReviewInAutoMode: async (input, ctx) => {
            if (input.url !== undefined) {
                reviewed.set(input, {
                    url: normalizeArtifactUrl(input.url),
                    networkId: await compute.networkId(ctx, agentId),
                });
                return true;
            }
            return await shouldReviewArtifactSources(ctx, compute, agentId, input.files);
        },
        shouldRunInFullAccessInAutoMode: ({ files, url }, ctx) =>
            url === undefined && shouldReviewArtifactSources(ctx, compute, agentId, files),
        describeAutoPermissionAction: (input) => {
            if (input.url === undefined)
                return `creating a new ${input.type} artifact titled ${quoteVisibleExact(input.title)} from ${describeArtifactSources(input.files)}. Access: local file read (outside-workspace or symlink targets require full access) and a write to this installation's shared artifact catalog`;
            const live = reviewed.get(input);
            if (live === undefined)
                throw new ArtifactInputError(
                    "The live artifact target has not been resolved for review.",
                );
            return `creating a live artifact at ${quoteVisibleExact(live.url)}, titled ${quoteVisibleExact(input.title)}. The user's client loads it through this agent's network ${quoteVisibleExact(live.networkId)}, running the page's scripts in an isolated artifact browser profile. ${artifacts.describeLiveNetwork(live.url)} Access: the shared artifact catalog and the recorded network; no Full access is granted`;
        },
        // The artifact's identity is minted once and remembered in this invocation's own store,
        // so a call repeated after an interruption finds the artifact it already made.
        execute: async (ctx, input: CreateArtifactToolInput, call) => {
            if (agentPermissionMode(ctx) === "read_only") {
                throw new ArtifactInputError("Read only mode cannot create artifacts.");
            }
            if (input.url !== undefined && (input.type !== "html" || input.files !== undefined)) {
                throw new ArtifactInputError(
                    "A live URL requires type html and cannot be combined with files.",
                );
            }
            const url = input.url === undefined ? undefined : normalizeArtifactUrl(input.url);
            const id = await call.kv.getOrCreate(ctx, "artifactId", () => createId());
            let artifact = await artifacts.get(ctx, id);
            if (artifact === undefined) {
                const live =
                    url === undefined
                        ? undefined
                        : { url, networkId: await compute.networkId(ctx, agentId) };
                if (live !== undefined && agentPermissionMode(ctx) === "auto") {
                    const target = reviewed.get(input);
                    if (target?.url !== live.url || target.networkId !== live.networkId) {
                        throw new ArtifactInputError(
                            "The live artifact's network changed or was not reviewed. Repeat the call for a new review.",
                        );
                    }
                }
                const files =
                    live === undefined
                        ? await stageArtifactSources(
                              ctx,
                              artifacts,
                              compute,
                              agentId,
                              input.type,
                              input.files ?? [],
                          )
                        : [
                              {
                                  path: "index.html",
                                  uploadId: (await artifacts.stageText(ctx, LIVE_ARTIFACT_FALLBACK))
                                      .id,
                              },
                          ];
                const entry = ARTIFACT_TYPE_RULES[input.type].entry;
                if (entry !== undefined && !files.some((file) => file.path === entry.path)) {
                    const text = seededEntry(input.type, input.title);
                    files.push({
                        path: entry.path,
                        uploadId: (await artifacts.stageText(ctx, text)).id,
                    });
                }
                const actor = await artifacts.actorFor(ctx, agentId);
                ({ artifact } = await artifacts.create(ctx, {
                    id,
                    type: input.type,
                    title: input.title,
                    files,
                    ...(live === undefined ? {} : { live }),
                    ...(input.background === undefined ? {} : { background: input.background }),
                    ...(input.display === undefined ? {} : { display: input.display }),
                    author: actor.author,
                    source: actor.source,
                }));
            }
            return presentedArtifact(artifact, "latest");
        },
        toLLM: (artifact) => [
            {
                type: "text",
                text: [
                    `Artifact created: ${JSON.stringify(artifact.title)} — id ${artifact.id}, ${artifact.type}, ${formatArtifactVersion(artifact)}, ${String(artifact.fileCount)} ${artifact.fileCount === 1 ? "file" : "files"}, opening ${JSON.stringify(artifact.entry.path)}${formatArtifactBackground(artifact.background)}${artifact.display === undefined ? "" : `, shown ${artifact.display}`}.`,
                    ...(artifact.source === undefined
                        ? []
                        : [`Made in ${formatArtifactSource(artifact.source)}.`]),
                    artifact.live === undefined
                        ? `Write and change its files with write_artifact_file and edit_artifact_file, starting with ${JSON.stringify(artifact.entry.path)}; each call makes its next version.`
                        : `Live content: ${JSON.stringify(artifact.live.url)}, through network ${JSON.stringify(artifact.live.networkId)}. Change its URL with update_artifact; its network stays fixed and its fallback file cannot be edited.`,
                    ARTIFACT_PRESENTED_NOTICE,
                    `Mention it in chat as ${formatArtifactLink(artifact.id, artifact.title)}.`,
                ].join(" "),
            },
        ],
    });
}

/** The first text of a markdown or html artifact's entry, holding its title. */
function seededEntry(type: ArtifactType, title: string): string {
    return type === "html"
        ? `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>${escapeHtml(title)}</title>\n</head>\n<body>\n</body>\n</html>\n`
        : `# ${title}\n`;
}

function escapeHtml(text: string): string {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
