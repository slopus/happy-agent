export function formatCliHelp(): string {
    return [
        "Usage: happy-terminal [session options]",
        "       happy-terminal desktop [--build-only] [--skip-build | --force-build] [--happy2-root PATH]",
        "       happy-terminal exec [options] [prompt]",
        "       happy-terminal resume [--last | --all | SESSION_ID]",
        "       happy-terminal fork [--last | --all | SESSION_ID]",
        "       happy-terminal inspect [--json]",
        "       happy-terminal upgrade",
        "       happy-terminal daemon <start|stop|kill|status|reload>",
        "       happy-terminal monit",
        "",
        "Run Happy Terminal without a command to start an interactive session.",
        "Use 'happy-terminal desktop' to build and launch the Happy desktop app.",
        "Use 'happy-terminal inspect --json' to inspect this installation without starting the daemon.",
        "Use 'happy-terminal upgrade' to update Happy Agent and restart its daemon.",
        "",
        "Options:",
        "  -h, --help       Show this help.",
        "  -v, --version    Show the installed Happy Terminal version.",
    ].join("\n");
}

export function formatDesktopCliHelp(): string {
    return [
        "Usage: happy-terminal desktop [options]",
        "",
        "Build Happy 2's local macOS shell with the current Happy Terminal runtime embedded, then launch it.",
        "",
        "Options:",
        "  --build-only       Build the app without launching it.",
        "  --skip-build       Launch the existing packaged app.",
        "  --force-build      Rebuild even when the content stamp matches.",
        "  --happy2-root PATH  Use this local Happy 2 source checkout.",
        "  -h, --help          Show this help.",
    ].join("\n");
}
