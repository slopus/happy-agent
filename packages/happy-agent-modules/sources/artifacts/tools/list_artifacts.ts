import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { artifactRecordSchema, artifactTypeSchema, type ArtifactListQuery } from "../Artifact.js";
import type { ArtifactsModule } from "../ArtifactsModule.js";
import { artifactSourceId } from "../impl/artifactIdentities.js";
import { formatArtifactLine, formatArtifactSource } from "../impl/formatArtifact.js";
import { ARTIFACT_TOOL_CAPABILITY } from "./common.js";

/** The largest page `list_artifacts` returns, and its size when the caller asks for none. */
const MAX_TOOL_PAGE_SIZE = 50;

const listArtifactsToolInputSchema = Type.Object(
    {
        /** Every artifact, or only those made where this conversation works. */
        scope: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("here")])),
        type: Type.Optional(artifactTypeSchema),
        includeDeleted: Type.Optional(Type.Boolean()),
        cursor: Type.Optional(cuid2Schema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TOOL_PAGE_SIZE })),
    },
    { additionalProperties: false },
);
type ListArtifactsToolInput = Static<typeof listArtifactsToolInputSchema>;

const artifactToolPageSchema = Type.Object({
    artifacts: Type.Array(artifactRecordSchema),
    /** The place `scope: "here"` matched, in words. */
    here: Type.Optional(Type.String()),
    nextCursor: Type.Optional(cuid2Schema),
});
type ArtifactToolPage = Static<typeof artifactToolPageSchema>;

/** List a bounded page of the shared artifact catalog, newest first. */
export function listArtifactsTool(artifacts: ArtifactsModule, agentId: string) {
    return defineAgentTool({
        name: "list_artifacts",
        defer: true,
        capabilities: [ARTIFACT_TOOL_CAPABILITY],
        searchKeywords: [
            "list artifacts",
            "find artifact",
            "published reports",
            "artifact catalog",
        ],
        description:
            'List artifacts in this installation\'s shared catalog, newest first. Each line shows the artifact\'s ID, type, title, latest version, file count, last change, and where it was made. Omit scope or pass "all" for every artifact; pass "here" for only those made in the bot, task, project, or workspace you are working in. Filter by type if you like. Deleted artifacts are left out unless includeDeleted is true. Results are paged; pass nextCursor back as cursor to read on. Read one with read_artifact.',
        parameters: listArtifactsToolInputSchema,
        returnType: artifactToolPageSchema,
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx: Context, input: ListArtifactsToolInput): Promise<ArtifactToolPage> => {
            const query: ArtifactListQuery = {
                ...(input.type === undefined ? {} : { type: input.type }),
                ...(input.includeDeleted === undefined
                    ? {}
                    : { includeDeleted: input.includeDeleted }),
                ...(input.cursor === undefined ? {} : { after: input.cursor }),
                limit: input.limit ?? MAX_TOOL_PAGE_SIZE,
            };
            let here: string | undefined;
            if (input.scope === "here") {
                const { source } = await artifacts.actorFor(ctx, agentId);
                query.sourceKind = source.kind;
                query.sourceId = artifactSourceId(source);
                here = formatArtifactSource(source);
            }
            const page = await artifacts.list(ctx, query);
            return {
                artifacts: [...page.artifacts],
                ...(here === undefined ? {} : { here }),
                ...(page.nextAfter === undefined ? {} : { nextCursor: page.nextAfter }),
            };
        },
        toLLM: ({ artifacts: listed, here, nextCursor }) => [
            {
                type: "text",
                text:
                    listed.length === 0
                        ? here === undefined
                            ? "No artifacts found."
                            : `No artifacts found in ${here}.`
                        : [
                              ...(here === undefined ? [] : [`Artifacts made in ${here}:`]),
                              ...listed.map(formatArtifactLine),
                              ...(nextCursor === undefined
                                  ? []
                                  : [`More artifacts follow; pass cursor "${nextCursor}".`]),
                          ].join("\n"),
            },
        ],
    });
}
