# Surface implementation helpers

Decimal fractional keys delegate to the common catalog ordering utility. Managed images use
the shared image-normalization function beside the other image utilities, not a Surface helper.

`formatSurfaceChatPrompt` is a Surface chat's context: one guide per type names the Surface, the
calls that read its current state, and how the chat works on it.

`SURFACE_REFERENCE_INSTRUCTIONS` goes to every agent: it mentions a Surface as
`[name](happy://surfaces/<surfaceId>)`, whose ID is the `surfaceId` the Surface tools take.

`replaceExactText` is the exact replacement `edit_vault_file` and `edit_document` share: the
text must appear once unless every occurrence was asked for, and the caller names what is
being edited for the refusal messages.
