import { createId } from "@paralleldrive/cuid2";
import { defineAgentTool, type AgentKV } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { OnboardingModule } from "../OnboardingModule.js";

/**
 * The Chief of Staff starts the person's first task as a new top-level task in their sidebar,
 * never as a subtask or agent of its own, so the work outlives onboarding and the person sees it
 * beside the Chief of Staff.
 */
export function startFirstTaskTool(module: OnboardingModule, agentId: string, kv: AgentKV) {
    return defineAgentTool({
        name: "start_first_task",
        capabilities: ["Start the person's first task as its own top-level task."],
        defer: false,
        description: [
            "Start the first task the person chose as a new top-level task: its own conversation in their sidebar, beside you. It is never your subtask or agent, so do not use create_subtask or create_agent for it. Call it once, after they picked a suggestion or named the work, and after its project is in Happy.",
            'name is the work in two to four words, such as "Finish login branch". text is the task in full, delivered as its first message: what to do, the project by name and path, and the evidence you found. The task opens its own subtask to check out the project and starts at once.',
            "Answers with the task's link; mention the task by that link.",
        ].join("\n\n"),
        parameters: Type.Object(
            {
                name: Type.String({
                    minLength: 1,
                    maxLength: 80,
                    description: "The work in two to four words.",
                }),
                text: Type.String({
                    minLength: 1,
                    maxLength: 20_000,
                    description:
                        "The task in full, with the project's name and path and the evidence.",
                }),
            },
            { additionalProperties: false },
        ),
        returnType: Type.String(),
        durable: true,
        shouldReviewInAutoMode: () => false,
        // A repeated call after an interruption finds the task it already started.
        execute: async (ctx, args, call) =>
            await module.startFirstTask(ctx, {
                id: await call.kv.getOrCreate(ctx, "taskId", () => createId()),
                agentId,
                kv,
                name: args.name,
                text: args.text,
            }),
        toLLM: (text) => [{ type: "text", text }],
    });
}
