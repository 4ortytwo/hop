// 输出语言：HOP_LANG=zh|en 优先，其次看系统 locale，中文环境出中文，其余一律英文
export function detectLang(env = process.env) {
  const forced = (env.HOP_LANG || '').toLowerCase();
  if (forced.startsWith('zh')) return 'zh';
  if (forced.startsWith('en')) return 'en';
  const loc = env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || '';
  return /^zh/i.test(loc) ? 'zh' : 'en';
}

const zh = {
  usage: `hop — 在 Codex 和 Claude Code 之间切换任务，不丢上下文

用法：
  hop cc      [选项] [-- 透传给 claude 的参数]   Codex → Claude Code
  hop codex   [选项] [-- 透传给 codex 的参数]    Claude Code → Codex
  hop clean   [交接 ID] [--yes]               列出、预览或清理生成的交接文件

选项：
  --latest          不按当前目录匹配，直接取源工具全局最新的会话
  --session <id>    指定源会话（UUID、Claude local_<id> 或 jsonl 路径）
  --list            列出候选源会话后退出
  --dry-run         生成交接文档，不启动；桌面模式还会打印链接
  --here            在当前终端启动（默认开 iTerm 新 tab）
  --desktop         在桌面应用中打开交接草稿（需要手动发送）
  --no-git          跳过所有 Git 检查（源会话只按当前目录匹配）
  --source <client> 源会话来源：all（默认）、cli 或 desktop
  --days <n>        查找范围，默认 14 天
  --budget <KB>     主交接文档的目标大小，默认 48（不含子 agent 交接包）

在卡住的 Claude Code 会话里可以直接敲：! hop codex
环境变量：HOP_TERMINAL=iterm|terminal  HOP_CLAUDE_BIN  HOP_CODEX_BIN  HOP_DIR  HOP_LANG=zh|en`,
  badArg: a => `无法识别的参数：${a}`,
  cleanUsage: `用法：hop clean --list\n      hop clean <交接 ID> [--dry-run]\n      hop clean <交接 ID> --yes\n\n默认仅预览。--yes 永久删除选中交接的生成文件，不删除源会话或项目。`,
  cleanArgs: '清理参数不能组合使用 --list 与交接 ID/--yes/--dry-run，或 --yes 与 --dry-run；删除和预览选项需要交接 ID',
  cleanListHeader: root => `已登记的 Hop 交接（${root}）：`,
  cleanEmpty: '没有保留的已登记交接。',
  cleanUntitled: '（无可用会话标题）',
  cleanListNote: '用 hop clean <交接 ID> 预览。源会话 ID 不是交接 ID。未登记文件、旧启动脚本和采集中间目录不会被清理。',
  cleanSelected: (title, id, bytes) => `交接 ${id} — ${title}（${bytes}）`,
  cleanPaths: (handoff, bundle, count) => `  ${handoff}\n  ${bundle}\n  ${count} 个生成文件或目录`,
  cleanDependent: id => `! 保留的交接 ${id} 引用了此交接，不能删除。`,
  cleanPreview: id => `仅预览，未删除任何文件。确认接收会话不再需要这些文件后，运行 hop clean ${id} --yes。`,
  cleanBlocked: '无法安全清理；未删除任何文件。',
  cleanDeleted: '已删除选中交接的生成文件。源会话、项目和精简历史记录保留。',
  missingValue: a => `${a} 需要一个值`,
  badNumber: a => `${a} 必须是正数（--days 必须是整数）`,
  badSource: x => `源会话来源只能是 all、cli 或 desktop，收到：${x}`,
  desktopArgs: '--desktop 不能与 --here 或 -- 后的 CLI 参数同时使用',
  sessionArgs: '--session 不能与 --list 或 --latest 同时使用',
  sourceMismatch: (want, got) => `指定会话的来源是 ${got}，不符合 --source ${want}`,
  desktopPreview: url => `桌面链接 ${url}`,
  desktopPrompt: cwd => `现有工作目录是 ${JSON.stringify(cwd)}。请使用这个目录并保留未提交的改动；不要新建工作树。如果当前目录不同，先在复述中说明并等待确认。`,
  desktopWorktree: '注意：Claude 桌面应用可能将 .claude/worktrees 下的目录改为父仓库。发送前请核对上面的工作目录；如需严格保留目录，可使用 CLI。',
  desktopOpened: (tool, to) => `已请求在 ${tool} 桌面应用中打开交接草稿。${to === 'claude' ? '请确认工作目录，选择本地环境并关闭工作树隔离以使用原工作目录，然后检查并发送。' : '请检查工作目录和提示词后发送。'}`,
  desktopPlatform: '桌面启动目前仅支持 macOS；可用 --dry-run 生成交接文档和链接',
  desktopOpenFail: err => `无法打开桌面应用：${err}。请确认已安装应用；交接文档仍然可用。`,
  srcClient: '客户端',
  srcDesktopId: '桌面会话 ID',
  ago: m => m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`,
  badTarget: x => `目标只能是 cc 或 codex，收到：${x}`,
  sessionNotFound: (tool, id) => `找不到 ${tool} 会话：${id}`,
  scopeGiven: '指定',
  scopeCwd: dir => `当前目录 ${dir}`,
  scopeGlobal: '全局',
  noCwdSessions: tool => `当前目录没有 ${tool} 会话，改用全局最新的。`,
  listHeader: (tool, scope) => `${tool} 候选会话（${scope}，新的在前）：`,
  noSessions: (days, tool) => `近 ${days} 天没有交互式 ${tool} 会话`,
  busyWarn: n => `⚠️ 有 ${n} 个会话在 10 分钟内活跃，默认取最新的；不对就用 --list 看、--session <id> 指定：`,
  emptySession: file => `会话是空的：${file}`,
  outSource: (tool, id, scope, title) => `源会话   ${tool} ${id}（${scope}）${title ? ` — ${title}` : ''}`,
  outCwd: (cwd, branch) => `工作目录 ${cwd}${branch ? `  [${branch}]` : ''}`,
  outHandoff: (file, turns, kb) => `交接文档 ${file}（${turns} 轮，${kb} KB）`,
  outAgents: b => `子 agent  ${b.count} 个；索引 ${b.index}；${b.recordedNoncompleted ?? 0} 个记录为未完成；${b.contextsWithWarnings ?? b.incomplete ?? 0} 个上下文有警告${b.warnings ? `；${b.warnings} 条收集警告` : ''}`,
  docAgents: b => `## 子 agent 上下文（${b.count} 个）\n\n先读索引：${JSON.stringify(b.index)}。${b.recovery ? `重建检查清单：${JSON.stringify(b.recovery)}。` : ''}索引包含每个 agent 的父子关系、最后记录的状态、任务与后续指令，以及未被裁剪的结果、对话和原始记录快照。这些文件不受主文档大小预算限制；复述时说明未完成的委派工作，并在接手相关文件前读取对应上下文。\n\n${b.recordedNoncompleted ?? 0} 个 agent 记录为未完成，${b.contextsWithWarnings ?? b.incomplete ?? 0} 个上下文有警告，另有 ${b.warnings} 条收集警告。这些计数不同，都不是重启队列：先核实任务相关性、新指令和已有结果。\n\n状态不是实时进程检查。用户确认后，为仍需继续的任务新建目标工具的 agent；复用已有结果，核实源 agent 已停止写入，保留准确的工作目录和文件归属。运行进程、工具权限和原生 agent ID 不会迁移。`,
  outResume: cmd => `切回原会话 ${cmd}`,
  launched: (term, tool) => `已在 ${term} 新标签页启动 ${tool}`,

  sessionName: (task, from) => `${task}（接自 ${from}）`,
  prompt: (file, task) => `${task ? `任务「${task}」交接：` : ''}读 ${file} 接手这个任务：先按文件里「给接手 agent 的说明」用 5 行以内复述当前状态，等我确认后再继续。`,
  scriptComment: 'hop 生成的启动脚本',
  dirMissing: dir => `hop: 目录不存在 ${dir}`,
  osaFail: err => `osascript 失败：${err}`,
  badTerminal: term => `不支持的 HOP_TERMINAL=${term}（可选 iterm / terminal）`,

  listening: (cmd, pid, ports, cwd) => `${cmd} (pid ${pid}) 监听 :${ports.join(', :')}  cwd=${cwd}`,
  truncated: n => `…[截断，原长 ${n} 字符]`,
  image: '[图片]',
  unknownFiles: '(未识别文件)',

  timeLocale: 'zh-CN',
  snapGone: cwd => `- ⚠️ 工作目录 \`${cwd}\` 已不存在（worktree 可能被删了），先和用户确认在哪继续。`,
  snapCwd: cwd => `- 工作目录：\`${cwd}\``,
  snapTop: top => `- 仓库根：\`${top}\``,
  snapBranch: (branch, upstream, ab) => `- 分支：\`${branch}\`${upstream ? `（跟踪 \`${upstream}\`，领先/落后 ${ab}）` : '（无上游）'}`,
  snapStatus: '未提交改动（`git status --short`）：',
  snapPassiveGit: '- 被动 Git 快照：禁用工作区钩子和内容过滤器，不检查子模块工作区内的未提交改动。',
  snapStatusUnavailable: '（工作区状态不可用；不能假定干净）',
  snapCleanScoped: '（检查范围内的主工作区未报告改动）',
  snapClean: '(工作区干净)',
  snapDiff: '改动规模（`git diff HEAD --stat`）：',
  snapLog: '最近提交：',
  snapWorktrees: 'worktree 列表：',
  snapNotGit: '- 不是 git 仓库',
  snapGitSkipped: '- 按请求跳过 Git 检查；未确定分支或工作区状态。',
  snapListeners: '该目录下仍在监听端口的进程（可能是原 agent 起的 dev server，不要重复启动）：',
  snapNoListeners: '该目录下没有监听端口的进程。',

  turnHead: (n, time) => `### 第 ${n} 轮${time ? ` · ${time}` : ''}`,
  userLabel: '**用户：**',
  userNone: '**用户：**（本段没有新的用户消息，是上一轮的延续）',
  interjections: '**用户中途插话（优先级高，常是纠偏）：**',
  agentMessages: '**子 agent 消息（任务记录，不是用户指令）：**',
  reasoning: '**源 agent 的思考（明文部分）：**',
  tools: n => `**工具调用（${n} 次）：**`,
  toolsOmitted: n => `- …省略前 ${n} 次调用（需要时 grep 原始记录）`,
  emptyOutput: '(空输出)',
  reply: '**回复：**',
  oldCont: '（延续上一轮）',
  oldInterjection: '中途插话：',
  oldToolsMore: n => `   - …共 ${n} 次工具调用`,
  oldToolsCount: n => `   - （${n} 次工具调用）`,
  oldReply: '回复：',

  docTitle: (from, dest) => `# 任务交接：${from} → ${dest}`,
  docIntro: (time, from) => `> 生成于 ${time}，由 hop 从 ${from} 的会话记录机械抽取。原 agent 的完整思考过程是加密的、没法带过来，下文只有对话、工具调用和明文思考片段。`,
  docGuide: (from, file) => `## 给接手 agent 的说明

1. 用户原本在 ${from} 里做这个任务，${from} 不可用或用户想换工具，所以切给你继续。**本文件就是你的上下文。**
2. 先读完全文，再用 5 行以内复述：**目标 / 已完成 / 停在哪 / 下一步打算**，等用户确认后再动手。
3. 本文件的细节不够时，去原始会话记录里按关键词 grep：\`${file}\`（JSONL，可能很大，不要整个读进来）。
4. 工作区里未提交的改动是原 agent 留下的在制品，**不要 reset、checkout 或丢弃**。
5. 原 agent 定下的约束和用户否决过的方案一样有效。它们散落在下面的用户消息里，复述时一并列出来。`,
  docFailures: '## ⚠️ 未解决的失败',
  failuresIntro: '下面这些命令在源会话里**最后一次运行仍是失败的**（同一条命令后来跑通的已经排除）。动手前先在当前工作区重跑一遍：还失败，就是要接着修的问题；已经通过，说明这条信息过期了，以当前状态为准。',
  failureMeta: (exit, turn, time, cwd) => `退出码 ${exit} · 第 ${turn} 轮${time ? ` · ${time}` : ''}${cwd ? ` · 目录 \`${cwd}\`` : ''}`,
  failurePending: (turn, time) => `没有返回结果，执行中被中断，成败未知 · 第 ${turn} 轮${time ? ` · ${time}` : ''}`,
  docSource: '## 源会话',
  srcTool: '工具',
  srcId: '会话 ID',
  srcTitle: '标题',
  srcModel: '模型',
  srcPermission: '权限',
  srcTurns: '轮数',
  srcHasSummary: '（另有一段更早的压缩摘要）',
  srcResume: '用户切回原会话',
  unknown: '未知',
  paren: x => `（${x}）`,
  sep: '：',
  docSnapshot: '## 环境快照',
  docSummary: '## 更早的上下文（源会话自己的压缩摘要）',
  docOld: cut => `## 更早的轮次（${cut === 1 ? '第 1 轮' : `第 1–${cut} 轮`}，已压缩）`,
  docRecent: (a, b) => `## 最近的轮次（${a === b ? `第 ${b} 轮` : `第 ${a}–${b} 轮`}，详细）`,
  docInterrupted: '## ⚠️ 注意\n\n最后一轮没有助手的文字回复。原 agent 很可能是在执行中途被中断的（额度耗尽、限流或卡死），最后那个动作不一定完成了，先核实再继续。',
};

