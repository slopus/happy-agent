import { createRequire } from "node:module";
import { sourcePrivateSchema } from "../../../scripts/source-private-schema.mjs";
import { writeNativeCapture } from "../../../scripts/write-native-capture.mjs";
import { historyRunStateSchema } from "../../../../happy-agent-modules/sources/history/HistoryRun.ts";
import {
    requestProfileCodec,
    requestProfilesForAgent,
} from "../../../../happy-agent-modules/sources/impl/requestProfile.ts";
import { CompactionsModule } from "../../../../happy-agent-modules/sources/compactions/CompactionsModule.ts";

const require = createRequire(
    new URL("../../../../happy-agent-modules/package.json", import.meta.url),
);
const { agentSchema, agentProfileCatalogSchema, slashCommandCatalogSchema } = await import(
    require.resolve("@slopus/happy-agent-client")
);
const { agentArchivedAtSchema, numericMetadata } = await sourcePrivateSchema(
    new URL(
        "../../../../happy-agent-modules/sources/api/ApiResourceProjection.ts",
        import.meta.url,
    ),
    ["agentArchivedAtSchema", "numericMetadata"],
);

export const agentViewSchemas = {
    ownerPublicAgent: agentSchema,
    ownerPublicAgentProfiles: agentProfileCatalogSchema,
    ownerPublicAgentSlashCommands: slashCommandCatalogSchema,
    ownerAgentNumericMetadata: agentArchivedAtSchema,
    ownerAgentRequestProfile: requestProfileCodec,
    ownerHistoryRunState: historyRunStateSchema,
};

writeNativeCapture(
    new URL("source_goldens.json", import.meta.url),
    `${JSON.stringify(
        {
            profiles: requestProfilesForAgent("agentfixture"),
            compactionCommands: await CompactionsModule.prototype.slashCommands({}, "agentfixture"),
            numericMetadata: [
                null,
                false,
                true,
                "0",
                {},
                [],
                -1,
                0,
                1,
                1.5,
                Number.MAX_SAFE_INTEGER,
                Number.MAX_SAFE_INTEGER + 1,
            ].map((value) => ({ value, expected: numericMetadata(value) ?? null })),
        },
        null,
        2,
    )}\n`,
);
