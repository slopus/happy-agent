/**
 * The Auto-mode automatic permission reviewer module.
 *
 * `AutoModule` is the whole feature: a main-system module that archives durable review evidence and,
 * behind a private `AgentSystemLocal` nothing else can reach, runs one reviewer per main agent. Only
 * the module, its construction schema, the wall-clock budget the host wires as the review timeout,
 * and the pure helpers a host or test legitimately needs are published here. The private review
 * system, its storage, the reviewer IDs, the model catalog, and every internal impl module stay
 * unexported so that guessing a reviewer ID addresses nothing.
 */

export {
    AUTO_PERMISSION_REVIEW_BUDGET_MS,
    AutoModule,
    userInputAnsweredSchema,
} from "./AutoModule.js";
export type { UserInputAnsweredEvent } from "./AutoModule.js";

export {
    autoEvidenceEntrySchema,
    autoEvidenceStateSchema,
    autoReviewerCursorSchema,
} from "./AutoReviewTranscript.js";
export type {
    AutoEvidenceEntry,
    AutoEvidenceState,
    AutoReviewerCursor,
} from "./AutoReviewTranscript.js";

export {
    autoReviewerRouteSchema,
    NoReviewerModelError,
    reviewerModelForAgent,
} from "./impl/reviewerModelForAgent.js";
export type { AutoReviewerRoute } from "./impl/reviewerModelForAgent.js";

export { reviewerAgentId } from "./impl/reviewerAgentId.js";
export { buildAutoReviewCatalog } from "./impl/buildAutoReviewCatalog.js";
export {
    MAX_TRANSCRIPT_ENTRIES,
    MAX_TRANSCRIPT_ENTRY_CHARACTERS,
    boundReviewTranscript,
} from "./impl/boundReviewTranscript.js";
export { convertGuardianReview } from "./impl/convertGuardianReview.js";

export {
    PERMISSION_REVIEW_FOLLOWUP_REMINDER,
    PERMISSION_REVIEW_INSTRUCTIONS,
    createPermissionReviewInstructions,
} from "./impl/createPermissionReviewInstructions.js";
export {
    PERMISSION_REVIEW_NO_NEW_CONVERSATION,
    createPermissionReviewPrompt,
    permissionReviewPromptOptionsSchema,
} from "./impl/createPermissionReviewPrompt.js";
export type { PermissionReviewPromptOptions } from "./impl/createPermissionReviewPrompt.js";
export {
    AUTO_PERMISSION_USER_EVIDENCE_OMITTED,
    autoTranscriptMessageSchema,
    createAutoPermissionTranscript,
} from "./impl/createAutoPermissionTranscript.js";
export type {
    AutoPermissionTranscript,
    AutoTranscriptMessage,
} from "./impl/createAutoPermissionTranscript.js";
export {
    autoPermissionDenialKindSchema,
    autoPermissionReviewSchema,
    autoPermissionRiskSchema,
    autoPermissionUserAuthorizationSchema,
    parseAutoPermissionReview,
} from "./impl/parseAutoPermissionReview.js";
export type {
    AutoPermissionDenialKind,
    AutoPermissionReview,
    AutoPermissionRisk,
    AutoPermissionUserAuthorization,
} from "./impl/parseAutoPermissionReview.js";
export { shouldAllowAutoPermissionReview } from "./impl/shouldAllowAutoPermissionReview.js";
export { describeAutoPermissionDenial } from "./impl/describeAutoPermissionDenial.js";
export {
    AUTO_SECURITY_MD_MAX_BYTES,
    GLOBAL_SECURITY_HEADING,
    PROJECT_SECURITY_HEADING,
    readAutoSecurityPolicy,
} from "./impl/readAutoSecurityPolicy.js";
