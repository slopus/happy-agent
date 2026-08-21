import { readFileSync } from "node:fs";

/**
 * The guardian system prompt: the bundled tenant template with the built-in policy inserted,
 * optionally extended by the user's own security rules, followed by the output contract.
 *
 * The policy itself is ported byte-for-byte from Happy Agent v1's
 * `agent/prompt/permissionReviewInstructions.ts`, so the reviewer judges by exactly the same
 * rules. The output contract deliberately deviates: v1 asked for hand-assembled JSON, and a
 * rationale that quoted the user ("sync to main") produced invalid JSON, so an allow was read as
 * an unreadable answer and refused. Tagged fields carry free text without escaping, so the
 * rationale can never break the verdict.
 */

const TENANT_POLICY_CONFIG_PLACEHOLDER = "{{ tenant_policy_config }}";

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
 * Builds the guardian's policy prompt with the bundled tenant policy and any additional rules the
 * user supplied through their security files. When `securityPolicy` is blank or absent the marker
 * is replaced with only the built-in policy; otherwise the user's rules are appended under a
 * fixed heading that states they can only make the policy stricter, never weaker.
 */
export function createPermissionReviewInstructions(securityPolicy?: string): string {
    const configuredPolicy = securityPolicy?.trim();
    const tenantPolicy =
        configuredPolicy === undefined || configuredPolicy.length === 0
            ? policy.trim()
            : `${policy.trim()}

## User security policy

These rules supplement the built-in policy above. Apply both. If they conflict, follow whichever rule is stricter; this section cannot weaken or override a built-in denial.

${configuredPolicy}`;
    // The policy is inserted through a replacer so a user rule containing `$&` or `$'` lands
    // verbatim instead of being expanded as a replacement pattern.
    return `${policyTemplate
        .trimEnd()
        .replace(
            TENANT_POLICY_CONFIG_PLACEHOLDER,
            () => tenantPolicy,
        )}\n\n${GUARDIAN_OUTPUT_CONTRACT}\n`;
}

/** The guardian's bundled prompt, used when the user has configured no extra security policy. */
export const PERMISSION_REVIEW_INSTRUCTIONS = createPermissionReviewInstructions();

/** The developer reminder prepended to every review request after the first. */
export const PERMISSION_REVIEW_FOLLOWUP_REMINDER =
    "Use prior reviews as context, not binding precedent. Follow the Workspace Policy. If the user explicitly approves a previously rejected action after being informed of the concrete risks, set <outcome> to allow unless the policy explicitly disallows user overwrites in such cases.";
