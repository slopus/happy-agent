import { describe, expect, it } from "vitest";

import { removeProviderAccountTables } from "../../sources/config/impl/removeProviderAccountTables.js";

describe("removeProviderAccountTables", () => {
    it("takes out account tables and keeps every other byte, comments included", () => {
        const source = [
            "# My Happy settings",
            "[defaults]",
            'provider = "codex" # the usual one',
            "",
            "[providers]",
            "default_enable = false",
            "",
            "# Work account",
            "[providers.work_codex]",
            'type = "codex"',
            'auth_file = "/Users/me/.codex-work/auth.json"',
            "",
            "[providers.bedrock]",
            'region = "us-west-2"',
            "",
            '[providers.bedrock.model_overrides."openai/gpt-6-sol"]',
            'region = "us-east-1"',
            "",
            "# Voice comes next",
            "[voice]",
            "system_prompt = '''",
            "[providers.not_a_table]",
            "'''",
            "",
        ].join("\r\n");

        const result = removeProviderAccountTables(source);

        expect(result).toEqual({
            kind: "removed",
            text: [
                "# My Happy settings",
                "[defaults]",
                'provider = "codex" # the usual one',
                "",
                "[providers]",
                "default_enable = false",
                "",
                "# Work account",
                "# Voice comes next",
                "[voice]",
                "system_prompt = '''",
                "[providers.not_a_table]",
                "'''",
                "",
            ].join("\r\n"),
        });
    });

    it.each([
        ["an inline table", 'providers = { work = { type = "codex" } }\n'],
        ["dotted keys at the top", 'providers.work.type = "codex"\n'],
        ["dotted keys under [providers]", '[providers]\nwork.type = "codex"\n'],
        ["an inline account under [providers]", '[providers]\nwork = { type = "codex" }\n'],
        ["an array of tables", '[[providers.work]]\ntype = "codex"\n'],
        ["a file that does not parse", "[providers.work\n"],
    ])("leaves a file with %s alone", (_, source) => {
        expect(removeProviderAccountTables(source)).toMatchObject({ kind: "unsafe" });
    });

    it("returns a file without accounts unchanged", () => {
        const source = "[defaults]\nprovider = 'codex'\n";
        expect(removeProviderAccountTables(source)).toEqual({ kind: "removed", text: source });
    });
});
