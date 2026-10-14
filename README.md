# hop

Carry local context for an in-progress task between **Codex** and **Claude Code**.

This is the independently maintained [4ortytwo/hop fork](https://github.com/4ortytwo/hop) of [0genlab/hop](https://github.com/0genlab/hop). Fork maintenance and release planning are tracked here. The original project and its MIT authorship remain credited; the related upstream contribution is [PR #6](https://github.com/0genlab/hop/pull/6).

Version 0.2.0 is an unreleased maintenance candidate. See [CHANGELOG.md](CHANGELOG.md) for its scope and limitations.

```bash
hop cc       # Codex → Claude Code
hop codex    # Claude Code → Codex
```

One command reads the session you were just working in and writes a handoff document. By default it opens the target CLI in a new terminal tab. Add `--desktop` to open a prefilled draft in the target desktop app; review the prompt and working directory there before sending.

[中文文档](README.zh-CN.md)

## Why

You're halfway through a task in Codex and it hits a rate limit, runs out of quota, or gets stuck in a loop. You want Claude Code to carry on, or the other way round.

Doing that by hand is tedious. You re-explain the goal, paste the last few messages, tell the new agent which branch and worktree you're on, which files were edited, what was already tried and failed, and which dev server is already running. Most of that information already exists on disk in the two tools' session logs. `hop` collects it for you.

It also has to work **when the current agent can't**. An agent that is rate-limited can't write its own handoff note. So `hop` doesn't need the source agent at all. It's a plain CLI that reads the session files directly. Inside a stuck Claude Code session you can type:

```
! hop codex
```

The `!` prefix runs a shell command without calling the model, so it works even when you're out of quota.

## Requirements

- Node.js ≥ 22; the supported LTS lines are Node.js 22 and 24
- macOS for Terminal.app/iTerm2 launching and desktop app launching
- Linux `--here` (with Bash) and `--dry-run` are intended support paths. Linux synthetic fixture and packaged CLI checks have passed on Node.js 22 and 24; desktop launching and new terminal tabs require macOS. Native Windows is unsupported.
- For the default CLI launch, the target CLI must be installed and on `PATH`. For `--desktop`, install the target desktop app; its CLI does not need to be installed. Source transcripts must be available locally.

There are no npm runtime dependencies. External tools provide these capabilities:

| Tool | When needed |
|---|---|
| Bash | CLI launching, including `--here` |
| Git | Installing from GitHub, repository-wide session matching, and Git snapshots; captures can run without Git. `--no-git` explicitly skips matching and snapshots. |
| `lsof` | Optional discovery of listening processes; if unavailable or blocked, the listener list can be empty and must not be treated as proof that no server is running. |
| `sqlite3` | Optional lookup of Codex titles absent from the session index; missing metadata does not hide local sessions. |

Provider session formats and desktop URL handlers can change independently of Hop. Synthetic fixture and package checks have passed in hosted CI on macOS and Linux with Node.js 22 and 24. These checks cover local parsing and command construction; they do not validate real desktop URL handlers or execution of real target CLIs.

## Install

The maintained npm package is `@4ortytwo/hop`; its executable is `hop`. The first release is being prepared and has not been published yet. From a reviewed checkout containing this candidate, install locally:

```bash
npm install -g .
hop --help
```

After the first npm release is published, choose one package manager to install it globally:

| Package manager | Command |
|---|---|
| npm | `npm install -g @4ortytwo/hop` |
| [Bun](https://bun.sh/docs/pm/cli/add#--global) | `bun add -g @4ortytwo/hop` |
| [pnpm](https://pnpm.io/cli/add#--global--g) | `pnpm add -g @4ortytwo/hop` |
| [Yarn Classic (1.x)](https://classic.yarnpkg.com/en/docs/cli/global) | `yarn global add @4ortytwo/hop` |

The selected manager's global executable directory must be on `PATH`. Installing with Bun does not change Hop's runtime: Node.js 22 or later is still required.

[Modern Yarn (2+)](https://yarnpkg.com/cli/dlx) uses `dlx` for temporary execution instead of a global installation. For example:

```bash
YARN_NODE_LINKER=node-modules yarn dlx --package @4ortytwo/hop hop --help
```

This runs Hop once; it does not leave a permanent `hop` command on `PATH`.

## Usage

### Switch

Run it from the project directory you were working in:

```bash
hop cc        # continue the latest Codex session here in Claude Code
hop codex     # continue the latest Claude Code session here in Codex
```

`hop` prints what it picked: the source session, working directory and branch, the path to the handoff document (turn count and size), and the command to resume the original session. Synthetic example:

```
Source    Codex session-example (current dir /path/to/demo)
Workdir   /path/to/demo/.worktrees/example  [example]
Handoff   ~/.hop/handoffs/<capture-stem>.md (12 turns, 31.8 KB)
Go back   codex resume session-example
```

Then it opens a new tab and starts the target agent with this prompt:

> Task handoff "<task name>": Read `<handoff file>` and take over this task: following "Notes for the receiving agent" in that file, first restate the current state in 5 lines or fewer, then wait for my confirmation before continuing.

The task name is the source session's title (a Claude Code `/rename` name wins over its auto title; for Codex, the thread name), or the first user message if there is none. Claude Code is started with `--name "<task name> (from Codex)"`. Codex has no flag for naming a session, so the name only reaches it through the prompt, which its auto-generated thread name usually follows.

Always check the recap before you let the agent continue.

### Open a desktop draft

The CLI remains the default destination. To open the corresponding desktop app instead:

```bash
hop cc --desktop       # Codex → Claude Desktop
hop codex --desktop    # Claude Code → Codex Desktop
```

`--desktop` uses the app's URL scheme to open a new local session with the handoff prompt prefilled. It does not send the prompt. The URL carries the prompt and local handoff-file path, not the transcript contents. Review the draft and send it yourself. These links follow [Claude Desktop's link guide](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link) and the [Codex desktop deep-link reference](https://learn.chatgpt.com/docs/reference/commands).

Claude Desktop treats a linked folder as untrusted and asks you to confirm it. Confirm the folder, choose **Local environment**, and turn worktree isolation off if you want to use the existing checkout. Claude Desktop may resolve a path under `.claude/worktrees/` to its parent repository. `hop` warns about this and includes the exact path in the draft, but the app may still change it; use the CLI when the original directory must be enforced.

`hop cc --desktop --dry-run` or `hop codex --desktop --dry-run` writes the handoff and prints the desktop URL without opening the app. `--desktop` cannot be combined with `--here` or arguments after `--`.

### Pick a specific session

`hop` matches sessions by the current directory, using the git root, so any session started anywhere in the repo counts. If several sessions were active in the last 10 minutes, it prints a warning. In that case, choose one explicitly:

```bash
hop cc --list                  # show session ID, client, cwd and available title
hop cc --session session-example   # synthetic ID; replace with your ID or .jsonl path
hop codex --session local_example  # synthetic Claude Desktop source ID
hop cc --latest                # ignore the directory; take the newest session anywhere
```

If no session matches the current directory, `hop` falls back to the newest session anywhere.

Use `--source all|cli|desktop` to filter by source client; the default is `all`. For Codex, app sessions identified as Codex Desktop match `desktop`. Other records marked `vscode` remain available with `all` and are shown as `[vscode]`.

Codex names come from its local session index, with an optional read-only `sqlite3` lookup for titles stored only in the app's state database. Missing title metadata never hides a session.

### Clean up saved handoffs

```bash
hop clean --list              # list registered captures and their capture IDs
hop clean <capture-id>        # preview the exact generated files; nothing is deleted
hop clean <capture-id> --yes  # permanently remove that capture after you finish using it
```

Each hop gets its own capture ID, even when it uses the same source session again. The cleanup list shows the capture ID, available title, source session ID, working directory and handoff path; use the **capture ID** to choose what to remove. The source session ID and title are for identification, not cleanup selectors.

Cleanup removes only the selected generated handoff, its flat agent bundle and its associated launch script when present. It leaves provider session logs, project files and the small `links.jsonl` history untouched. Unregistered files, unassociated older launch scripts and abandoned `.capture-*` staging directories are not swept automatically.

Before deletion, Hop scans other retained, registered captures and recognized unindexed handoffs in the same `HOP_DIR`, including raw evidence, for references to the selected handoff. A reference blocks deletion; unsafe, incomplete or unreadable evidence also blocks cleanup. The scan does not inspect provider logs, open chats or another `HOP_DIR`, so finish using those contexts before confirming deletion. Large archives can make the reference scan take time.

### Skip Git inspection

Use `--no-git` when project policy forbids Git commands. It skips Git-based source-directory matching and both root and agent Git snapshots. The handoff marks Git state as uninspected. Since source matching then uses the current directory, prefer an explicit `--session` when the source uses a subdirectory or worktree:

```bash
hop codex --session local_example --desktop --no-git
```

### Other options

| Option | Effect |
|---|---|
| `--list` | List candidate source sessions with session ID, client, working directory and available title, then exit |
| `--session <id>` | Use this source session (transcript UUID, Claude Desktop `local_<id>`, or `.jsonl` path) |
| `--latest` | Ignore the current directory and take the newest session globally |
| `--dry-run` | Write the handoff without opening the target; with `--desktop`, also print its URL |
| `--here` | Launch in the current terminal instead of a new tab |
| `--desktop` | Open a prefilled draft in the target desktop app; review and send it there |
| `--no-git` | Skip Git matching and snapshots; use the current directory for matching and mark Git state uninspected |
| `--source <client>` | Filter source sessions: `all` (default), `cli`, or `desktop` |
| `--days <n>` | How far back to search, default 14 |
| `--budget <KB>` | Compact handoff size target in KB, default 48 |
| `-- <args>` | Pass the remaining args to the target CLI, e.g. `hop cc -- --model opus`; unavailable with `--desktop` |

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `HOP_TERMINAL` | `iterm` if iTerm is installed, else `terminal` | `iterm` or `terminal` (Terminal.app) |
| `HOP_CLAUDE_BIN` | `claude` | Claude Code executable |
| `HOP_CODEX_BIN` | `codex` | Codex executable |
| `HOP_DIR` | `~/.hop` | Where handoffs, launch scripts, and the link log go |
| `HOP_LANG` | from `LC_ALL` / `LC_MESSAGES` / `LANG` | `en` or `zh`: language of CLI output, handoff document and launch prompt |
| `CODEX_HOME` | `~/.codex` | Respected when locating Codex sessions |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Respected when locating Claude Code sessions |
| `HOP_CLAUDE_DESKTOP_DIR` | `~/Library/Application Support/Claude` | Claude Desktop app-data root used to match local desktop IDs to transcripts; metadata is under `claude-code-sessions/` |

### Going back

The original session is left untouched. `hop` prints a native return link for Codex Desktop sessions and for Claude Desktop sessions when their local ID metadata is available; it also prints a CLI resume command as a fallback. Claude's continuation URL is a private app route and may change. For Claude Desktop, missing local ID metadata or an archived session leaves only the CLI resume command. Each hop is appended to `~/.hop/links.jsonl` with its source and destination clients. Newly generated handoff and link-log files use mode `0600`; `hop` does not modify the source session store.

## What gets carried over

Generated handoffs and raw evidence can contain source code, prompts, tool output, secrets, and local identifiers. Keep captures private and review them before sharing or sending a draft to another provider. File permissions are access controls, not encryption. `--dry-run` still writes a capture. See [SECURITY.md](https://github.com/4ortytwo/hop/blob/main/SECURITY.md) for reporting guidance.

The handoff document is Markdown and contains:

- **Instructions for the receiving agent**: read the agent index when present, recap the root state and unfinished delegated work, then wait for confirmation. Reuse recorded results, read relevant agent context before touching its files, and verify the source agent has stopped writing before recreating an assignment. Grep the raw transcript for details; don't reset uncommitted changes; earlier constraints still apply.
- **Open failures**: shell commands whose last run in the source session still failed (non-zero exit, or cut off mid-run), with exit code, turn, time, cwd and the tail of the output. Only test/build/lint commands and failures in the final turn are listed; commands that later passed, and grep/diff-style exit 1, are left out. The new agent is told to rerun them first: still failing means it's the work in hand, passing means the note is stale. This section is never compressed.
- **Source session**: tool, session ID, model, permission/sandbox mode, and the path to the raw JSONL transcript.
- **Environment snapshot**: working directory, branch, HEAD, upstream ahead/behind, `git status`, diff stat, recent commits, worktrees, stashes, and processes listening on TCP ports whose cwd is inside the project (so the new agent doesn't start a second dev server).
- **Conversation**: your instructions, messages you sent mid-task (often course corrections, so they're highlighted), the assistant's replies, tool calls with truncated output, and plaintext reasoning when it exists. If the session was compacted, the compaction summary is included too.
- **Subagent handoff bundle**: normal `hop cc` / `hop codex` runs, including `--desktop` in either direction, automatically collect related local agent traces when available. The compact handoff links to the sibling `<handoff-stem>.agents/index.md`. The bundle contains captured raw root and child transcript snapshots, a manifest, and per-agent Markdown and JSON context with available assignments, follow-ups, collaboration results and arguments, parent links, and status evidence. Complete conversation and ordinary tool data remain in the raw snapshots; Claude agent context files do not duplicate those bodies. The root snapshot is retained even when no child agents are found. The bundle is separate from `--budget` and is never truncated by it. Its directory/files are created with modes `0700`/`0600`; it may be large. Use `hop clean --list` to find captures, preview a capture with `hop clean <capture-id>`, and remove it with `--yes` when it is no longer needed. Collection reads local files only, makes no provider calls, and does not change the source session store. Missing or unreadable logs are called out as warnings; a missing child transcript remains an explicit stub.

The renderer tries six levels of detail to approach the `--budget` target. It always retains the guide and latest turn, and keeps open failures uncompressed, so a very small target or lengthy required sections can make the compact handoff exceed the target. The companion bundle is separate and is never truncated by `--budget`. Recent turns retain more detail than older turns, which are compressed step by step down to one-line summaries; the latest turn is always kept.

Claude child transcripts are captured and interpreted one file at a time. Memory scales with the largest decoded transcript plus retained collaboration evidence, rather than the whole raw child tree. Captures use private staging files that are cleaned up after publication or a handled failure. Published disk snapshots include byte lengths and SHA-256 hashes.

The bundle's `recovery.md` lists recorded noncompleted agents and contexts requiring reconciliation. Each agent has a reconstruction descriptor linking its captured inputs, corrections, results, raw progress, working directory and parent/children. Manifest version 2 maps original source paths to bundled snapshots, so those references remain usable after the original logs are removed. The CLI distinguishes recorded noncompleted states from contexts with warnings; neither count is a restart queue. A completed parent does not hide unfinished children, and a historical relationship or similar agent name does not prove an assignment was superseded. Before restarting closed or interrupted work, check its earlier results. Missing logs and unresolved lifecycle evidence remain explicit rather than being guessed complete.

The worktree and uncommitted changes aren't copied, merged, or deleted; they stay on disk. The bundle records each agent's working directory and whether it exists locally; for local Git worktrees it also records the branch, HEAD, and status. A missing working directory is recorded as a warning. Before recreating unfinished assignments, check that the source agents have stopped editing the same files. CLI targets start in the root session's directory; for desktop targets, check the app's folder and worktree options before sending.

Git snapshots disable filesystem-monitor hooks, content filters, external diff tools and optional index refresh. They inspect the main worktree without uncommitted submodule contents; the handoff labels this scope rather than claiming the whole checkout is clean. Projects with custom content normalization may show different raw-file changes. Git support for `--config-env` is needed to override configured content filters; if safe filter inspection fails, working-tree status is left unavailable.

> CLI messages, the handoff document and the launch prompt follow your locale: Chinese when `LANG`/`LC_ALL` is `zh_*`, English otherwise. Set `HOP_LANG=en` or `HOP_LANG=zh` to override.

## What doesn't carry over

- **Encrypted delegated instructions.** Some Codex Desktop versions store subagent assignment and follow-up text encrypted in local logs. Hop preserves that evidence but cannot decrypt it or guarantee recovery of the exact instructions. Recognized opaque inputs require reconstruction review; readable progress or an older brief does not establish the contents of a missing correction. Before recreating that work, find a complete readable brief in the captured context or obtain the missing scope from the user. This also applies when hopping back to Claude.
- **Full reasoning.** Codex sessions on OpenAI models store reasoning encrypted, with only a short summary title. Claude Code usually stores thinking blocks as a signature with empty text. Codex sessions that run through a third-party provider do have plaintext reasoning, and that gets included.
- **Running processes.** Dev servers and watchers can't be moved. They're listed so the new agent knows about them.
- **Shell state.** Variables you `export`ed inside the session, activated virtualenvs, and so on.
- **Live agent execution.** The bundle is evidence for a handoff, not migration of live agents. Statuses are last recorded observations, not proof of completion or a live process check. Native agent IDs, APIs and tools, models, permissions, custom agent definitions, runtime state, and memory do not transfer automatically. Historical or unlinked agents need a relevance check before restarting; remote or unlogged data cannot be recovered.
- **Top-level source discovery.** `codex exec`, `claude -p` / SDK sessions, and subagent sessions are not selected as standalone source sessions. Related child agents of the selected interactive session can still appear in its bundle.

## How it works

1. **Find the source session.**
   - Codex: local `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` files. `hop` checks file modification time across creation-date folders, so an older thread that was active recently can still be found. It identifies Codex Desktop by its recorded originator; other `vscode` records are included with `--source all` and displayed as `[vscode]`.
   - Claude Code: local `~/.claude/projects/<slug>/<id>.jsonl` transcripts (or the equivalent under `CLAUDE_CONFIG_DIR`) whose entrypoint is `cli` or `claude-desktop`. For desktop sessions, optional metadata under `HOP_CLAUDE_DESKTOP_DIR/claude-code-sessions/<account>/<org>/local_*.json` maps the app's `local_<id>` to the ordinary transcript ID and adds desktop details. This metadata does not replace the transcript.
   - Only transcripts already on disk are read. `hop` does not fetch cloud, SSH, VM, or Cowork transcripts.
2. **Parse the root transcript.**
   - Codex: `response_item` records are grouped into turns. Content Codex injects into the user role (`<environment_context>`, AGENTS.md, and similar) is dropped. Tool calls are paired with their outputs by `call_id`. A `compacted` record resets the history.
   - Claude Code: `hop` walks `parentUuid` back from the latest non-sidechain message, so branches you rewound past are excluded. It restores slash commands and filters system reminders and notifications.
3. **Collect related agent traces.** The selected root remains a human-interactive session; child sessions are collected as related evidence rather than standalone source candidates. For Codex, parent metadata links children recursively across active and archived sessions, with recorded collaboration messages and status. For Claude Code/Desktop, collection uses standard `Agent`/`Task` assignments, sidechain transcripts, agent metadata and nested parent IDs, plus local desktop workflow journals and reports. Queued Claude Desktop task chips without a child transcript association are kept as warned stubs; arbitrary team or cloud tasks cannot be recovered. Only local records are read, with no provider calls or source-store changes.
4. **Snapshot the environment.** Git and `lsof` add optional repository and listener information; unavailable tools leave gaps.
5. **Render** the compact handoff to `~/.hop/handoffs/`, trying six detail levels to approach `--budget`, and write the companion evidence bundle beside it. The bundle is not counted or truncated by `--budget`.
6. **Launch** the target CLI through a small script in `~/.hop/run/`, opened in a new iTerm2 or Terminal tab via AppleScript; with `--desktop`, open a URL that prefills the target app's composer instead.

Both session formats are private and undocumented, and either tool may change them in any release. If parsing breaks after an upgrade, look at `lib/codex.mjs` and `lib/claude.mjs` first.

## Troubleshooting

- **The wrong session was picked.** Run `hop cc --list`, then `--session <id>`.
- **"No session found".** Try `--latest` or `--days 60`. Also check that `CODEX_HOME` / `CLAUDE_CONFIG_DIR` point to where your sessions actually live.
- **No new tab opens.** macOS may be blocking automation. Allow your terminal under *System Settings → Privacy & Security → Automation*, or use `--here`.
- **The desktop app does not open.** Desktop launching requires macOS and the target app installed with its URL scheme registered. `--dry-run --desktop` still prints the link for inspection.
- **Claude Desktop shows a different folder.** Confirm the linked folder before sending. Paths under `.claude/worktrees/` may be resolved to the parent repository; use the CLI if the original worktree must be enforced.
- **Codex starts in the wrong directory.** `hop` passes `-C <cwd>` to Codex and `cd`s into the directory before starting Claude Code. Check the `Workdir` line in the output. It uses the session's latest cwd.

## Development

See [CONTRIBUTING.md](https://github.com/4ortytwo/hop/blob/main/CONTRIBUTING.md) for setup, synthetic fixtures, package checks, and release review policy.

```bash
npm test
```

```
bin/hop.mjs        CLI entry
lib/codex.mjs      Codex session discovery + parsing
lib/claude.mjs     Claude Code session discovery + parsing
lib/codex-agents.mjs Codex child-session collection
lib/claude-agents.mjs Claude agent and desktop workflow collection
lib/subagents.mjs  agent evidence bundle generation
lib/artifacts.mjs  capture registration and safe cleanup
lib/recovery.mjs   agent recovery context generation
lib/assignment-input.mjs readable and opaque assignment classification
lib/snapshot.mjs   git / listening-port snapshot
lib/render.mjs     handoff document + size budget
lib/launch.mjs     launch script + terminal tab
```

## Roadmap

- An in-session command that lets the source agent write its own, richer handoff while it still works
- Resume the original session with an incremental handoff when you hop back
- Linux new-terminal-tab launching

## License

MIT. The [LICENSE](LICENSE) retains the upstream copyright notice for 0genlab.
