# Contributing

This repository independently maintains the [4ortytwo/hop fork](https://github.com/4ortytwo/hop) of [0genlab/hop](https://github.com/0genlab/hop). Keep upstream MIT attribution intact. Contributions to this fork do not imply acceptance upstream; related work remains tracked in [upstream PR #6](https://github.com/0genlab/hop/pull/6).

## Development setup

Use Node.js 22 or 24. Clone the fork for local development:

```bash
git clone https://github.com/4ortytwo/hop.git
cd hop
node bin/hop.mjs --help
npm test
```

The maintenance changes are an unreleased local candidate; cloning the remote default branch does not imply it contains those changes. From a checkout containing the maintenance candidate, also run:

```bash
npm run check:package
```

There are no npm runtime dependencies. See the READMEs for optional Git, `lsof`, and `sqlite3` enrichment and Bash requirements for CLI launching.

`npm test` exercises synthetic provider records and CLI behavior. `npm run check:package` checks the distributable package and its installed CLI using fixtures. The candidate's configured hosted CI matrix uses macOS and Linux with Node.js 22 and 24; those hosted runs have not yet been performed. A configured workflow is not evidence that a hosted run passed; fixture checks do not validate a real desktop app's URL handler or the prompts it opens.

## Changes and meaningful checks

Inspect the relevant parser, renderer, launcher, and callers before changing behavior. Keep changes bounded and preserve CLI defaults, source-store read-only access, capture permissions, and cleanup safeguards. Explain observable behavior and material limitations in the pull request. Update both READMEs when user-facing behavior changes and record release-facing changes in the changelog.

Add tests when they establish behavior or prevent a meaningful regression. Use small synthetic transcripts, identifiers, paths, workflow records, and state databases. Do not copy real chats or provider metadata into fixtures. Tests must import `test/helpers/provider-env.mjs` before application modules so `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `HOP_CLAUDE_DESKTOP_DIR`, and `HOP_DIR` point only to temporary fixture directories. Child-process tests must retain that isolation.

Run checks relevant to the change and report their actual results. If a platform, external binary, or desktop interaction cannot be checked, say what remains unverified. Desktop checks should open and inspect a draft without sending it. A build or test suite alone does not establish full app compatibility.

## Reports and privacy

Use [fork Issues](https://github.com/4ortytwo/hop/issues) for routine support reports when enabled. Do not assume a private disclosure channel is available; use [SECURITY.md](SECURITY.md) for vulnerability reports.

When a reporting channel is available, include the Hop version, Node version, operating system, source and target client types, a minimal synthetic reproduction, and expected versus observed behavior. Include application versions when relevant. Remove personal paths, account and session identifiers, private repository names, secrets, and transcript contents from command output. Raw captures, agent bundles, provider databases, and desktop screenshots should not be attached by default. Prefer a synthetic fixture that reproduces the issue.

## Release review

Release preparation may run tests, package checks, and CI. None of these checks publishes automatically. Before publication, a human must review the exact package archive, source revision, package name and ownership, registry metadata, installation instructions, changelog, and all other public text. Rebuild and re-review the package if any reviewed input changes.

The release checklist also includes enabling fork Issues and verifying a private vulnerability reporting route before documenting either as available. Retain the upstream license and distinguish this fork's support claims from upstream behavior. No registry publication should proceed while package ownership or that review is unresolved.
