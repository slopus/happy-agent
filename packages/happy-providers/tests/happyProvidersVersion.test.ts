import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

import { HAPPY_PROVIDERS_VERSION } from "@/index.js";

it("exports the version the package is published as", async () => {
    const packageJson = JSON.parse(
        await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(HAPPY_PROVIDERS_VERSION).toBe(packageJson.version);
});
