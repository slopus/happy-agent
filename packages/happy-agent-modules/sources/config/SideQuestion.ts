import type { AcpSideQuestionAnswer } from "@slopus/happy-providers";

/**
 * How a side question asked of the harness running an agent ended: answered; refused, because that
 * harness answers no side questions; or not asked, because the harness holds no conversation for
 * the agent yet.
 */
export type ConfigSideQuestionOutcome =
    | { readonly status: "answered"; readonly answer: AcpSideQuestionAnswer }
    | { readonly status: "unsupported" }
    | { readonly status: "harness_not_running" };
