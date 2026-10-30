import { defineAgentTool } from "@slopus/happy-agent-base";

import { switchSubtaskModelInputSchema, switchSubtaskModelResultSchema } from "../Subtask.js";
import type { CollaborationCreator } from "../../collaboration/index.js";
import type { SubtasksModule } from "../SubtasksModule.js";

/** `creator` is the coordinator, whose provider and harness resolve the choice as for creation. */
export function switchSubtaskModelTool(
    subtasks: SubtasksModule,
    actingAgentId: string,
    creator: CollaborationCreator,
) {
    return defineAgentTool({
        name: "switch_subtask_model",
        defer: true,
        capabilities: ["Switch a direct subtask to another model, effort, or provider."],
        searchKeywords: [
            "switch subtask model",
            "change subtask provider",
            "subtask effort",
            "change subtask model",
        ],
        description: [
            "Switch one of your direct subtasks to another model, effort, provider, or service tier. Only its coordinating bot, task, or subtask may do this.",
            "Choose from the same options as create_subtask, listed by agent_options; harness and provider default to yours when they serve the model.",
            "This sends the subtask a short message from you carrying the new model, exactly as a person switches models from its conversation. A working subtask switches after its current step and carries on; an idle one wakes on the new model and replies briefly. A model that cannot read the earlier conversation starts fresh with a handoff notice.",
            "Keep a subtask on one model unless its model is failing or wrong for the work. To give it new instructions as well, use send_agent_message with the same model fields instead.",
        ].join("\n\n"),
        parameters: switchSubtaskModelInputSchema,
        returnType: switchSubtaskModelResultSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input, call) =>
            await subtasks.switchModel(ctx, actingAgentId, input, call.id, creator),
        toLLM: (result) => [
            {
                type: "text",
                text: `Switched subtask ${result.agentId} to ${result.modelName} (${result.model} via ${result.provider}) at ${result.effort} effort${result.serviceTier === undefined ? "" : ` with ${result.serviceTier} service`}. It changes model when it reads your message; anything it says arrives as a message.`,
            },
        ],
    });
}
