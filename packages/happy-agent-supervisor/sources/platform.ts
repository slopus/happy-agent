import { type Static, Type } from "@sinclair/typebox";

export const PLATFORM_TARGETS = {
    "win32-x64": {
        alias: "@slopus/happy-agent-supervisor-win32-x64",
        arch: "x64",
        os: "win32",
        tag: "win32-x64",
        target: "x86_64-pc-windows-gnu",
    },
    "darwin-arm64": {
        alias: "@slopus/happy-agent-supervisor-darwin-arm64",
        arch: "arm64",
        os: "darwin",
        tag: "darwin-arm64",
        target: "aarch64-apple-darwin",
    },
    "darwin-x64": {
        alias: "@slopus/happy-agent-supervisor-darwin-x64",
        arch: "x64",
        os: "darwin",
        tag: "darwin-x64",
        target: "x86_64-apple-darwin",
    },
    "linux-arm64": {
        alias: "@slopus/happy-agent-supervisor-linux-arm64",
        arch: "arm64",
        os: "linux",
        tag: "linux-arm64",
        target: "aarch64-unknown-linux-musl",
    },
    "linux-x64": {
        alias: "@slopus/happy-agent-supervisor-linux-x64",
        arch: "x64",
        os: "linux",
        tag: "linux-x64",
        target: "x86_64-unknown-linux-musl",
    },
} as const;

export type PlatformKey = keyof typeof PLATFORM_TARGETS;

export const linuxSupervisorArchitectureSchema = Type.Union([
    Type.Literal("amd64"),
    Type.Literal("x64"),
    Type.Literal("x86_64"),
    Type.Literal("arm64"),
    Type.Literal("aarch64"),
]);

/** Architecture spellings used by OCI, Node.js, and Rust target triples. */
export type LinuxSupervisorArchitecture = Static<typeof linuxSupervisorArchitectureSchema>;