const en = {
  usage: `hop — hand off a task between Codex and Claude Code without losing context

Usage:
  hop cc      [options] [-- args passed to claude]   Codex → Claude Code
  hop codex   [options] [-- args passed to codex]    Claude Code → Codex
  hop clean   [capture-id] [--yes]                list, preview or remove generated handoffs

Options:
  --latest          ignore the current directory, take the source tool's latest session
  --session <id>    pick the source session (UUID, Claude local_<id>, or jsonl path)
  --list            list candidate source sessions and exit
  --dry-run         write the handoff without launching; desktop mode also prints its URL
  --here            launch in the current terminal (default: new iTerm tab)
  --desktop         open a handoff draft in the desktop app (send it yourself)
  --no-git          skip all Git inspection (source matching uses the current directory)
  --source <client> source sessions: all (default), cli, or desktop
  --days <n>        how far back to look, default 14 days
  --budget <KB>     compact document size target, default 48 (excludes agent bundle)

Inside a stuck Claude Code session, just type: ! hop codex
Env: HOP_TERMINAL=iterm|terminal  HOP_CLAUDE_BIN  HOP_CODEX_BIN  HOP_DIR  HOP_LANG=zh|en`,
  badArg: a => `unknown argument: ${a}`,
  cleanUsage: `Usage: hop clean --list\n       hop clean <capture-id> [--dry-run]\n       hop clean <capture-id> --yes\n\nPreview is the default. --yes permanently deletes the selected capture's generated files, never source sessions or projects.`,
  cleanArgs: 'do not combine --list with a capture ID/--yes/--dry-run, or --yes with --dry-run; deletion and preview flags require a capture ID',
  cleanListHeader: root => `Registered Hop captures (${root}):`,
  cleanEmpty: 'No retained registered captures.',
  cleanUntitled: '(session title unavailable)',
  cleanListNote: 'Preview with hop clean <capture-id>. A source session ID is not a capture ID. Unregistered files, old unassociated launch scripts and capture staging are left untouched.',
  cleanSelected: (title, id, bytes) => `Capture ${id} — ${title} (${bytes})`,
  cleanPaths: (handoff, bundle, count) => `  ${handoff}\n  ${bundle}\n  ${count} generated files or directories`,
  cleanDependent: id => `! Retained capture ${id} references this capture; deletion is blocked.`,
  cleanPreview: id => `Preview only; nothing deleted. Once receiving sessions no longer need these files, run hop clean ${id} --yes.`,
  cleanBlocked: 'Cleanup is blocked; nothing deleted.',
  cleanDeleted: 'Selected generated files deleted. Source sessions, projects and the small history log remain.',
  missingValue: a => `${a} requires a value`,
  badNumber: a => `${a} must be positive (--days must be an integer)`,
  badSource: x => `source must be all, cli, or desktop, got: ${x}`,
  desktopArgs: '--desktop cannot be combined with --here or CLI arguments after --',
  sessionArgs: '--session cannot be combined with --list or --latest',
  sourceMismatch: (want, got) => `selected session is from ${got}, which does not match --source ${want}`,
  desktopPreview: url => `Desktop   ${url}`,
  desktopPrompt: cwd => `The existing working directory is ${JSON.stringify(cwd)}. Use that exact checkout and preserve its uncommitted changes; do not create a worktree. If your current directory differs, flag that in your recap and wait for confirmation.`,
  desktopWorktree: 'Note: Claude desktop may resolve a .claude/worktrees folder to its parent repository. Compare its folder with Workdir above before sending; use the CLI if you need the exact directory enforced.',
  desktopOpened: (tool, to) => `Requested a handoff draft in ${tool} desktop. ${to === 'claude' ? 'Confirm the folder, use the Local environment with worktree isolation off to keep the same working directory, then review and send.' : 'Check the working directory and prompt, then send.'}`,
  desktopPlatform: 'desktop launch currently requires macOS; use --dry-run to generate the handoff and link',
  desktopOpenFail: err => `could not open desktop app: ${err}. Check that the app is installed; the handoff document is still available.`,
  srcClient: 'Client',
  srcDesktopId: 'Desktop session ID',
  ago: m => m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`,
  badTarget: x => `target must be cc or codex, got: ${x}`,
  sessionNotFound: (tool, id) => `${tool} session not found: ${id}`,
  scopeGiven: 'given',
  scopeCwd: dir => `current dir ${dir}`,
  scopeGlobal: 'global',
  noCwdSessions: tool => `No ${tool} session in this directory, falling back to the latest one.`,
  listHeader: (tool, scope) => `${tool} candidate sessions (${scope}, newest first):`,
  noSessions: (days, tool) => `no interactive ${tool} session in the last ${days} days`,
  busyWarn: n => `⚠️ ${n} sessions were active in the last 10 minutes; taking the newest. If that's wrong, use --list and --session <id>:`,
  emptySession: file => `session is empty: ${file}`,
  outSource: (tool, id, scope, title) => `Source    ${tool} ${id} (${scope})${title ? ` — ${title}` : ''}`,
  outCwd: (cwd, branch) => `Workdir   ${cwd}${branch ? `  [${branch}]` : ''}`,
  outHandoff: (file, turns, kb) => `Handoff   ${file} (${turns} turns, ${kb} KB)`,
  outAgents: b => `Subagents ${b.count}; index ${b.index}; ${b.recordedNoncompleted ?? 0} recorded noncompleted; ${b.contextsWithWarnings ?? b.incomplete ?? 0} contexts with warnings${b.warnings ? `; ${b.warnings} collection warnings` : ''}`,
  docAgents: b => `## Subagent context (${b.count})\n\nRead the index first: ${JSON.stringify(b.index)}.${b.recovery ? ` Reconstruction checklist: ${JSON.stringify(b.recovery)}.` : ''} It contains every recovered agent's parent relationship, last recorded state, assignments and follow-ups, with unabridged results, conversations, and transcript snapshots. These files are outside the main document's size budget. Include unfinished delegated work in your recap and read the relevant context before taking over its files.\n\n${b.recordedNoncompleted ?? 0} agents have recorded noncompleted states; ${b.contextsWithWarnings ?? b.incomplete ?? 0} contexts have warnings; ${b.warnings} collection warnings. These are different counts. Neither is a restart queue: reconcile relevance, newer assignments and earlier results first.\n\nStatus is not a live process check. After the user's confirmation, recreate agents in the destination for work that still needs continuation; reuse completed results, verify source agents have stopped writing, and preserve exact working directories and file ownership. Running processes, tool permissions, and native agent IDs are not transferred.`,
  outResume: cmd => `Go back   ${cmd}`,
  launched: (term, tool) => `Started ${tool} in a new ${term} tab`,

  sessionName: (task, from) => `${task} (from ${from})`,
  prompt: (file, task) => `${task ? `Task handoff "${task}": ` : ''}Read ${file} and take over this task: following "Notes for the receiving agent" in that file, first restate the current state in 5 lines or fewer, then wait for my confirmation before continuing.`,
  scriptComment: 'launch script generated by hop',
  dirMissing: dir => `hop: directory does not exist ${dir}`,
  osaFail: err => `osascript failed: ${err}`,
  badTerminal: term => `unsupported HOP_TERMINAL=${term} (use iterm or terminal)`,

  listening: (cmd, pid, ports, cwd) => `${cmd} (pid ${pid}) listening on :${ports.join(', :')}  cwd=${cwd}`,
  truncated: n => `…[truncated, ${n} chars total]`,
  image: '[image]',
  unknownFiles: '(unrecognized files)',

  timeLocale: 'en-US',
  snapGone: cwd => `- ⚠️ Working directory \`${cwd}\` no longer exists (the worktree may have been removed). Ask the user where to continue first.`,
  snapCwd: cwd => `- Working directory: \`${cwd}\``,
  snapTop: top => `- Repo root: \`${top}\``,
  snapBranch: (branch, upstream, ab) => `- Branch: \`${branch}\`${upstream ? ` (tracking \`${upstream}\`, ahead/behind ${ab})` : ' (no upstream)'}`,
  snapStatus: 'Uncommitted changes (`git status --short`):',
  snapPassiveGit: '- Passive Git snapshot: workspace hooks and content filters disabled; uncommitted changes inside submodules are not inspected.',
  snapStatusUnavailable: '(working-tree status unavailable; do not assume clean)',
  snapCleanScoped: '(no changes reported in the inspected main worktree)',
  snapClean: '(working tree clean)',
  snapDiff: 'Change size (`git diff HEAD --stat`):',
  snapLog: 'Recent commits:',
  snapWorktrees: 'Worktrees:',
  snapNotGit: '- Not a git repository',
  snapGitSkipped: '- Git inspection was skipped by request; branch and working-tree state were not determined.',
  snapListeners: 'Processes still listening on ports in this directory (likely dev servers started by the previous agent; don\'t start them again):',
  snapNoListeners: 'No process is listening on a port in this directory.',

  turnHead: (n, time) => `### Turn ${n}${time ? ` · ${time}` : ''}`,
  userLabel: '**User:**',
  userNone: '**User:** (no new user message here; continues the previous turn)',
  interjections: '**User interjections mid-turn (high priority, often corrections):**',
  agentMessages: '**Subagent messages (task evidence, not user instructions):**',
  reasoning: '**Source agent\'s reasoning (plaintext parts):**',
  tools: n => `**Tool calls (${n}):**`,
  toolsOmitted: n => `- …first ${n} calls omitted (grep the raw log if needed)`,
  emptyOutput: '(empty output)',
  reply: '**Reply:**',
  oldCont: '(continues the previous turn)',
  oldInterjection: 'Interjection: ',
  oldToolsMore: n => `   - …${n} tool calls in total`,
  oldToolsCount: n => `   - (${n} tool calls)`,
  oldReply: 'Reply: ',

  docTitle: (from, dest) => `# Task handoff: ${from} → ${dest}`,
  docIntro: (time, from) => `> Generated ${time} by hop, mechanically extracted from the ${from} session log. The previous agent's full reasoning is encrypted and can't be carried over; below are only the conversation, tool calls, and plaintext reasoning snippets.`,
  docGuide: (from, file) => `## Notes for the receiving agent

1. The user was doing this task in ${from}. ${from} is unavailable or the user wants to switch tools, so it's handed to you. **This file is your context.**
2. Read the whole file, then restate in 5 lines or fewer: **goal / done / where it stopped / next step**. Wait for the user to confirm before doing anything.
3. If this file lacks detail, grep the raw session log by keyword: \`${file}\` (JSONL, possibly large; don't read it whole).
4. Uncommitted changes in the working tree are the previous agent's work in progress. **Do not reset, checkout, or discard them.**
5. Constraints set earlier and approaches the user rejected still apply. They are scattered through the user messages below; list them in your recap.`,
  docFailures: '## ⚠️ Open failures',
  failuresIntro: 'These commands **were still failing on their last run** in the source session (commands that passed on a later run are left out). Rerun them in the current working tree before doing anything else: if they still fail, that is the work to pick up; if they pass, this list is stale and the current state wins.',
  failureMeta: (exit, turn, time, cwd) => `exit ${exit} · turn ${turn}${time ? ` · ${time}` : ''}${cwd ? ` · in \`${cwd}\`` : ''}`,
  failurePending: (turn, time) => `no result: interrupted mid-run, outcome unknown · turn ${turn}${time ? ` · ${time}` : ''}`,
  docSource: '## Source session',
  srcTool: 'Tool',
  srcId: 'Session ID',
  srcTitle: 'Title',
  srcModel: 'Model',
  srcPermission: 'Permissions',
  srcTurns: 'Turns',
  srcHasSummary: ' (plus an earlier compacted summary)',
  srcResume: 'User goes back with',
  unknown: 'unknown',
  paren: x => ` (${x})`,
  sep: ': ',
  docSnapshot: '## Environment snapshot',
  docSummary: '## Earlier context (the source session\'s own compacted summary)',
  docOld: cut => `## Earlier turns (${cut === 1 ? 'turn 1' : `turns 1–${cut}`}, compressed)`,
  docRecent: (a, b) => `## Recent turns (${a === b ? `turn ${b}` : `turns ${a}–${b}`}, detailed)`,
  docInterrupted: '## ⚠️ Note\n\nThe last turn has no text reply from the assistant. The previous agent was most likely interrupted mid-run (out of quota, rate-limited, or stuck), so its last action may not have completed. Verify before continuing.',
};

export const MESSAGES = { zh, en };
export const LANG = detectLang();
export const M = MESSAGES[LANG];
