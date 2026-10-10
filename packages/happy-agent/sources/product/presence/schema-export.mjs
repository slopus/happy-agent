import * as original from "../../../../happy-agent-modules/sources/presence/PresenceState.ts";
import {
    presenceScheduleInputSchema,
    presenceScheduleSchema,
} from "../../../../happy-agent-modules/sources/presence/PresenceSchedule.ts";
import { presenceEventSchema } from "../../../../happy-agent-modules/sources/presence/PresenceEvent.ts";
import { BUILT_IN_PRESENCES } from "../../../../happy-agent-modules/sources/presence/PresenceCatalog.ts";
import { getPresenceTool } from "../../../../happy-agent-modules/sources/presence/tools/get_presence.ts";
import { listPresenceTool } from "../../../../happy-agent-modules/sources/presence/tools/list_presence.ts";
import { setPresenceTool } from "../../../../happy-agent-modules/sources/presence/tools/set_presence.ts";
import { sourcePrivateSchema } from "../../../scripts/source-private-schema.mjs";
import { writeNativeCapture as writeFileSync } from "../../../scripts/write-native-capture.mjs";
const privateCalendar = await sourcePrivateSchema(
    new URL(
        "../../../../happy-agent-modules/sources/presence/PresenceDatabase.ts",
        import.meta.url,
    ),
    ["effectiveSchedule"],
);
const calendarCases = [
    ["America/New_York", "2026-03-08T06:59:00Z", [0], "01:55", "02:05"],
    ["America/New_York", "2026-03-08T07:00:00Z", [0], "01:55", "02:05"],
    ["America/New_York", "2026-11-01T05:30:00Z", [0], "01:15", "01:45"],
    ["America/New_York", "2026-11-01T06:30:00Z", [0], "01:15", "01:45"],
    ["Asia/Tokyo", "2026-01-04T15:30:00Z", [1], "23:00", "01:00"],
    ["Asia/Tokyo", "2026-01-04T14:30:00Z", [1], "23:00", "01:00"],
    ["Asia/Kathmandu", "2026-01-05T18:15:00Z", [2], "00:00", "01:00"],
    ["UTC", "2026-01-05T00:00:00Z", [1], "00:00", "00:00"],
];
const calendarGoldens = [];
for (const [timeZone, time, days, startTime, endTime] of calendarCases) {
    const schedule = {
        id: "source-window",
        timeZone,
        days,
        startTime,
        endTime,
        presence: { status: "away" },
    };
    const at = Date.parse(time);
    const effective = await privateCalendar.effectiveSchedule(undefined, at, async () => [
        schedule,
    ]);
    calendarGoldens.push({ schedule, at, active: effective !== undefined });
}
writeFileSync(
    new URL("calendar_goldens.json", import.meta.url),
    `${JSON.stringify(calendarGoldens, null, 2)}\n`,
);
export const presenceTools = [
    getPresenceTool(undefined),
    listPresenceTool(undefined),
    setPresenceTool(undefined),
];
export const presenceCatalog = BUILT_IN_PRESENCES;
export const presenceSchemas = {
    ownerPresenceId: original.presenceIdSchema,
    ownerPresenceDefinition: original.presenceDefinitionSchema,
    ownerPresenceCatalog: original.presenceCatalogInputSchema,
    ownerPresenceState: original.presenceStateSchema,
    ownerPresenceStored: original.presenceStoredStateSchema,
    ownerPresenceMutation: original.presenceMutationInputSchema,
    ownerPresenceTemporary: original.temporaryPresenceInputSchema,
    ownerPresenceToolInput: original.presenceToolInputSchema,
    ownerPresenceUserInput: original.presenceUserInputStateSchema,
    ownerPresenceScheduleInput: presenceScheduleInputSchema,
    ownerPresenceSchedule: presenceScheduleSchema,
    ownerPresenceEvent: presenceEventSchema,
};
for (const tool of presenceTools) {
    presenceSchemas[`ownerTool_${tool.name}`] = tool.parameters;
}
