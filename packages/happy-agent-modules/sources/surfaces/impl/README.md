# Surface implementation helpers

Decimal fractional keys delegate to the common catalog ordering utility. Managed images use
the shared image-normalization function beside the other image utilities, not a Surface helper.

`formatSurfaceChatPrompt` is a Surface chat's context: one guide per type names the Surface, the
calls that read its current state, and how the chat works on it.

`surfaceReferenceInstructions` goes to every agent: it mentions a Surface as
`[](https://link.happy.page/#1/<instanceId>/surfaces/<surfaceId>)`, whose ID is the `surfaceId` the Surface tools take.
