import { type Static, Type } from "@sinclair/typebox";
import { linuxSupervisorArchitectureSchema } from "@slopus/happy-agent-supervisor";

const exact = { additionalProperties: false } as const;
const nonBlankString = Type.String({ minLength: 1, pattern: "\\S" });
const absoluteContainerPath = Type.String({ minLength: 1, pattern: "^/" });
const rootProjectFileName = Type.String({ minLength: 1, pattern: "^[^/]+$" });

/** Product-owned paths and project files accepted in Docker provider configuration. */
export const dockerHostPolicyConfigSchema = Type.Object(
    {
        protectedProjectFiles: Type.Optional(Type.Array(rootProjectFileName)),
        networkPolicyFiles: Type.Optional(Type.Array(rootProjectFileName)),
        privateDirectories: Type.Optional(Type.Array(absoluteContainerPath)),
        readableDirectories: Type.Optional(Type.Array(absoluteContainerPath)),
        privatePathVariables: Type.Optional(Type.Array(nonBlankString)),
    },
    exact,
);

/** One host directory exposed inside a managed container at a fixed absolute path. */
export const dockerMountConfigSchema = Type.Object(
    {
        source: nonBlankString,
        target: absoluteContainerPath,
        readOnly: Type.Optional(Type.Boolean()),
    },
    exact,
);

export type DockerMountConfig = Static<typeof dockerMountConfigSchema>;

const sharedDockerConfigProperties = {
    /**
     * Linux architecture of the container. Defaults to the current Node architecture; set it
     * explicitly when Docker runs an emulated image (for example, linux/amd64 on an arm64 Mac).
     */
    architecture: Type.Optional(linuxSupervisorArchitectureSchema),
    hostPolicy: Type.Optional(dockerHostPolicyConfigSchema),
    socketPath: Type.Optional(nonBlankString),
    workingDirectory: absoluteContainerPath,
};

/**
 * Everything the Docker backend needs to reach a container and work inside it.
 *
 * A configuration names either a running `container` to attach to or a local `image` used to start
 * a managed container; the union makes the two mutually exclusive at the validation boundary.
 * Settings that only take effect while creating a container exist only on the image branch.
 */
export const dockerExecutionConfigSchema = Type.Union([
    Type.Object(
        {
            ...sharedDockerConfigProperties,
            container: nonBlankString,
            apparmorProfile: Type.Optional(Type.Never()),
            environment: Type.Optional(Type.Never()),
            image: Type.Optional(Type.Never()),
            mounts: Type.Optional(Type.Never()),
            name: Type.Optional(Type.Never()),
        },
        exact,
    ),
    Type.Object(
        {
            ...sharedDockerConfigProperties,
            container: Type.Optional(Type.Never()),
            image: nonBlankString,
            /** An administrator-installed profile. Compute never installs or relaxes host policy. */
            apparmorProfile: Type.Optional(
                Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_.-]+$" }),
            ),
            environment: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
            mounts: Type.Optional(Type.Array(dockerMountConfigSchema)),
            name: Type.Optional(nonBlankString),
        },
        exact,
    ),
]);

export type DockerExecutionConfig = Static<typeof dockerExecutionConfigSchema>;
