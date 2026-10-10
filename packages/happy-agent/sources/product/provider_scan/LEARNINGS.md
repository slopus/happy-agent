# Native provider scan learnings

Automatic accounts stay disabled until the startup scan finishes. A positive local credential
probe writes the first auto-enable decision to the generated runtime file. Later missing
credentials and probe errors preserve that decision; explicit enablement and an explicit false
auto-enable value always win.

Scans belong to the application lifetime and concurrent callers join one operation. Local
probes have ten-second bounds and never invoke AWS's network or process credential chain.
Verification has its own thirty-second lifetime, makes no tools available, disables provider
retries, and accepts only a normal terminal inference result. Disabling an account cancels its
active verification. Responses contain status and model selection, never vendor diagnostics.
