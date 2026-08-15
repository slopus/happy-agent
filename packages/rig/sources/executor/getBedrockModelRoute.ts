import { BEDROCK_MODEL_ROUTES, type BedrockModelRoute } from "../model-catalog/bedrock/bedrock-model-routes.js";

export function getBedrockModelRoute(modelId: string): BedrockModelRoute | undefined {
    return BEDROCK_MODEL_ROUTES.find((route) => route.model.id === modelId);
}
