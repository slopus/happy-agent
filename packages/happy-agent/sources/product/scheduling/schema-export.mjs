import * as original from "../../../../happy-agent-modules/sources/scheduling/Scheduling.ts";
import { schedulingEventSchema } from "../../../../happy-agent-modules/sources/scheduling/SchedulingEvent.ts";
import { waitTool } from "../../../../happy-agent-modules/sources/scheduling/tools/wait.ts";
import { waitUntilTool } from "../../../../happy-agent-modules/sources/scheduling/tools/wait_until.ts";
import { scheduleMessageTool } from "../../../../happy-agent-modules/sources/scheduling/tools/schedule_message.ts";
import { listScheduledMessagesTool } from "../../../../happy-agent-modules/sources/scheduling/tools/list_scheduled_messages.ts";
import { cancelScheduledMessageTool } from "../../../../happy-agent-modules/sources/scheduling/tools/cancel_scheduled_message.ts";
import {
    durationMilliseconds,
    instantMilliseconds,
    humanDuration,
} from "../../../../happy-agent-modules/sources/scheduling/schedulingTime.ts";
import {
    waitText,
    scheduleText,
    cancellationText,
    schedulePageText,
} from "../../../../happy-agent-modules/sources/scheduling/schedulingFormat.ts";
import { createRequire } from "node:module";
import { writeNativeCapture as writeFileSync } from "../../../scripts/write-native-capture.mjs";
const require = createRequire(
    new URL("../../../../happy-agent-modules/package.json", import.meta.url),
);
const { Type } = require("@sinclair/typebox");
export const schedulingTools = [
    waitTool(undefined, "source-agent"),
    waitUntilTool(undefined, "source-agent"),
    scheduleMessageTool(undefined, "source-agent"),
    listScheduledMessagesTool(undefined, "source-agent"),
    cancelScheduledMessageTool(undefined, "source-agent"),
];
export const schedulingSchemas = {
    ownerSchedulingId: original.schedulingIdSchema,
    ownerSchedulingDuration: original.schedulingDurationSchema,
    ownerSchedulingInstant: original.schedulingInstantSchema,
    ownerSchedulingWaitInput: original.schedulingWaitInputSchema,
    ownerSchedulingUntilInput: original.schedulingWaitUntilInputSchema,
    ownerSchedulingWaitRecord: original.schedulingWaitRecordSchema,
    ownerSchedulingWaitResult: original.schedulingWaitResultSchema,
    ownerSchedulingSchedule: original.schedulingScheduledMessageSchema,
    ownerSchedulingInput: original.schedulingScheduleInputSchema,
    ownerSchedulingCancel: original.schedulingCancelInputSchema,
    ownerSchedulingPageQuery: original.schedulingSchedulePageQuerySchema,
    ownerSchedulingPage: original.schedulingSchedulePageSchema,
    ownerSchedulingEvent: schedulingEventSchema,
    ownerSchedulingDelivery: Type.Object(
        { scheduleId: original.schedulingMessageIdSchema },
        { additionalProperties: false },
    ),
    ownerSchedulingDeliveryResult: Type.Null(),
};
for (const tool of schedulingTools) {
    schedulingSchemas[`ownerTool_${tool.name}`] = tool.parameters;
}
const durations = [
    "90 seconds",
    "1h 30m",
    "1 hour, 30 minutes",
    "0.001 seconds",
    "0 seconds",
    { seconds: 1.25, minutes: 2 },
    { days: 1 },
].map((input) => ({ input, milliseconds: durationMilliseconds(input) }));
const instants = [
    "2026-03-08T07:00:00Z",
    "Mon, 05 Jan 2026 00:00:00 +0000",
    1767571200,
    "1767571200",
    1767571200000,
    "-1.5",
].map((input) => ({ input, milliseconds: instantMilliseconds(input) }));
const human = [0, 1, 999, 1000, 1500, 60000, 90000, 3600000, 5400000, 86400000].map((input) => ({
    input,
    text: humanDuration(input),
}));
const wait = {
    waitId: "sourcewait",
    agentId: "sourceagent",
    outcome: "elapsed",
    kind: "wait",
    dueAt: 1767571200000,
    startedAt: 1767571198500,
    endedAt: 1767571200000,
    elapsedMs: 1500,
};
const schedule = {
    id: "sourceschedule",
    senderAgentId: "sourceagent",
    targetAgentId: "targetagent",
    message: "Scheduled text",
    dueAt: 1767571200000,
    status: "pending",
    createdAt: 1767571198500,
    updatedAt: 1767571198500,
};
const page = {
    schedules: [
        schedule,
        { ...schedule, id: "secondmessage", targetAgentId: "sourceagent", status: "cancelled" },
    ],
    limit: 50,
    nextCursor: "2",
};
writeFileSync(
    new URL("time_goldens.json", import.meta.url),
    `${JSON.stringify({ durations, instants, human, wait, waitText: waitText(wait), schedule, scheduleText: scheduleText(schedule), cancellationText: cancellationText(schedule), page, pageText: schedulePageText(page, 8000) }, null, 2)}\n`,
);
