# Security policy

## Supported versions

Security fixes target the latest released version of this maintained fork. Older fork releases and upstream releases are not covered by this fork's support policy. Version 0.2.0 is currently an unreleased candidate; the policy does not imply that it has been published.

## Sensitive local data

Hop reads local provider session files and writes handoff documents, raw root and agent snapshots, recovery context, launch scripts, and a link history under `HOP_DIR` (default `~/.hop`). These files can contain code, prompts, tool output, secrets, local paths, and account or session identifiers. The bundle is not limited by `--budget`, and `--dry-run` still writes a capture.

New capture directories use mode `0700` and evidence files use `0600`; executable launch scripts use `0700`. These permissions do not encrypt data or tighten permissions on previously existing directories. Keep captures out of version control and public attachments, and inspect generated content before sharing it or sending the target draft to a provider. Hop's local collection does not call provider APIs, but starting a target CLI or sending a desktop draft can expose the handoff to that target's normal processing.

`hop clean` previews generated files by capture ID. Deletion requires `--yes` and can be blocked by retained references or unsafe evidence. Cleanup does not erase provider session stores or the link history, and it does not inspect open chats or captures in another `HOP_DIR`. Treat transcript text as untrusted input; review the receiving agent's recap and instructions before allowing work to continue.

## Reporting a vulnerability

If the fork's GitHub **Security → Report a vulnerability** option is available, use it for a private report. Otherwise, use an available repository support channel only to request a private contact channel, without vulnerability details, proof-of-concept exploit data, or secrets. Neither option is assumed to be enabled by this policy. The maintainer must verify a private reporting route before publishing a supported release; see the release checklist in [CONTRIBUTING.md](CONTRIBUTING.md).

After a private channel is established, provide the affected version, platform and Node version, expected and observed behavior, impact, and a minimal synthetic reproduction. Do not send real handoff bundles, provider databases, raw chats, or private screenshots by default. The maintainer may request narrowly scoped, redacted evidence if a synthetic example is insufficient. No personal email address or response-time guarantee is provided by this policy.
