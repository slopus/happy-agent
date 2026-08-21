# Slash command learnings

## Command images are separate resources

Command catalogs and events carry only the image ThumbHash needed for immediate rendering. The
module keeps the complete bytes beside the cached private command owner, and the API serves them
from the focused command image endpoint with a content-derived ETag. This keeps bootstrap and live
events small while still making image changes observable through catalog replacement events.
