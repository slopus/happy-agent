import { createId } from "@paralleldrive/cuid2";
import { agentPermissionMode, defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import type { ArtifactsModule } from "../../artifacts/index.js";
import type { SecretsModule } from "../../secrets/index.js";
import { secretRequestDocument, secretRequestSchema } from "../impl/secretRequestDocument.js";

const requestSecretResultSchema = Type.Object(
    {
        artifactId: Type.String(),
        title: Type.String(),
        secretId: Type.Union([Type.String(), Type.Null()]),
        exists: Type.Boolean(),
        variables: Type.Array(Type.String()),
        presentation: Type.Object({
            type: Type.Literal("artifact"),
            artifactId: Type.String(),
            version: Type.Integer(),
            artifactType: Type.Literal("gen_ui"),
            title: Type.String(),
            shows: Type.Literal("latest"),
        }),
    },
    { additionalProperties: false },
);

type RequestSecretInput = Static<typeof secretRequestSchema>;

/** Ask the person for a Happy Agent secret through a Gen UI card that prefills the secret form. */
export function requestSecretTool(
    artifacts: ArtifactsModule,
    secrets: SecretsModule,
    agentId: string,
) {
    return defineAgentTool({
        name: "request_secret",
        capabilities: [
            "Ask the user for a credential through a prefilled secret form, without seeing its values.",
        ],
        searchKeywords: ["ask for api key", "request credential", "add secret", "need token"],
        description: [
            "Ask the user for a credential, such as an API key or token, without ever seeing it. Shows the user a card in this chat that explains why you need it and lists the environment variables; its button opens the secret form prefilled with id, description, and variables. The user types the values and may change everything else first.",
            "Returns at once. Do not wait for the secret: when the user saves it, you receive a message naming the secret and its variables, never the values, and the secret is attached to you, ready for a shell command's secrets argument. Until then, carry on with work that does not need it, or end your turn.",
            "Never ask for a key, token, or password in chat, and never put one in a tool argument. Pass the id of an existing secret to let the user change it, such as to rotate a key.",
        ].join("\n\n"),
        parameters: secretRequestSchema,
        returnType: requestSecretResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: RequestSecretInput, call) => {
            if (agentPermissionMode(ctx) === "read_only") {
                throw new Error("Read only mode cannot show a secret request.");
            }
            const seen = new Set<string>();
            for (const variable of input.variables) {
                const key = variable.name.toUpperCase();
                if (seen.has(key)) {
                    throw new Error(`The variable ${variable.name} is listed twice.`);
                }
                seen.add(key);
            }
            const exists =
                input.id !== undefined &&
                (await secrets.catalogSecret(ctx, input.id)) !== undefined;
            const id = await call.kv.getOrCreate(ctx, "artifactId", () => createId());
            let artifact = await artifacts.get(ctx, id);
            if (artifact === undefined) {
                const actor = await artifacts.actorFor(ctx, agentId);
                ({ artifact } = await artifacts.create(ctx, {
                    id,
                    type: "gen_ui",
                    title: input.title,
                    files: await artifacts.stageFiles(ctx, [
                        { path: "index.genui.json", text: secretRequestDocument(input, exists) },
                    ]),
                    author: actor.author,
                    source: actor.source,
                }));
            }
            return {
                artifactId: artifact.id,
                title: artifact.title,
                secretId: input.id ?? null,
                exists,
                variables: input.variables.map((variable) => variable.name),
                presentation: {
                    type: "artifact" as const,
                    artifactId: artifact.id,
                    version: artifact.latestVersion,
                    artifactType: "gen_ui" as const,
                    title: artifact.title,
                    shows: "latest" as const,
                },
            };
        },
        toLLM: (result) => [
            {
                type: "text" as const,
                text: [
                    `Asked the user to ${result.exists ? "change" : "add"} ${result.secretId === null ? "a secret" : `the secret ${JSON.stringify(result.secretId)}`} with ${result.variables.join(", ")}, in [${result.title}](happy://artifacts/${result.artifactId}).`,
                    "The user sees the card in this chat. You will get a message when they save it; do not wait for it.",
                ].join(" "),
            },
        ],
    });
}
