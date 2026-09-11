import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const supervisorPermissionModeSchema = Type.Union([
    Type.Literal("read_only"),
    Type.Literal("workspace_write"),
    Type.Literal("auto"),
    Type.Literal("full_access"),
]);

export type SupervisorPermissionMode = Static<typeof supervisorPermissionModeSchema>;

export const supervisorProxyFrontEndSchema = Type.Union([
    Type.Literal("http"),
    Type.Literal("socks5"),
]);

export type SupervisorProxyFrontEnd = Static<typeof supervisorProxyFrontEndSchema>;

/**
 * The front-ends to expose inside the sandbox.
 *
 * The supervisor provides the proxy itself. It forks an egress process before the sandbox exists
 * and joins the two with a socketpair, so nothing inside the sandbox reaches the proxy — or
 * anything else — by address, and the caller supplies neither a descriptor nor a token. Which hosts
 * that egress process may reach comes from `network.allowedHosts`.
 */
export const supervisorOutgoingProxySchema = Type.Object(
    {
        frontEnds: Type.Array(supervisorProxyFrontEndSchema, { minItems: 1 }),
    },
    { additionalProperties: false },
);

export type SupervisorOutgoingProxy = Static<typeof supervisorOutgoingProxySchema>;

export const supervisorNetworkPolicySchema = Type.Object(
    {
        egress: Type.Boolean(),
        allowedHosts: Type.Optional(Type.Array(Type.String())),
        localBinding: Type.Boolean(),
        outgoingProxy: Type.Optional(supervisorOutgoingProxySchema),
    },
    { additionalProperties: false },
);

export type SupervisorNetworkPolicy = Static<typeof supervisorNetworkPolicySchema>;

/**
 * The native supervisor's input. Its names intentionally match ComputePermissions one-for-one.
 *
 * The working directory is the workspace root for `workspace_write` and `auto`; keeping it out of
 * the document prevents two sources of truth for the process cwd. A non-empty `allowedHosts`
 * requires `network.outgoingProxy`, because the host list is enforced in the egress process the
 * proxy creates, and without a proxy there would be nothing enforcing it. Each entry names one host
 * or one `*.suffix`; a bare `*` is refused, and open egress is expressed by configuring no proxy.
 */
export const supervisorPolicySchema = Type.Object(
    {
        mode: supervisorPermissionModeSchema,
        allowedReadPaths: Type.Optional(Type.Array(Type.String())),
        deniedReadPaths: Type.Optional(Type.Array(Type.String())),
        allowedWritePaths: Type.Optional(Type.Array(Type.String())),
        deniedWritePaths: Type.Optional(Type.Array(Type.String())),
        /** Windows placeholder type for protected project files that may be absent. */
        deniedWriteFilePaths: Type.Optional(Type.Array(Type.String())),
        network: supervisorNetworkPolicySchema,
    },
    { additionalProperties: false },
);

export type SupervisorPolicy = Static<typeof supervisorPolicySchema>;

export function parseSupervisorPolicy(value: unknown): SupervisorPolicy {
    if (!Value.Check(supervisorPolicySchema, value)) {
        const details = [...Value.Errors(supervisorPolicySchema, value)]
            .map((error) => `${error.path || "/"} ${error.message}`)
            .join("; ");
        throw new Error(`Invalid supervisor policy: ${details}`);
    }
    return Value.Parse(supervisorPolicySchema, value);
}
