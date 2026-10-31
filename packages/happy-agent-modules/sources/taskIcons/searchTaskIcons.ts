import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import catalog from "./assets/index.json" with { type: "json" };
import { rankBm25 } from "../utils/rankBm25.js";

const taskIconSchema = Type.Object(
    {
        slug: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 128 }),
        label: Type.String({ minLength: 1, maxLength: 256 }),
        description: Type.String({ minLength: 1, maxLength: 2_000 }),
        category: Type.String({ minLength: 1, maxLength: 128 }),
        aliases: Type.Array(Type.String({ minLength: 1, maxLength: 256 })),
        tags: Type.Array(Type.String({ minLength: 1, maxLength: 256 })),
        hash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        size: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
);

export const taskIconQuerySchema = Type.String({ minLength: 1, maxLength: 1_000 });
export const taskIconCandidateSchema = Type.Object(
    {
        slug: taskIconSchema.properties.slug,
        label: taskIconSchema.properties.label,
        description: taskIconSchema.properties.description,
        category: taskIconSchema.properties.category,
        score: Type.Number({ exclusiveMinimum: 0 }),
        hash: taskIconSchema.properties.hash,
    },
    { additionalProperties: false },
);
export type TaskIconCandidate = Static<typeof taskIconCandidateSchema>;

const icons = Value.Parse(Type.Array(taskIconSchema, { minItems: 1, maxItems: 10_000 }), catalog);
// Canonical slug order makes equally scored results independent of the artwork's sheet order.
icons.sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
const bySlug = new Map(icons.map((icon) => [icon.slug, icon]));
if (bySlug.size !== icons.length) throw new Error("Task icon catalog has duplicate slugs.");
const documents = icons.map((icon) =>
    technicalWords(
        [
            icon.slug,
            icon.label,
            icon.description,
            icon.category,
            ...icon.aliases,
            ...icon.tags,
        ].join("\n"),
    ),
);

/** The model chooses from at most ten lexical matches; an unknown query has no candidates. */
export function searchTaskIcons(query: string): TaskIconCandidate[] {
    if (!Value.Check(taskIconQuerySchema, query)) {
        throw new Error("Search for topic icons with between 1 and 1,000 characters.");
    }
    return rankBm25(documents, technicalWords(query))
        .slice(0, 10)
        .map(({ index, score }) => {
            const { slug, label, description, category, hash } = icons[index]!;
            return { slug, label, description, category, hash, score };
        });
}

/** Accept catalog entries and established legacy choices without changing the logical slug. */
export function assertTaskIconSlug(slug: string): void {
    if (!Value.Check(taskIconSchema.properties.slug, slug) || taskIconAsset(slug) === undefined) {
        throw new Error("Choose a task icon slug returned by search_task_icons.");
    }
}

/** Artwork metadata is resolved from the bundled catalog, never supplied by the caller. */
export function taskIconAsset(
    slug: string,
): { readonly slug: string; readonly hash: string; readonly size: number } | undefined {
    return bySlug.get(slug === "waveform" ? "audio" : slug);
}

/** Preserve punctuation that distinguishes language names before ordinary word segmentation. */
function technicalWords(text: string): string {
    return text
        .replace(/\bc\+\+(?=$|[^\p{L}\p{N}])/giu, " cpp ")
        .replace(/\bc#(?=$|[^\p{L}\p{N}])/giu, " csharp ")
        .replace(/\bf#(?=$|[^\p{L}\p{N}])/giu, " fsharp ");
}
