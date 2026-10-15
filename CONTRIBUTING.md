# Contributing

This repository independently maintains the [4ortytwo/hop fork](https://github.com/4ortytwo/hop) of [0genlab/hop](https://github.com/0genlab/hop). Keep upstream MIT attribution intact. Contributions to this fork do not imply acceptance upstream; related work remains tracked in [upstream PR #6](https://github.com/0genlab/hop/pull/6).

Version 0.2.0 remains an unpublished candidate on `main`. Git installation is the current installation path.

## Development setup

Use Node.js 22 or 24. Clone the repository's default branch for local development:

```bash
git clone https://github.com/4ortytwo/hop.git
cd hop
node bin/hop.mjs --help
npm test
```

The maintained code is on `main`. From this checkout, also run:

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

Release preparation may run tests, package checks, and CI. These are manual release gates; current CI never publishes. Before publication, a human must review the exact package archive, source revision, package name and ownership, registry metadata, installation instructions, changelog, and all other public text. Rebuild and re-review the package if any reviewed input changes.

The release checklist also includes confirming that fork Issues and the private vulnerability reporting route remain available. Retain the upstream license and distinguish this fork's support claims from upstream behavior. No registry publication should proceed while package ownership or that review is unresolved.

### npm launch gate

Complete this mandatory checklist when preparing npm publication. Publication is postponed until the before-publication gate passes and the user explicitly approves publishing.

Before publication:

- [ ] Verify the intended npm identity, its verified email, and two-factor authentication for write operations; confirm control of the `@4ortytwo` scope and permission to create or update `@4ortytwo/hop`.
- [ ] Prepare both READMEs with the registry commands below as the primary installation path. Retain Node.js 22+, global executable `PATH`, Bun runtime, and modern Yarn guidance; move Git installation to a secondary alternative. Remove temporary unpublished notices from both READMEs, SECURITY.md, CHANGELOG.md, and this guide only in the reviewed publication candidate.
- [ ] Review the exact source revision and package archive, package contents and privacy, public registry metadata, installation instructions, and release text. Confirm fork Issues and private vulnerability reporting still work, and retain upstream MIT attribution. Rebuild and re-review if any input changes.
- [ ] Run relevant tests and package checks and confirm CI passes for the intended source revision.
- [ ] Obtain explicit user approval for npm publication. Only then perform the authorized `npm publish --access public` operation; publishing is a registry write, not a validation check.

The future primary registry installation commands are:

| Package manager | Command |
|---|---|
| npm | `npm install -g @4ortytwo/hop` |
| Bun | `bun add -g @4ortytwo/hop` |
| pnpm | `pnpm add -g @4ortytwo/hop` |
| Yarn Classic (1.x) | `yarn global add @4ortytwo/hop` |

For modern Yarn (2+), document temporary execution with `YARN_NODE_LINKER=node-modules yarn dlx --package @4ortytwo/hop hop --help`; it does not leave a permanent `hop` command on `PATH`.

After authorized publication, before announcing the release:

- [ ] Verify the public npm registry reports the intended package name, version, public access, and dist-tag. Confirm the published archive matches the reviewed package.
- [ ] Install the published version from the registry into a throwaway prefix, then run the installed `hop --help` using Node.js 22 or later. Record the outcome before announcing the release.
