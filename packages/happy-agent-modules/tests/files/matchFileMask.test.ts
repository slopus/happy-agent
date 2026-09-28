import { describe, expect, it } from "vitest";

import { matchFileMask } from "../../sources/files/impl/matchFileMask.js";

const candidates = [
    "README.md",
    "packages/api/schema.ts",
    "packages/api/schema.test.ts",
    "packages/api/routes.ts",
    "packages/app/View.tsx",
    "packages/app/View.test.tsx",
    "packages/app/__snapshots__/View.snap",
    "pnpm-lock.yaml",
];

describe("matchFileMask", () => {
    it("includes everything when no include rule is given and takes exclusions back out", () => {
        const match = matchFileMask(candidates, {
            include: [],
            exclude: ["*.test.*", "__snapshots__/", "pnpm-lock.yaml"],
            paths: [],
        });
        expect(match.files).toEqual([
            "README.md",
            "packages/api/routes.ts",
            "packages/api/schema.ts",
            "packages/app/View.tsx",
        ]);
        expect(match.unmatchedRules).toEqual([]);
    });

    it("anchors a rule with a slash at the root and lets a bare rule sit at any depth", () => {
        const match = matchFileMask(candidates, {
            include: ["packages/api/**", "*.tsx"],
            exclude: ["/README.md"],
            paths: [],
        });
        expect(match.files).toEqual([
            "packages/api/routes.ts",
            "packages/api/schema.test.ts",
            "packages/api/schema.ts",
            "packages/app/View.test.tsx",
            "packages/app/View.tsx",
        ]);
        // The exclusion matched a file the source holds, even though include had already left
        // it out; only a rule that matches nothing in the source is reported.
        expect(match.unmatchedRules).toEqual([]);
    });

    it("lets a later negation within one list win over an earlier rule", () => {
        const match = matchFileMask(candidates, {
            include: ["packages/**", "!packages/app/**"],
            exclude: ["*.test.ts", "!schema.test.ts"],
            paths: [],
        });
        expect(match.files).toEqual([
            "packages/api/routes.ts",
            "packages/api/schema.test.ts",
            "packages/api/schema.ts",
        ]);
    });

    it("keeps a pinned path whatever the rules say and reports one the source lacks", () => {
        const match = matchFileMask(candidates, {
            include: ["*.md"],
            exclude: ["README.md"],
            paths: ["README.md", "packages/api/routes.ts", "packages/gone/Missing.ts"],
        });
        expect(match.files).toEqual(["README.md", "packages/api/routes.ts"]);
        expect(match.unmatchedRules).toEqual(["packages/gone/Missing.ts"]);
    });

    it("names every rule that matched nothing, as written", () => {
        const match = matchFileMask(candidates, {
            include: ["docs/**", "  ", "*.ts"],
            exclude: ["vendor/"],
            paths: [],
        });
        expect(match.files).toEqual([
            "packages/api/routes.ts",
            "packages/api/schema.test.ts",
            "packages/api/schema.ts",
        ]);
        expect(match.unmatchedRules).toEqual(["docs/**", "  ", "vendor/"]);
    });
});
