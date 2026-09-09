# ChatGPT archive cleanup context

- Repository: `syllik/chatgpt-archive-cleanup`.
- Purpose: local TypeScript/Node utility for manually controlled ChatGPT/Codex archive discovery, dry-run, and guarded execution.
- Integration branch: `main`.
- Canonical AI lifecycle, publication, reviewer roles, and Luna executor boundaries belong to `syllik/ai-workflow`.
- Discovery and dry-run are read-only; archive execution requires the explicit execute command, confirmation flag, and a reviewed dry-run manifest.
- There is no delete operation.
- Browser/session safety, provenance checks, canary execution, journals, and stop-on-ambiguity behavior are repository security boundaries.
- Never read, store, or expose browser cookies, Keychain data, bearer/session tokens, passwords, or Codex credentials.
- Repository validation commands are documented in README/package scripts.
