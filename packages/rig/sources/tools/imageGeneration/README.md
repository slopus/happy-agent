# Image generation

This module is the host implementation behind the image-generation feature.
The feature adapter supplies the request schema and model tool separately.

```text
                    feature request
                          |
                          v
              preferred current provider
                          |
                          | definitive account refusal only
                          v
             remaining providers in round-robin order
                          |
                          v
                 user data/Generated/<request>.png
```

The generated-media store is Rig-owned and publicly readable. Native models see
its host path; managed Docker models see the same folder read-only at
`/happy/generated`.

Codex cloud providers currently supply the capability. Bedrock does not.
Transport failures and malformed results stop without fallback because the
first request may already have been billed. Edit inputs are prepared
sequentially under aggregate source and encoded-request limits.
