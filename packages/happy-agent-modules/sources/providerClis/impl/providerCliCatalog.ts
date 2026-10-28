import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
    ProviderCliId,
    ProviderCliInstallation,
    ProviderCliInstaller,
    ProviderCliSignInMethod,
} from "../ProviderCli.js";

/** One place a program may live, and what finding it there says about how it was installed. */
export interface ProviderCliCandidate {
    readonly path: string;
    readonly source: NonNullable<ProviderCliInstallation["source"]>;
    readonly desktopApp?: string;
}

/** The machine facts discovery and installing depend on. */
export interface ProviderCliMachine {
    readonly platform: NodeJS.Platform;
    readonly env: Readonly<NodeJS.ProcessEnv>;
    readonly applications: readonly string[];
    /** Package-manager folders searched whether or not they are on `PATH`. */
    readonly programDirectories: readonly string[];
}

/** How one sign-in method is started and how its page appears in the program's output. */
export interface ProviderCliSignInFlow {
    readonly args: readonly string[];
    /** The page to open, found in everything the program printed so far. */
    readonly url: RegExp;
    readonly userCode?: RegExp;
    readonly openedByProgram: boolean;
    readonly acceptsCode: boolean;
    /** How long the program itself waits, when shorter than the daemon's ten minutes. */
    readonly waitsMs?: number;
}

/** Everything that differs between the assistants. */
export interface ProviderCliDefinition {
    readonly id: ProviderCliId;
    readonly name: string;
    readonly vendor: string;
    readonly website: string;
    readonly program: string;
    readonly commands: { readonly run: string; readonly signIn: string };
    installer(platform: NodeJS.Platform): ProviderCliInstaller | null;
    candidates(machine: ProviderCliMachine): readonly ProviderCliCandidate[];
    readonly signIn: Readonly<Partial<Record<ProviderCliSignInMethod, ProviderCliSignInFlow>>>;
    /** Sign-in methods in the order the daemon prefers them. */
    readonly methods: readonly ProviderCliSignInMethod[];
}

export function homeOf(machine: ProviderCliMachine): string {
    return machine.env["HOME"]?.trim() || machine.env["USERPROFILE"]?.trim() || homedir();
}

function exe(machine: ProviderCliMachine, name: string): string {
    return machine.platform === "win32" ? `${name}.exe` : name;
}

/** Installers that read a script from the vendor and run it, as the vendors document them. */
function scriptInstaller(
    platform: NodeJS.Platform,
    posix: { readonly url: string; readonly shell: string },
    windows: { readonly url: string; readonly prefix?: string } | null,
    vendorSite: string,
): ProviderCliInstaller | null {
    if (platform === "win32") {
        if (windows === null) return null;
        return {
            command: `${windows.prefix ?? ""}irm ${windows.url} | iex`,
            sourceUrl: windows.url,
            sourceHost: new URL(windows.url).host,
            vendorSite,
        };
    }
    return {
        command: `curl -fsSL ${posix.url} | ${posix.shell}`,
        sourceUrl: posix.url,
        sourceHost: new URL(posix.url).host,
        vendorSite,
    };
}

/** Package-manager and version-manager locations of a program installed through npm or Homebrew. */
function packageCandidates(
    machine: ProviderCliMachine,
    program: string,
): readonly ProviderCliCandidate[] {
    if (machine.platform === "win32") {
        const appData = machine.env["APPDATA"];
        return appData === undefined
            ? []
            : [{ path: join(appData, "npm", `${program}.cmd`), source: "package_manager" }];
    }
    const home = homeOf(machine);
    return [
        ...machine.programDirectories.map((directory) => join(directory, program)),
        join(home, ".npm-global", "bin", program),
        join(home, ".local", "share", "mise", "shims", program),
    ].map((path) => ({ path, source: "package_manager" as const }));
}

/**
 * The Claude desktop app keeps its own Claude Code under
 * `~/Library/Application Support/Claude/claude-code/<version>/<build>/claude.app`; the newest
 * version is the one it runs.
 */
function claudeDesktopCandidates(machine: ProviderCliMachine): readonly ProviderCliCandidate[] {
    if (machine.platform !== "darwin") return [];
    const root = join(homeOf(machine), "Library", "Application Support", "Claude", "claude-code");
    const versions = listDirectories(root)
        .filter((name) => /^\d+(\.\d+)+$/.test(name))
        .sort(compareVersions)
        .reverse();
    return versions.flatMap((version) =>
        listDirectories(join(root, version)).map((build) => ({
            path: join(root, version, build, "claude.app", "Contents", "MacOS", "claude"),
            source: "desktop_app" as const,
            desktopApp: "Claude",
        })),
    );
}

