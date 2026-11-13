import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const spec = fileURLToPath(new URL("../../docs/genui/", import.meta.url));

function json(path: string): unknown {
    return JSON.parse(readFileSync(join(spec, path), "utf8"));
}

test("the authoring catalog, render catalog, and theme name the same icons, each with its four files", () => {
    const authoring = (json("catalog.json") as { icons: string[] }).icons;
    const render = (json("render/catalog.json") as { icons: string[] }).icons;
    const theme = (json("theme.json") as { icons: { names: string[] } }).icons.names;
    const names = [...authoring].sort();
    assert.deepEqual([...render].sort(), names, "render/catalog.json icons");
    assert.deepEqual([...theme].sort(), names, "theme.json icons.names");
    const missing = names.flatMap((name) =>
        [`${name}.png`, `${name}@2x.png`, `${name}@3x.png`, `${name}.svg`].filter(
            (file) => !existsSync(join(spec, "icons", file)),
        ),
    );
    assert.deepEqual(missing, [], "icons/ files");
    assert.ok(existsSync(join(spec, "icons", "LICENSE")), "icons/LICENSE");
});

test("the authoring catalog, render catalog, and theme name the same colours", () => {
    const authoring = (json("catalog.json") as { colors: string[] }).colors;
    const render = (json("render/catalog.json") as { colors: string[] }).colors;
    const theme = Object.keys((json("theme.json") as { colors: Record<string, unknown> }).colors);
    assert.deepEqual(render, authoring, "render/catalog.json colors");
    assert.deepEqual(theme, authoring, "theme.json colors");
});
