import { deunicode } from "deunicode";
import stem from "wink-porter2-stemmer";

import type { SessionTool } from "@/core/SessionTool.js";
import { toolSearchStopWords } from "@/vendors/codex/impl/toolSearchStopWords.js";

const segmenter = new Intl.Segmenter("en", { granularity: "word" });

/** Ranks deferred Codex tools with the same English BM25 shape as the native client. */
export function searchCodexTools<T extends SessionTool>(
    tools: readonly T[],
    query: string,
    limit = 8,
): readonly T[] {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length === 0) throw new Error("query must not be empty");
    if (limit === 0) throw new Error("limit must be greater than zero");
    if (!Number.isSafeInteger(limit) || limit < 0)
        throw new Error("limit must be a positive integer");
    if (tools.length === 0) return [];

    const tokenize = (text: string): string[] =>
        Array.from(
            segmenter.segment(
                deunicode(text)
                    .normalize("NFKD")
                    .replace(/\p{Mark}/gu, "")
                    .toLowerCase(),
            ),
        )
            .filter((segment) => segment.isWordLike)
            .map((segment) => segment.segment)
            .filter((token) => !toolSearchStopWords.has(token))
            .map(stem);
    const documents = tools.map((tool) => {
        const parts: string[] = [];
        const add = (value: unknown): void => {
            if (typeof value === "string" && value.trim().length > 0) parts.push(value.trim());
        };
        add(tool.namespace);
        add(tool.namespaceDescription);
        add(tool.name);
        add(tool.name.replaceAll("_", " "));
        add(tool.description);
        for (const keyword of tool.searchKeywords ?? []) add(keyword);

        const pending: unknown[] = [tool.parameters];
        const seen = new Set<object>();
        while (pending.length > 0) {
            const schema = pending.pop();
            if (typeof schema !== "object" || schema === null || seen.has(schema)) continue;
            seen.add(schema);
            if (Array.isArray(schema)) {
                pending.push(...schema);
                continue;
            }
            const record = schema as Record<string, unknown>;
            add(record.description);
            if (
                typeof record.properties === "object" &&
                record.properties !== null &&
                !Array.isArray(record.properties)
            ) {
                for (const [name, property] of Object.entries(record.properties)) {
                    add(name);
                    pending.push(property);
                }
            }
            if (record.items !== undefined) pending.push(record.items);
            if (Array.isArray(record.anyOf)) pending.push(...record.anyOf);
            if (Array.isArray(record.oneOf)) pending.push(...record.oneOf);
            if (Array.isArray(record.allOf)) pending.push(...record.allOf);
        }
        return tokenize(parts.join(" "));
    });
    const averageDocumentLength =
        documents.reduce((total, tokens) => total + tokens.length, 0) / documents.length;
    const documentFrequency = new Map<string, number>();
    for (const tokens of documents) {
        for (const token of new Set(tokens)) {
            documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
        }
    }
    const queryTokens = tokenize(normalizedQuery);
    const scored = documents.flatMap((tokens, index) => {
        const termFrequency = new Map<string, number>();
        for (const token of tokens) {
            termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
        }
        let score = 0;
        for (const token of queryTokens) {
            const frequency = termFrequency.get(token);
            if (frequency === undefined) continue;
            const containingDocuments = documentFrequency.get(token) ?? 0;
            const inverseDocumentFrequency = Math.log(
                1 + (tools.length - containingDocuments + 0.5) / (containingDocuments + 0.5),
            );
            const normalizedFrequency =
                (frequency * 2.2) /
                (frequency +
                    1.2 *
                        (1 -
                            0.75 +
                            0.75 *
                                (tokens.length /
                                    (averageDocumentLength === 0 ? 256 : averageDocumentLength))));
            score += inverseDocumentFrequency * normalizedFrequency;
        }
        return score === 0 ? [] : [{ index, score }];
    });
    scored.sort((left, right) => right.score - left.score || left.index - right.index);
    return scored.slice(0, limit).map(({ index }) => tools[index]!);
}
