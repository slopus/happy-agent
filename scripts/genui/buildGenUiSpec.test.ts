import assert from "node:assert/strict";
import { test } from "node:test";

import { staleGenUiFiles } from "./buildGenUiSpec.js";

test("the checked-in Gen UI schema, component pages, and catalog module are up to date", () => {
    assert.deepEqual(staleGenUiFiles(), [], "Run pnpm genui:build and commit the result.");
});
