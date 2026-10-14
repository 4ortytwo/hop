# Changelog

This changelog covers the independently maintained [4ortytwo/hop fork](https://github.com/4ortytwo/hop), based on [0genlab/hop](https://github.com/0genlab/hop) under the retained MIT license.

## 0.2.0 — Unreleased

### Added

- Desktop source discovery and client filtering for locally recorded Codex and Claude sessions, including available titles and Claude Desktop local ID metadata.
- `--desktop` links that open prefilled Codex or Claude Desktop drafts on macOS. The user reviews the folder and prompt and sends the draft.
- Related local agent evidence bundles with captured root and child transcripts, manifests, recovery summaries, and reconstruction descriptors. Missing records, unresolved lifecycle evidence, and recognized encrypted assignment inputs remain explicit.
- Capture registration and `hop clean` preview/confirmation, with reference checks that block unsafe deletion of selected generated artifacts.
- `--no-git` to skip Git matching and root/agent Git snapshots when project policy requires it.
- Synthetic tests for desktop discovery, URL construction, agent evidence, recovery, and cleanup, with isolated provider directories.

### Changed

- Preserve CLI destination defaults and exact recorded working directories in generated commands and draft links.
- Capture Claude child transcripts one at a time and retain raw snapshots with byte lengths and SHA-256 hashes outside the compact handoff budget.
- Inspect Git state with passive settings and explicit scope limits; look up optional Codex state-database titles using private database/WAL copies.
- Prepare fork package metadata, package checks, maintenance documentation, and a macOS/Linux CI matrix for Node.js 22 and 24. Publication requires human review of the exact package and public metadata.
- Set the minimum Node.js requirement to 22 and document platform and external-tool requirements.

### Limits

- Desktop drafts do not send prompts or migrate live agents. App URL handlers and private session formats may change.
- Encrypted delegated assignments cannot be decrypted or guaranteed recoverable. Recorded status is historical evidence, not proof of a live agent's state.
- Linux `--here` with Bash and `--dry-run` are intended support paths, with synthetic-fixture CI configured but not yet run for this candidate. New-tab and desktop launching require macOS; native Windows is unsupported.
- Fixture checks and a configured CI matrix do not establish real desktop compatibility or a successful hosted CI run. No npm registry release is announced by this unreleased entry.
