# Contributing

This repository independently maintains the [4ortytwo/hop fork](https://github.com/4ortytwo/hop) of [0genlab/hop](https://github.com/0genlab/hop). Keep upstream MIT attribution intact. Contributions to this fork do not imply acceptance upstream; related work remains tracked in [upstream PR #6](https://github.com/0genlab/hop/pull/6).

## Development setup

Use Node.js 22 or 24. Clone the maintenance branch for local development:

```bash
git clone --branch feat/maintained-release https://github.com/4ortytwo/hop.git
cd hop
node bin/hop.mjs --help
npm test
```

The maintenance changes are an unpublished candidate on `feat/maintained-release`; `main` does not yet contain them. From this maintenance checkout, also run:

```bash
npm run check:package
```

There are no npm runtime dependencies. See the READMEs for optional Git, `lsof`, and `sqlite3` enrichment and Bash requirements for CLI launching.

`npm test` exercises synthetic provider records and CLI behavior. `npm run check:package` checks the distributable package and its installed CLI using fixtures. [Hosted CI for revision `c42c1ee`](https://github.com/4ortytwo/hop/actions/runs/38647069022) passed all four macOS/Linux and Node.js 22/24 jobs, each with 126 synthetic tests and package checks. This establishes fixture and package behavior for that revision; these checks do not validate real desktop URL handlers or execution of real target CLIs.

## Changes and meaningful checks

Inspect the relevant parser, renderer, launcher, and callers before changing behavior. Keep changes bounded and preserve CLI defaults, source-store read-only access, capture permissions, and cleanup safeguards. Explain observable behavior and material limitations in the pull request. Update both READMEs when user-facing behavior changes and record release-facing changes in the changelog.

Add tests when they establish behavior or prevent a meaningful regression. Use small synthetic transcripts, identifiers, paths, workflow records, and state databases. Do not copy real chats or provider metadata into fixtures. Tests must import `test/helpers/provider-env.mjs` before application modules so `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `HOP_CLAUDE_DESKTOP_DIR`, and `HOP_DIR` point only to temporary fixture directories. Child-process tests must retain that isolation.

Run checks relevant to the change and report their actual results. If a platform, external binary, or desktop interaction cannot be checked, say what remains unverified. Desktop checks should open and inspect a draft without sending it. A build or test suite alone does not establish full app compatibility.

## Reports and privacy

Use [fork Issues](https://github.com/4ortytwo/hop/issues) for routine support reports. Private vulnerability reporting is enabled; use [SECURITY.md](SECURITY.md) for the private reporting link and fallback guidance.

When a reporting channel is available, include the Hop version, Node version, operating system, source and target client types, a minimal synthetic reproduction, and expected versus observed behavior. Include application versions when relevant. Remove personal paths, account and session identifiers, private repository names, secrets, and transcript contents from command output. Raw captures, agent bundles, provider databases, and desktop screenshots should not be attached by default. Prefer a synthetic fixture that reproduces the issue.

## Release review

Release preparation may run tests, package checks, and CI. None of these checks publishes automatically. Before publication, a human must review the exact package archive, source revision, package name and ownership, registry metadata, installation instructions, changelog, and all other public text. Rebuild and re-review the package if any reviewed input changes.

The release checklist also includes confirming that fork Issues and the private vulnerability reporting route remain available, and updating candidate branch links and checkout instructions if the maintenance changes are promoted to `main`. Retain the upstream license and distinguish this fork's support claims from upstream behavior. No registry publication should proceed while package ownership or that review is unresolved.
