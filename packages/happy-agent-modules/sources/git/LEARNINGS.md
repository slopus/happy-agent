# Git learnings

## An unborn branch has no comparison base

Using the empty tree when HEAD did not exist made an unborn repository look comparable without
any relationship to origin/main. Comparison is now unavailable until HEAD and its merge base with
origin/main exist. Local main and empty-tree baselines are never substitutes, so the badge and
changed-file readers cannot claim a ready comparison against different histories.

## A missing revision is not a missing file

Git's path lookup can say a file does not exist in an object even when that object itself is
missing. Historical reads now verify that the revision names a tree before classifying path
absence. Unknown or unavailable history remains an operational failure; only an absent path
within an existing tree returns `found: false`. Oversized blobs have a typed error so bounded
viewers can explain their limit without parsing Git's human-readable output.
