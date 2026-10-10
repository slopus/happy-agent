// Build-time capture from the shipped module; native execution never loads JavaScript.
import * as original from "../../../../happy-agent-modules/sources/userInput/UserInputRequest.ts";
import { userInputEventSchema } from "../../../../happy-agent-modules/sources/userInput/UserInputEvent.ts";
import { requestUserInputTool } from "../../../../happy-agent-modules/sources/userInput/tools/request_user_input.ts";
import { readUserInputTool } from "../../../../happy-agent-modules/sources/userInput/tools/read_user_input.ts";
import { cancelAskTool } from "../../../../happy-agent-modules/sources/userInput/tools/cancel_ask.ts";
import {
    formatUserInputForModel,
    formatUserInputDetailPageForModel,
    formatUserInputPageForModel,
} from "../../../../happy-agent-modules/sources/userInput/UserInputModule.ts";
import { writeNativeCapture as writeFileSync } from "../../../scripts/write-native-capture.mjs";
export const userInputTools = [
    requestUserInputTool(undefined, "source-agent"),
    readUserInputTool(undefined, "source-agent"),
    cancelAskTool(undefined, "source-agent"),
];
export const userInputSchemas = {
    ownerUserInputAgentId: original.userInputAgentIdSchema,
    ownerUserInputRequestId: original.userInputRequestIdSchema,
    ownerUserInputAsk: original.userInputAskInputSchema,
    ownerUserInputWait: original.userInputWaitInputSchema,
    ownerUserInputRequest: original.userInputRequestSchema,
    ownerUserInputAnswer: original.userInputAnswerInputSchema,
    ownerUserInputCancel: original.userInputCancelInputSchema,
    ownerUserInputComplete: original.userInputCompleteInputSchema,
    ownerUserInputListQuery: original.userInputListQuerySchema,
    ownerUserInputPage: original.userInputPageSchema,
    ownerUserInputDetailQuery: original.userInputDetailQuerySchema,
    ownerUserInputDetailPage: original.userInputDetailPageSchema,
    ownerUserInputPresence: original.userInputPresenceStateSchema,
    ownerUserInputEvent: userInputEventSchema,
};
for (const tool of userInputTools) {
    userInputSchemas[`ownerTool_${tool.name}`] = tool.parameters;
}
const base = {
    id: "source-request",
    askingAgentId: "source-agent",
    question: "Choose a scope",
    header: "Release scope",
    context: "Shared context 😀",
    options: {
        choices: [
            { label: "Agent", description: "Ship Agent" },
            { label: "Terminal", description: "Ship Terminal" },
        ],
        multiSelect: false,
    },
    createdAt: 1000,
    updatedAt: 1000,
};
const requests = [
    { ...base, status: "pending" },
    {
        ...base,
        status: "answered",
        answer: { text: "Agent please", selectedOptions: ["Agent"] },
        answeredAt: 1200,
        updatedAt: 1200,
    },
    {
        ...base,
        status: "cancelled",
        reason: "No longer needed",
        cancelledAt: 1200,
        updatedAt: 1200,
    },
    {
        ...base,
        status: "away",
        presence: {
            title: "Away",
            emoji: "💤",
            prompt: "Continue carefully.",
            answerWaitMs: 0,
            changesAt: 600000,
        },
        waitedMs: 0,
        completedAt: 1200,
        updatedAt: 1200,
    },
    {
        ...base,
        status: "timed_out",
        deadlineAt: 121000,
        timedOutAt: 121000,
        updatedAt: 121000,
        waitedMs: 120000,
    },
];
const formatGoldens = requests.map((request) => ({
    request,
    text: formatUserInputForModel(request),
    short: formatUserInputForModel(request, 20),
}));
const page = { requests, cursor: "0", limit: 50, nextCursor: "5" };
const detail = {
    request: requests[1],
    detail: "Questions:\nChoose a scope\n\nContext:\nShared context 😀",
    cursor: 0,
    detailTotal: 60,
    nextCursor: "60",
};
writeFileSync(
    new URL("format_goldens.json", import.meta.url),
    `${JSON.stringify({ requests: formatGoldens, page, pageText: formatUserInputPageForModel(page), detail, detailText: formatUserInputDetailPageForModel(detail) }, null, 2)}\n`,
);
