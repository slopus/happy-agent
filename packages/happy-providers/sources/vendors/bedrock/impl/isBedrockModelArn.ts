/**
 * A Bedrock foundation-model, inference-profile, or application-inference-profile ARN. Callers
 * send it as the model unchanged: an application profile's ID is opaque, so it cannot be checked
 * against the model it routes to.
 */
export function isBedrockModelArn(model: string): boolean {
    return /^arn:aws(?:-cn|-us-gov)?:bedrock:[a-z0-9-]+:\d*:(?:foundation-model|inference-profile|application-inference-profile)\/\S+$/u.test(
        model,
    );
}
