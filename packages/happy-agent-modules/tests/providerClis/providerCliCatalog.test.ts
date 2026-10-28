import { describe, expect, it } from "vitest";

import { PROVIDER_CLI_DEFINITIONS } from "../../sources/providerClis/impl/providerCliCatalog.js";

function flow(id: string, method: "browser" | "device") {
    const found = PROVIDER_CLI_DEFINITIONS.find((definition) => definition.id === id)?.signIn[
        method
    ];
    if (found === undefined) throw new Error(`No ${method} sign-in for ${id}.`);
    return found;
}

/** Output each vendor program printed while signing in, captured on clean macOS and Windows. */
describe("provider CLI sign-in pages", () => {
    it("finds Claude Code's page", () => {
        const text = [
            "Opening browser to sign in…",
            "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&response_type=code&state=abc",
            "Paste code here if prompted > ",
        ].join("\n");
        expect(flow("claude", "browser").url.exec(text)?.[1]).toBe(
            "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&response_type=code&state=abc",
        );
    });

    it("finds Codex's browser and device pages", () => {
        const browser = [
            "Starting local login server on http://localhost:1455.",
            "If your browser did not open, navigate to this URL to authenticate:",
            "",
            "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&state=s",
        ].join("\n");
        expect(flow("codex", "browser").url.exec(browser)?.[1]).toBe(
            "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&state=s",
        );
        const device = "Open https://auth.openai.com/codex/device\nand enter this code: M3BW-NNSFU";
        expect(flow("codex", "device").url.exec(device)?.[1]).toBe(
            "https://auth.openai.com/codex/device",
        );
        expect(flow("codex", "device").userCode?.exec(device)?.[1]).toBe("M3BW-NNSFU");
    });

    it("finds Grok's device page and code", () => {
        const text = [
            "To sign in, open this URL in your browser:",
            "  https://accounts.x.ai/oauth2/device?user_code=HFQS-VYYQ",
            "Confirm this code in your browser:",
            "  HFQS-VYYQ",
        ].join("\n");
        expect(flow("grok", "device").url.exec(text)?.[1]).toBe(
            "https://accounts.x.ai/oauth2/device?user_code=HFQS-VYYQ",
        );
        expect(flow("grok", "device").userCode?.exec(text)?.[1]).toBe("HFQS-VYYQ");
    });

    it("finds Antigravity's page and its sixty-second wait", () => {
        const text = [
            "Authentication required. Please visit the URL to log in:",
            "  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071&state=x",
            "",
            "Waiting for authentication (timeout 60s)...",
        ].join("\n");
        const antigravity = flow("antigravity", "browser");
        expect(antigravity.url.exec(text)?.[1]).toBe(
            "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071&state=x",
        );
        expect(antigravity.acceptsCode).toBe(true);
        expect(antigravity.waitsMs).toBe(60_000);
    });

    it("discloses each official installer", () => {
        const commands = Object.fromEntries(
            PROVIDER_CLI_DEFINITIONS.map((definition) => [
                definition.id,
                [definition.installer("darwin")?.command, definition.installer("win32")?.command],
            ]),
        );
        expect(commands).toEqual({
            claude: [
                "curl -fsSL https://claude.ai/install.sh | bash",
                "irm https://claude.ai/install.ps1 | iex",
            ],
            codex: [
                "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
                "$env:CODEX_NON_INTERACTIVE=1; irm https://chatgpt.com/codex/install.ps1 | iex",
            ],
            grok: [
                "curl -fsSL https://x.ai/cli/install.sh | bash",
                "irm https://x.ai/cli/install.ps1 | iex",
            ],
            antigravity: [
                "curl -fsSL https://antigravity.google/cli/install.sh | bash",
                "irm https://antigravity.google/cli/install.ps1 | iex",
            ],
        });
    });
});
