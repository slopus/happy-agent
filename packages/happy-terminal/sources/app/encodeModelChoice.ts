export function encodeModelChoice(providerId: string, modelId: string): string {
    return JSON.stringify([providerId, modelId]);
}
