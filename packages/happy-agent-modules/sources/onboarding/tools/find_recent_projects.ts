import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { OnboardingModule } from "../OnboardingModule.js";

/**
 * The Chief of Staff looks at the person's recent work during onboarding. Happy reads it itself,
 * read-only and within a couple of seconds, so onboarding never runs a shell for it or asks to
 * leave the sandbox: Claude Code's and Codex's session history for the folders they worked in,
 * then each folder's Git metadata through the read-only Git scanner.
 */
export function findRecentProjectsTool(module: OnboardingModule) {
    return defineAgentTool({
        name: "find_recent_projects",
        capabilities: ["Find the person's recent projects and their Git activity, read-only."],
        defer: false,
        description: [
            "Find the projects the person worked on recently on this computer, read-only, after they agreed to it in this chat. Happy reads the folders Claude Code and Codex worked in, newest first, at most five, and for each its Git metadata: the branch, uncommitted changes, the last commits, the most recently committed branches, and recent commits that touched TODO or FIXME lines. It returns names, paths and dates, never file contents, and changes nothing.",
            "Give folder to read one folder the person named instead of the history.",
            "With no history it says so at once. Never read assistant history or run Git yourself for this.",
        ].join("\n\n"),
        parameters: Type.Object(
            {
                folder: Type.Optional(
                    Type.String({
                        minLength: 1,
                        maxLength: 4_096,
                        description:
                            "A folder the person named, as an absolute path or starting with ~/. Leave it out to read their recent history.",
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: Type.String(),
        durable: false,
        // Happy reads fixed, bounded metadata and returns no file contents; nothing to review.
        shouldReviewInAutoMode: () => false,
        execute: async (_ctx, args) => await module.findRecentProjects(args.folder),
        toLLM: (text) => [{ type: "text", text }],
    });
}
