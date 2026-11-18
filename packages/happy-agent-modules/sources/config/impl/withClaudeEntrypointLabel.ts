/**
 * The entrypoint Claude Code reports for Happy's requests when `[feature.claude_entrypoint_label]`
 * is on. Anthropic meters requests labeled `sdk-ts` or `sdk-cli` more heavily against a
 * subscription's five-hour limit than the same tokens from any other label. It must never start
 * with `sdk-`, and must not be `cli`, which Claude Code rewrites to `sdk-cli` when headless.
 */
export const HAPPY_CLAUDE_ENTRYPOINT = "happy-agent";

/**
 * The environment a Claude Code child starts with. Off, it is `env` exactly. On, Happy's label
 * replaces whatever entrypoint was inherited, such as `sdk-ts` or `claude-desktop` when the
 * daemon was itself started inside a Claude session; the Agent SDK fills in `sdk-ts` only when
 * none is set.
 */
export function withClaudeEntrypointLabel(
    env: NodeJS.ProcessEnv,
    enabled: boolean,
): NodeJS.ProcessEnv {
    return enabled ? { ...env, CLAUDE_CODE_ENTRYPOINT: HAPPY_CLAUDE_ENTRYPOINT } : env;
}
