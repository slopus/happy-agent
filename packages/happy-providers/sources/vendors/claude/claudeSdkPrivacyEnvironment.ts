export const CLAUDE_SDK_PRIVACY_ENVIRONMENT = {
    ANT_OTEL_LOGS_EXPORTER: "none",
    ANT_OTEL_METRICS_EXPORTER: "none",
    ANT_OTEL_TRACES_EXPORTER: "none",
    BETA_TRACING_ENDPOINT: "",
    CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
    CLAUDE_CODE_ENABLE_TELEMETRY: "0",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "0",
    CLAUDE_CODE_PERFETTO_TRACE: "0",
    DISABLE_AUTO_COMPACT: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_BUG_COMMAND: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_FEEDBACK_COMMAND: "1",
    DISABLE_TELEMETRY: "1",
    ENABLE_BETA_TRACING_DETAILED: "0",
    ENABLE_ENHANCED_TELEMETRY_BETA: "0",
    FORCE_AUTOUPDATE_PLUGINS: "0",
    OTEL_LOG_TOOL_CONTENT: "0",
    OTEL_LOG_TOOL_DETAILS: "0",
    OTEL_LOG_USER_PROMPTS: "0",
    OTEL_LOGS_EXPORTER: "none",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_SDK_DISABLED: "true",
    OTEL_TRACES_EXPORTER: "none",
} as const satisfies NodeJS.ProcessEnv;

/**
 * The privacy environment for unmodified Claude Code whose harness allows its telemetry. Either
 * of the two switches it lifts makes Claude Code offer only its built-in aliases, hiding every
 * model the signed-in account is granted. Error reporting, surveys, updates and OpenTelemetry stay
 * off through their own switches.
 */
const {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: _nonessential,
    DISABLE_TELEMETRY: _telemetry,
    ...claudeCodeTelemetry
} = CLAUDE_SDK_PRIVACY_ENVIRONMENT;
export const CLAUDE_CODE_TELEMETRY_ENVIRONMENT = claudeCodeTelemetry satisfies NodeJS.ProcessEnv;
