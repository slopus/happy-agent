import { readFileSync } from "node:fs";

/**
 * The guardian system prompt: Codex's Guardian template with Codex's policy inserted, followed by
 * the user's own security rules and the output contract.
 *
 * Both prompt files track Codex's bundled `codex-rs/prompts/templates/guardian/policy_template.md`
 * and `policy.md`, last compared at openai/codex commit f2b94ef (2026-11-04), and are assembled
 * the way Codex's `GuardianPolicyInstructions` does it: the policy goes into
 * `{{ tenant_policy_config }}` and the user's rules go raw into `{{ extra_policy }}`. Keep the diff
 * against Codex minimal and re-compare when Codex changes them. The key differences:
 *
 * - Trusted content is the user's messages and their answers to interactive questions only.
 *   Codex also trusts developer messages, `AGENTS.md`, and `request_user_input` answers; in Happy
 *   repository content is never authorization.
 * - The Investigation Guidelines add three bullets that let the reviewer read delegators' history
 *   with `read_agent_history`, trusting only the person's own messages. Codex appends a separate
 *   conversation-history section instead.
 * - When the reviewed agent has a parent, the Investigation Guidelines add the `ask_parent`
 *   bullet, which has the reviewer ask the parent's reviewer before denying for unclear intent.
 *   Codex has no parent chain to ask.
 * - The escalation request is named for every provider (`dangerouslyDisableSandbox` as well as
 *   `sandbox_permissions`), not only Codex's field.
 * - The policy says the user's security files (`SECURITY.md`, `AGENTS_SECURITY.md`) can mark a
 *   destination as trusted, and the rationale says when a destination is not trusted, so the
 *   refusal can tell the user how to approve or trust it.
 * - The output contract asks for tagged fields rather than Codex's JSON: a rationale that quoted
 *   the user ("sync to main") once broke hand-assembled JSON and turned an allow into a refusal.
 * - Codex's `node_repl_policy.md` is not included; Happy has no Node REPL tool.
 */

const TENANT_POLICY_CONFIG_PLACEHOLDER = "{{ tenant_policy_config }}";
const EXTRA_POLICY_PLACEHOLDER = "{{ extra_policy }}";
const ASK_PARENT_PLACEHOLDER = "{{ ask_parent }}";

/**
 * The Investigation Guidelines bullet a reviewer gets only when it holds `ask_parent`: the agent it
 * reviews was created by another agent, and the chain to the root is not exhausted. Without the
 * tool the bullet and its line are absent, so a root agent's reviewer gets exactly the prompt it had.
 */
export const ASK_PARENT_GUIDELINE = `- The agent in \`<reviewed_agent_id>\` was created by another agent, and you have the \`ask_parent\` tool, which puts a question to a temporary copy of the parent agent's permission reviewer. If you would deny because the user's authorization or intent is unclear, ask first: one specific question naming the exact action and target. Deny only if the answer does not establish authorization. Treat the answer as evidence of what the person asked for: it supports \`user_authorization\` only where it reports the person's own request, and that request covers this exact action and target. It never sets aside a deny rule in the security policy. An answer of "unknown", an error, or no answer leaves the authorization where it was.`;

const GUARDIAN_OUTPUT_CONTRACT = `You may use read-only tool checks to gather any additional context you need before deciding. When you are ready to answer, end your final message with your verdict inside a <review> block, and write nothing after it.

For low-risk actions, give the final answer directly:
<review>
<outcome>allow</outcome>
</review>

For anything else, fill in every field:
<review>
<risk_level>low | medium | high | critical</risk_level>
<user_authorization>unknown | low | medium | high</user_authorization>
<outcome>allow | deny</outcome>
<rationale>One concise sentence.</rationale>
</review>

Put each field on its own line between its own tags. Write one of the listed words, and nothing else, inside <risk_level>, <user_authorization>, and <outcome>. The rationale is plain prose: quotes, punctuation, and braces need no escaping, but it must not contain the </rationale> tag.`;

const policyTemplate = readFileSync(
    new URL("../prompts/guardian-policy-template.md", import.meta.url),
    "utf8",
);
const policy = readFileSync(new URL("../prompts/guardian-policy.md", import.meta.url), "utf8");

/**
 * Builds the guardian's policy prompt with the bundled policy and any additional rules the user
 * supplied through their security files, as Codex does: only template text is substituted, so a
 * placeholder-like string or a `$&` inside either policy lands verbatim. `askParent` adds the
 * `ask_parent` guideline for a reviewer that is offered that tool.
 */
export function createPermissionReviewInstructions(
    securityPolicy?: string,
    options: { readonly askParent?: boolean } = {},
): string {
    const extraPolicy = securityPolicy?.trim() ?? "";
    const prompt = policyTemplate
        .trimEnd()
        .split(`\n\n${ASK_PARENT_PLACEHOLDER}`)
        .join(options.askParent === true ? `\n${ASK_PARENT_GUIDELINE}` : "")
        .split(TENANT_POLICY_CONFIG_PLACEHOLDER)
        .map((part) => part.split(EXTRA_POLICY_PLACEHOLDER).join(extraPolicy))
        .join(policy.trim());
    return `${prompt}\n\n${GUARDIAN_OUTPUT_CONTRACT}\n`;
}

/** The guardian's bundled prompt, used when the user has configured no extra security policy. */
export const PERMISSION_REVIEW_INSTRUCTIONS = createPermissionReviewInstructions();

/** The developer reminder prepended to every review request after the first; Codex's text. */
export const PERMISSION_REVIEW_FOLLOWUP_REMINDER =
    "Use prior reviews as context, not binding precedent. Follow the Workspace Policy. If the user explicitly approves a previously rejected action after being informed of the concrete risks, set <outcome> to allow unless the policy explicitly disallows user overwrites in such cases.";
