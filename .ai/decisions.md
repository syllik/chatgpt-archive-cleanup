# Decisions

- Canonical AI lifecycle and review semantics are inherited from `syllik/ai-workflow`.
- Read-only discovery/dry-run is the default safety posture; mutation requires the explicitly reviewed execution path.
- Existing archive safety controls are repository-owned invariants and cannot be relaxed by generic workflow instructions.
