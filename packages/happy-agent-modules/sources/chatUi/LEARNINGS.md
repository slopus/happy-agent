# Retired chat UI

The component catalog, `show_ui`, `suggest_replies`, quick-reply validation, and action execution
were explicitly removed. Historical calls retain their original names, arguments, status, and
results and are shown as ordinary calls, never interactive controls or fallback-text replacements.
Only the immutable migration remains registered so existing installations can reopen their data.
Chat onboarding is deferred; ordinary structured questions and media attachments are unaffected.
