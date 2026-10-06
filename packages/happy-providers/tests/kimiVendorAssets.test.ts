import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { kimi_tools } from "@/vendors/kimi/tools/index.js";

// Independently rendered from MoonshotAI/kimi-code commit
// 21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3, using the settings documented
// in vendors/kimi/tools/README.md. Parameters come from toInputJsonSchema;
// descriptions retain all whitespace, including template trailing newlines.
const nativeDescriptors = [
    [
        "Bash",
        "5921b301a3f957fe58a10c3352e2a484142653196ebe8ce9e7cec54c125c84a4",
        "40df15084bb5418bc3949d338bfa379f0cb99543b0568f5615d1cc68d974a2a6",
    ],
    [
        "Read",
        "1905e2dd0037682ed9265e25679ada434d508d9ff24248b30562dc33814a6313",
        "c2e9708abf92381750b5897a8d9c44fe6b271036ef6d7fed11e6280e35ca379d",
    ],
    [
        "Write",
        "dd3b115d34fd5c5398391d40fed9b1cc3a46148be2a83fa2a2bfef0f21c43f79",
        "3bcf29931e091de66b93d820e1ace633ecd343573bf056e5f206fe69edd8b845",
    ],
    [
        "Edit",
        "e8aa95843765a6b6f9fd78442406b93b0f1db1fed9944524cdaf2706cf0edb18",
        "6c654c48a13fb76ebdddea38d4fbf4b6a99c0d371124edc73c4cf64e3300d03e",
    ],
    [
        "Glob",
        "58c6b1fd94dbd9c77f037681cc3996119be4fddc89038d68c0b3b5d14f1331ab",
        "e220e0687f6342cdc5b2a571734e9535b9314ff76ecd560f3a6e906c06a5a9ea",
    ],
    [
        "Grep",
        "4fe38d97bb1e3a916f75ff9597e21a73c6a91d697a0e12815745ec590214a018",
        "27e53268799992e932d8cbd9b975b4d00e3db3229cb0dad4381773e8d4af910c",
    ],
    [
        "ReadMediaFile",
        "527aca5b84754ec49854ad8f9a9c78a5f7a12676623cfb1e59603f4513118847",
        "709866b396647ed6bd40e7c4be54bf4449396a163df3c1c9288b108221d1444c",
    ],
] as const;

function orderedJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(orderedJson);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, child]) => [key, orderedJson(child)]),
    );
}

function digest(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

describe("Kimi Code reconstruction assets", () => {
    it.each(nativeDescriptors)(
        "preserves the native %s descriptor",
        (name, descriptionHash, parametersHash) => {
            const tool = kimi_tools.find((candidate) => candidate.name === name)!;
            expect(digest(tool.description!)).toBe(descriptionHash);
            expect(digest(JSON.stringify(orderedJson(tool.parameters)))).toBe(parametersHash);
        },
    );

    it("keeps the ordinary reference subset explicit and internal", async () => {
        expect(kimi_tools.map((tool) => tool.name)).toEqual(
            nativeDescriptors.map(([name]) => name),
        );
        const index = await import("@/index.js");
        expect(index).not.toHaveProperty("kimi_tools");
        for (const name of ["bash", "read", "write", "edit", "glob", "grep", "read_media_file"]) {
            expect(index).not.toHaveProperty(`kimi_${name}_tool`);
        }
    });
});
