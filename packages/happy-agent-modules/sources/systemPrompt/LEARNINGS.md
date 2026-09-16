# System prompt learnings

## Windows guidance must describe the executing shell

Agent configuration captured `SHELL`, which is commonly absent on Windows or inherited from Git
Bash. Native Compute always runs Windows PowerShell 5.1, so Windows prompts name that actual
default on every inference, including for existing agents. Guidance covers PowerShell quoting,
environment variables, exit checks, file paths, and hidden background helpers. Vendor tool names
do not select a shell; Claude's Bash description must agree with this environment.
