export function formatCliHelp(): string {
    return [
        "Usage: rig [session options]",
        "       rig desktop [--build-only] [--skip-build | --force-build] [--happy2-root PATH]",
        "       rig exec [options] [prompt]",
        "       rig resume [--last | --all | SESSION_ID]",
        "       rig fork [--last | --all | SESSION_ID]",
        "       rig inspect [--json]",
        "       rig invite",
        "       rig join <rig://join/...>",
        "       rig daemon <start|stop|status|reload>",
        "       rig happy auth",
        "       rig monit",
        "",
        "Run Rig without a command to start an interactive session.",
        "Use 'rig desktop' to build and launch a standalone local Happy app.",
        "Use 'rig happy auth' to connect the Happy mobile app.",
        "Use 'rig inspect --json' to inspect this installation without starting the daemon.",
        "",
        "Options:",
        "  -h, --help       Show this help.",
        "  -v, --version    Show the installed Rig version.",
    ].join("\n");
}

export function formatDesktopCliHelp(): string {
    return [
        "Usage: rig desktop [options]",
        "",
        "Build Happy 2's local macOS shell with the current Rig runtime embedded, then launch it.",
        "",
        "Options:",
        "  --build-only       Build the app without launching it.",
        "  --skip-build       Launch the existing packaged app.",
        "  --force-build      Rebuild even when the content stamp matches.",
        "  --happy2-root PATH  Use this local Happy 2 source checkout.",
        "  -h, --help          Show this help.",
    ].join("\n");
}
