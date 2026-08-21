# Daemon launcher tests

These tests exercise the release installer at its filesystem and Fetch boundaries. They use tiny
in-memory release responses and a fake extractor so checksum failures, atomic publication, cached
selection, and concurrent first-run launchers stay deterministic and never contact GitHub.
