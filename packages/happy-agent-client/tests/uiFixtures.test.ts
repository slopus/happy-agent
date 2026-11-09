import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { buildUiActionFixtures, buildUiSchemaFile } from "../scripts/uiFixtures.js";

const read = async (name: string): Promise<unknown> =>
    JSON.parse(await readFile(new URL(`../fixtures/ui/${name}`, import.meta.url), "utf8"));

describe("chat UI fixtures", () => {
    it("ui.schema.json is what the catalog generates", async () => {
        expect(await read("ui.schema.json")).toEqual(
            JSON.parse(JSON.stringify(buildUiSchemaFile())),
        );
    });

    it("actions.fixtures.json is what the functions compute", async () => {
        expect(await read("actions.fixtures.json")).toEqual(
            JSON.parse(JSON.stringify(buildUiActionFixtures())),
        );
    });
});
