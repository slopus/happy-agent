import { defineAgentTool } from "@slopus/happy-agent-base";
import { formatHappyMarkdownLink } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";

import type { TeammatesModule } from "../TeammatesModule.js";

const teammateSchema = Type.Object(
    {
        id: Type.String(),
        name: Type.String(),
        role: Type.Union([Type.String(), Type.Null()]),
        follows: Type.Union([Type.String(), Type.Null()]),
    },
    { additionalProperties: false },
);

/** The team directory: who is on the team, what they do, and what they follow. */
export function listTeammatesTool(teammates: TeammatesModule) {
    return defineAgentTool({
        name: "list_teammates",
        defer: true,
        capabilities: ["See who is on the team and loop a teammate into this task."],
        searchKeywords: ["teammates", "team directory", "who follows", "loop in"],
        description:
            "List the people on the team with their user ID, name, role, and what they follow, so you can tell whom this work concerns. Guests of exported bots are not listed.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: Type.Array(teammateSchema),
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => (await teammates.list(ctx)).map((person) => ({ ...person })),
        toLLM: (list) => [
            {
                type: "text",
                text:
                    list.length === 0
                        ? "Nobody else is on the team yet."
                        : list
                              .map(
                                  (person) =>
                                      `- ${person.name} — user ID ${person.id}, role: ${person.role ?? "not set"}, follows: ${person.follows ?? "not set"}, mention as ${formatHappyMarkdownLink({ type: "reference", reference: { kind: "user", id: person.id } }, person.name)}`,
                              )
                              .join("\n"),
            },
        ],
    });
}