function listDirectories(path: string): readonly string[] {
    try {
        return readdirSync(path, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    } catch {
        return [];
    }
}

function compareVersions(left: string, right: string): number {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
}

const claude: ProviderCliDefinition = {
    id: "claude",
    name: "Claude Code",
    vendor: "Anthropic",
    website: "https://claude.com/product/claude-code",
    program: "claude",
    commands: { run: "claude", signIn: "claude auth login" },
    installer: (platform) =>
        scriptInstaller(
            platform,
            { url: "https://claude.ai/install.sh", shell: "bash" },
            { url: "https://claude.ai/install.ps1" },
            "https://claude.com",
        ),
    candidates: (machine) => {
        const home = homeOf(machine);
        return [
            { path: join(home, ".local", "bin", exe(machine, "claude")), source: "standalone" },
            { path: join(home, ".claude", "local", exe(machine, "claude")), source: "standalone" },
            ...claudeDesktopCandidates(machine),
            ...packageCandidates(machine, "claude"),
        ];
    },
    signIn: {
        // Claude opens the browser itself for a page served on this computer, and also prints
        // a page that shows a code to paste back, for when that browser cannot reach it.
        browser: {
            args: ["auth", "login", "--claudeai"],
            url: /(https:\/\/\S+\/oauth\/authorize\?\S+)/,
            openedByProgram: true,
            acceptsCode: true,
        },
    },
    methods: ["browser"],
};

const codex: ProviderCliDefinition = {
    id: "codex",
    name: "Codex",
    vendor: "OpenAI",
    website: "https://openai.com/codex",
    program: "codex",
    commands: { run: "codex", signIn: "codex login" },
    installer: (platform) =>
        scriptInstaller(
            platform,
            {
                url: "https://chatgpt.com/codex/install.sh",
                shell: "CODEX_NON_INTERACTIVE=1 sh",
            },
            {
                url: "https://chatgpt.com/codex/install.ps1",
                prefix: "$env:CODEX_NON_INTERACTIVE=1; ",
            },
            "https://openai.com",
        ),
    candidates: (machine) => {
        const home = homeOf(machine);
        const standalone = join(
            home,
            ".codex",
            "packages",
            "standalone",
            "current",
            "bin",
            exe(machine, "codex"),
        );
        const local = machine.env["LOCALAPPDATA"];
        return [
            { path: standalone, source: "standalone" },
            ...(machine.platform === "win32"
                ? local === undefined
                    ? []
                    : [
                          {
                              path: join(local, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
                              source: "standalone" as const,
                          },
                      ]
                : [{ path: join(home, ".local", "bin", "codex"), source: "standalone" as const }]),
            ...machine.applications.flatMap((applications) => [
                {
                    path: join(applications, "Codex.app", "Contents", "Resources", "codex"),
                    source: "desktop_app" as const,
                    desktopApp: "Codex",
                },
                {
                    path: join(
                        applications,
                        "ChatGPT.app",
                        "Contents",
                        "Resources",
                        "codex-cli",
                        "bin",
                        "codex",
                    ),
                    source: "desktop_app" as const,
                    desktopApp: "ChatGPT",
                },
            ]),
            ...packageCandidates(machine, "codex"),
        ];
    },
    signIn: {
        browser: {
            args: ["login"],
            url: /(https:\/\/auth\.openai\.com\/oauth\/authorize\?\S+)/,
            openedByProgram: true,
            acceptsCode: false,
        },
        device: {
            args: ["login", "--device-auth"],
            url: /(https:\/\/auth\.openai\.com\/codex\/device\S*)/,
            userCode: /\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/,
            openedByProgram: false,
            acceptsCode: false,
        },
    },
    methods: ["browser", "device"],
};

const grok: ProviderCliDefinition = {
    id: "grok",
    name: "Grok",
    vendor: "xAI",
    website: "https://x.ai/cli",
    program: "grok",
    commands: { run: "grok", signIn: "grok login" },
    installer: (platform) =>
        scriptInstaller(
            platform,
            { url: "https://x.ai/cli/install.sh", shell: "bash" },
            { url: "https://x.ai/cli/install.ps1" },
            "https://x.ai",
        ),
    candidates: (machine) => {
        const home = homeOf(machine);
        return [
            { path: join(home, ".grok", "bin", exe(machine, "grok")), source: "standalone" },
            ...(machine.platform === "win32"
                ? []
                : [{ path: join(home, ".local", "bin", "grok"), source: "standalone" as const }]),
            ...packageCandidates(machine, "grok"),
        ];
    },
    signIn: {
        browser: {
            args: ["login", "--oauth"],
            url: /(https:\/\/auth\.x\.ai\/\S+)/,
            openedByProgram: true,
            acceptsCode: false,
        },
        device: {
            args: ["login", "--device-auth"],
            url: /(https:\/\/accounts\.x\.ai\/oauth2\/device\S*)/,
            userCode: /user_code=([A-Z0-9-]+)/,
            openedByProgram: false,
            acceptsCode: false,
        },
    },
    methods: ["browser", "device"],
};

const antigravity: ProviderCliDefinition = {
    id: "antigravity",
    name: "Antigravity",
    vendor: "Google",
    website: "https://antigravity.google",
    program: "agy",
    commands: { run: "agy", signIn: "agy" },
    installer: (platform) =>
        scriptInstaller(
            platform,
            { url: "https://antigravity.google/cli/install.sh", shell: "bash" },
            { url: "https://antigravity.google/cli/install.ps1" },
            "https://antigravity.google",
        ),
    candidates: (machine) => {
        const home = homeOf(machine);
        const local = machine.env["LOCALAPPDATA"];
        return [
            ...(machine.platform === "win32"
                ? local === undefined
                    ? []
                    : [
                          {
                              path: join(local, "agy", "bin", "agy.exe"),
                              source: "standalone" as const,
                          },
                      ]
                : [{ path: join(home, ".local", "bin", "agy"), source: "standalone" as const }]),
            { path: join(home, ".antigravity", "bin", exe(machine, "agy")), source: "standalone" },
            ...packageCandidates(machine, "agy"),
        ];
    },
    signIn: {
        // agy has no sign-in command: its first request while signed out signs in, opens the
        // browser itself, accepts a pasted code, and gives up after sixty seconds.
        browser: {
            args: ["-p", "Reply with OK."],
            url: /(https:\/\/accounts\.google\.com\/o\/oauth2\/\S+)/,
            openedByProgram: true,
            acceptsCode: true,
            waitsMs: 60_000,
        },
    },
    methods: ["browser"],
};

/** Every supported assistant, in display order. */
export const PROVIDER_CLI_DEFINITIONS: readonly ProviderCliDefinition[] = [
    claude,
    codex,
    grok,
    antigravity,
];
