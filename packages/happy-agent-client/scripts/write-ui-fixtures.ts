import { writeFile } from "node:fs/promises";

import { buildUiActionFixtures, buildUiSchemaFile } from "./uiFixtures.js";

/** Write `fixtures/ui/ui.schema.json` and `fixtures/ui/actions.fixtures.json`. */
async function main(): Promise<void> {
    const directory = new URL("../fixtures/ui/", import.meta.url);
    await writeFile(
        new URL("ui.schema.json", directory),
        `${JSON.stringify(buildUiSchemaFile(), null, 4)}\n`,
    );
    await writeFile(
        new URL("actions.fixtures.json", directory),
        `${JSON.stringify(buildUiActionFixtures(), null, 4)}\n`,
    );
}

void main();
