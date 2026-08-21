import { Type } from "@sinclair/typebox";

export const githubRepositorySchema = Type.String({
    maxLength: 201,
    pattern: "^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,99})/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$",
});

export const githubGitRefSchema = Type.String({
    maxLength: 1024,
    minLength: 1,
    pattern: "^(?!/)(?!.*//)(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9._/-]*[A-Za-z0-9._-]$",
});

const catalogIdSchema = Type.String({
    maxLength: 64,
    minLength: 64,
    pattern: "^[a-f0-9]{64}$",
});
const revisionSchema = Type.String({
    maxLength: 40,
    minLength: 40,
    pattern: "^[a-f0-9]{40}$",
});
const pluginEntrySchema = Type.Object(
    {
        description: Type.String({ maxLength: 4096, minLength: 1 }),
        displayName: Type.String({ maxLength: 128, minLength: 1 }),
        name: Type.String({ maxLength: 128, minLength: 1 }),
        path: Type.String({ maxLength: 1024, minLength: 1 }),
        version: Type.String({ maxLength: 128, minLength: 1 }),
    },
    { additionalProperties: false },
);

export const githubPluginPackageSourceSchema = Type.Object(
    {
        catalogId: catalogIdSchema,
        plugin: pluginEntrySchema,
        ref: Type.Optional(githubGitRefSchema),
        repository: githubRepositorySchema,
        revision: revisionSchema,
        type: Type.Literal("github"),
    },
    { additionalProperties: false },
);

const githubPluginOfferSchema = Type.Object(
    {
        availability: Type.Union([
            Type.Literal("not-installed"),
            Type.Literal("update-available"),
            Type.Literal("downgrade-available"),
            Type.Literal("reinstall-available"),
        ]),
        description: pluginEntrySchema.properties.description,
        displayName: pluginEntrySchema.properties.displayName,
        name: pluginEntrySchema.properties.name,
        source: githubPluginPackageSourceSchema,
        version: pluginEntrySchema.properties.version,
    },
    { additionalProperties: false },
);

export const githubPluginCatalogSchema = Type.Object(
    {
        catalogId: catalogIdSchema,
        plugins: Type.Array(githubPluginOfferSchema, { maxItems: 1_000 }),
        ref: Type.Optional(githubGitRefSchema),
        repository: githubRepositorySchema,
        revision: revisionSchema,
    },
    { additionalProperties: false },
);
