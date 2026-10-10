import { sourcePrivateSchema } from "../../../scripts/source-private-schema.mjs";
import { titleWorkspaceIdSchema } from "../../../../happy-agent-modules/sources/titles/Title.ts";
const original = await sourcePrivateSchema(
    new URL("../../../../happy-agent-modules/sources/titles/TitlesModule.ts", import.meta.url),
    ["titleUserMessageCountSchema", "generatedTitleRecordSchema"],
);
export const titleSchemas = {
    ownerTitleUserMessageCount: original.titleUserMessageCountSchema,
    ownerTitleGeneratedRecord: original.generatedTitleRecordSchema,
    ownerTitleWorkspaceId: titleWorkspaceIdSchema,
};
