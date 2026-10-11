# hop

在 **Codex** 和 **Claude Code** 之间交接正在做的任务，不丢上下文。

```bash
hop cc       # Codex → Claude Code
hop codex    # Claude Code → Codex
```

一条命令：读取你刚才的会话并生成交接文档。默认在新终端标签页启动目标 CLI；加上 `--desktop` 则在目标桌面应用中打开预填好的草稿。桌面模式不会自动发送，发送前请检查提示词和工作目录。

[English](README.md)

## 背景

Codex 做到一半，遇到限流、额度用完或者卡在死循环里，想换 Claude Code 接着做（反过来也一样）。

手动换很麻烦：要重新讲一遍目标，贴最近几条对话，告诉新 agent 现在在哪个分支、哪个 worktree，改了哪些文件，哪些路已经试过不通，dev server 是不是已经起着。这些信息其实都在两个工具的本地会话记录里，`hop` 负责把它们收拢起来。

而且通常是**当前 agent 已经用不了**才要换，限流中的 agent 没法自己写交接说明。所以 `hop` 完全不依赖源 agent，它是一个直接读会话文件的普通命令行工具。在卡住的 Claude Code 会话里直接敲：

```
! hop codex
```

`!` 前缀直接执行 shell 命令，不经过模型，额度用完也能用。

## 环境要求

- macOS（打开终端新标签页或启动桌面应用需要；`--here` 和 `--dry-run` 在哪都能用）
- Node.js ≥ 20
- 默认模式需要把目标 CLI 安装到 `PATH`；`--desktop` 只需安装目标桌面应用，不需要安装对应 CLI。源会话记录必须在本机。

没有任何 npm 依赖。

## 安装

```bash
git clone https://github.com/0genlab/hop.git ~/code/hop
ln -s ~/code/hop/bin/hop.mjs ~/.local/bin/hop   # 换成你 PATH 里的任意目录
hop --help
```

也可以用 npm 全局安装：

```bash
npm install -g github:0genlab/hop
```

## 使用手册

### 切换

在你刚才干活的项目目录里执行：

```bash
hop cc        # 在 Claude Code 里接着做这个目录最近的 Codex 会话
hop codex     # 在 Codex 里接着做这个目录最近的 Claude Code 会话
```

`hop` 会先打印它选中了什么：

```
源会话   Codex 019a…（当前目录）
工作目录 /Users/you/code/app/.worktrees/fix-login  [fix-login]
交接文档 ~/.hop/handoffs/20260923-101500-codex-to-claude.md（12 轮，31.8 KB）
切回原会话 codex resume 019a…
```

然后开新标签页启动目标 agent，首条指令是：

> 任务「<任务名>」交接：读 `<交接文档>` 接手这个任务：先按文件里「给接手 agent 的说明」用 5 行以内复述当前状态，等我确认后再继续。

任务名取源会话的标题（Claude Code 里 `/rename` 起的名字优先于自动标题；Codex 取会话名 thread name），没有标题就用第一句用户输入。Claude Code 会带 `--name "<任务名>（接自 Codex）"` 启动；Codex 没有给会话命名的参数，任务名只能通过 prompt 传过去，它自动起名时一般会沿用。

**先核对它的复述，再让它继续。**

### 在桌面应用中打开草稿

默认目标仍是 CLI。要改为打开对应的桌面应用：

```bash
hop cc --desktop       # Codex → Claude Desktop
hop codex --desktop    # Claude Code → Codex Desktop
```

`--desktop` 通过应用的 URL scheme 打开一个新的本机会话，并预填交接提示词；它不会自动发送。URL 中包含提示词和本地交接文档路径，不包含源会话全文。请检查草稿后自行发送。链接格式参考 [Claude Desktop 链接指南](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link) 和 [Codex 桌面版深层链接文档](https://learn.chatgpt.com/docs/reference/commands)。

Claude Desktop 会把链接里的文件夹当作不可信路径，要求你先确认。确认文件夹、选择 **Local environment**，并关闭 worktree 隔离，才能使用现有 checkout。Claude Desktop 可能会把 `.claude/worktrees/` 下的路径改成父仓库。`hop` 会发出警告，并在草稿里写明准确路径，但应用仍可能改写它；必须严格使用原目录时，请用 CLI。

`hop cc --desktop --dry-run` 或 `hop codex --desktop --dry-run` 会生成交接文档并打印桌面链接，但不会打开应用。`--desktop` 不能与 `--here` 或 `--` 后的 CLI 参数同时使用。

### 指定会话

`hop` 按当前目录匹配会话，以 git 根目录为准，所以在仓库任意子目录里开的会话都算。如果最近 10 分钟有多个活跃会话，它会给出警告，这时手动指定：

```bash
hop cc --list                  # 显示会话 ID、客户端、工作目录和可用标题
hop cc --session 019a1b2c-…    # 按会话 ID 指定，也可以直接给 .jsonl 路径
hop codex --session local_abc123  # Claude Desktop 源会话 ID
hop cc --latest                # 不看当前目录，取全局最新的会话
```

当前目录下一个会话都没有时，自动退回到全局最新的会话。

`--source all|cli|desktop` 用于按来源客户端筛选，默认是 `all`。Codex 里能识别为 Codex Desktop 的记录会匹配 `desktop`；其他标记为 `vscode` 的记录包含在 `all` 中，并显示为 `[vscode]`。

Codex 会话名优先读取本地会话索引；仅保存在应用状态数据库里的标题，可通过可选的 `sqlite3` 只读查询补充。缺少标题元数据不会隐藏会话。

### 清理已保存的交接

```bash
hop clean --list              # 列出已登记交接及其交接 ID
hop clean <capture-id>        # 预览将清理的生成文件，默认不会删除
hop clean <capture-id> --yes  # 确认后永久删除这次交接
```

每次交接都有独立的交接 ID，同一源会话重复交接也会生成不同 ID。列表会显示交接 ID、可用标题、源会话 ID、工作目录和交接文档路径；用**交接 ID**选择要清理的内容。源会话 ID 和标题仅用于识别，不是清理选择器。

清理只删除选中交接生成的文档、扁平 agent 交接包，以及存在时与之关联的启动脚本；不会删除 provider 会话记录、项目文件或 `links.jsonl` 历史。未登记文件、没有关联的旧启动脚本和遗留的 `.capture-*` 暂存目录不会被自动清理。

删除前，Hop 会在同一个 `HOP_DIR` 中扫描其他保留的已登记交接和可识别的未登记交接（包括原始证据），查找对待删交接的引用。发现引用会阻止删除；证据不安全、不完整或无法读取时也会阻止清理。扫描不会检查 provider 日志、打开的聊天或其他 `HOP_DIR`，因此确认删除前请先结束这些上下文中的使用。归档较大时，扫描可能需要一些时间。

### 跳过 Git 检查

如果项目策略不允许执行 Git 命令，请使用 `--no-git`。它会跳过基于 Git 的源会话目录匹配，以及根会话和 agent 的 Git 快照；交接文档会将 Git 状态标记为未检查。此时源会话按当前目录匹配；如果源会话使用仓库子目录或 worktree，建议显式指定 `--session`：

```bash
hop codex --session local_example --desktop --no-git
```

### 全部选项

| 选项 | 作用 |
|---|---|
| `--list` | 列出候选源会话及会话 ID、客户端、工作目录和可用标题后退出 |
| `--session <id>` | 指定源会话（会话记录 UUID、Claude Desktop 的 `local_<id>` 或 `.jsonl` 路径） |
| `--latest` | 忽略当前目录，取全局最新的会话 |
| `--dry-run` | 生成交接文档但不打开目标；与 `--desktop` 同用时还会打印桌面链接 |
| `--here` | 在当前终端启动，不开新标签页 |
| `--desktop` | 在目标桌面应用中打开预填草稿；需要手动检查并发送 |
| `--no-git` | 跳过 Git 匹配和快照；按当前目录匹配，并将 Git 状态标记为未检查 |
| `--source <client>` | 按来源筛选：`all`（默认）、`cli` 或 `desktop` |
| `--days <n>` | 往前查找的天数，默认 14 |
| `--budget <KB>` | 紧凑交接文档的大小目标（KB），默认 48 |
| `-- <参数>` | 后面的参数原样传给目标 CLI，比如 `hop cc -- --model opus`；不能与 `--desktop` 同用 |

### 环境变量

| 变量 | 默认值 | 含义 |
|---|---|---|
| `HOP_TERMINAL` | 装了 iTerm 就用 `iterm`，否则 `terminal` | `iterm` 或 `terminal` |
| `HOP_CLAUDE_BIN` | `claude` | Claude Code 可执行文件 |
| `HOP_CODEX_BIN` | `codex` | Codex 可执行文件 |
| `HOP_DIR` | `~/.hop` | 交接文档、启动脚本、切换记录的存放目录 |
| `HOP_LANG` | 跟随 `LC_ALL` / `LC_MESSAGES` / `LANG` | `zh` 或 `en`：CLI 输出、交接文档和启动提示词的语言 |
| `CODEX_HOME` | `~/.codex` | 查找 Codex 会话时会读取 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | 查找 Claude Code 会话时会读取 |
| `HOP_CLAUDE_DESKTOP_DIR` | `~/Library/Application Support/Claude` | Claude Desktop 数据目录，用来把本地桌面 ID 对应到会话记录；元数据位于 `claude-code-sessions/` |

### 切回原会话

原会话不会被改动。对于 Codex 桌面会话，以及元数据里有本地 ID 的 Claude Desktop 会话，`hop` 会打印桌面版返回链接，并同时提供 CLI resume 命令作为备用。Claude 的 `claude://code/continue?session=local_...` 是私有链接，已在 Claude Desktop 2.31226.1 上验证，未来可能变化。元数据缺失或会话已归档时，只能使用 CLI resume。每次切换都会向 `~/.hop/links.jsonl` 追加来源和目标客户端信息。新生成的交接文档和链接日志权限为 `0600`；`hop` 不会修改源会话存储。

## 交接文档里有什么

- **给接手 agent 的说明**：先读子 agent 索引，复述当前状态（包括未完成的委派任务）后等待确认；复用已有结果，修改相关文件前先读对应任务上下文；需要细节时 grep 原始记录；不要 reset 未提交的改动；之前定下的约束继续有效。重新创建未完成任务前，先确认源 agent 已停止修改相同文件。
- **未解决的失败**：源会话里最后一次运行仍失败（退出码非 0，或执行到一半被打断）的 shell 命令，附退出码、轮次、时间、目录和输出末尾。只收测试/构建/检查类命令，以及最后一轮里的失败；后来跑通的、grep/diff 这类返回 1 的都排除。新 agent 会被要求先重跑：还失败就是要接着修的问题，已通过说明这条过期了。这一节不参与压缩。
- **源会话信息**：工具、会话 ID、模型、权限/沙箱模式，以及原始 JSONL 记录的路径。
- **环境快照**：工作目录、分支、HEAD、和上游的 ahead/behind、`git status`、diff 统计、最近的提交、worktree 列表、stash，以及工作目录在项目内、正在监听 TCP 端口的进程（避免新 agent 重复起 dev server）。
- **对话**：你的指令、做到一半时插的话（通常是纠偏，会单独标出）、助手的回复、工具调用和截断后的输出，有明文思考的话也会带上。会话被压缩过的话，压缩摘要也会一起带上。
- **子 agent 交接包**：普通 `hop cc` / `hop codex` 命令都会自动收集相关的本地 agent 记录；两个方向的 CLI 和 `--desktop` 都适用。主交接文档会链接到同级的 `<handoff-stem>.agents/index.md`。交接包包含根会话与子 agent 的原始记录快照、清单，以及逐个 agent 的 Markdown 和 JSON 上下文，其中包括可获取的任务、后续指令、协作结果及参数、父子关系和状态依据。完整对话和普通工具数据保存在原始快照中；Claude 子 agent 的上下文文件不再重复这些大段内容。即使没有找到子 agent，也会保留根会话快照。交接包与 `--budget` 分开保存，不会因该参数而截断。目录权限为 `0700`，文件权限为 `0600`；交接包可能较大。用 `hop clean --list` 查找交接，用 `hop clean <capture-id>` 预览，并在不再需要时加 `--yes` 删除。收集过程只读取本地文件，不调用 provider，也不修改源会话存储。缺失或无法读取的记录会作为警告列出；缺少子记录时会保留明确的 stub。

渲染器会尝试用 6 档细节接近 `--budget` 目标。说明段和最后一轮始终保留，未解决的失败也不参与压缩，因此目标设得很小或必须保留的内容较长时，紧凑交接文档可能超过目标。配套 agent 交接包单独保存，不会被 `--budget` 截断。最近轮次保留的细节多于较早轮次；较早轮次会逐档压缩，最后压成一行摘要。最后一轮一定会保留。

worktree 和未提交的改动不会复制、合并或删除，会继续留在磁盘上。交接包会记录每个 agent 的工作目录和该目录是否在本机存在；如果它是本地 Git 工作树，也会记录分支、HEAD 和状态。目录缺失时会发出警告。重新接手未完成任务前，先确认源 agent 已停止修改相同文件。CLI 会在根会话的目录启动；桌面模式请在发送前核对应用里的文件夹和 worktree 选项。

Claude 子记录逐个捕获和解析，内存占用取决于最大的单个解析记录文件及保留的协作证据，而不是整棵子记录树的原始大小。捕获使用私有暂存文件，发布完成或发生可处理错误后会清理暂存目录。已发布的磁盘快照包含字节数和 SHA-256 校验值。

交接包中的 `recovery.md` 列出记录为未完成的 agent，以及需要核实的上下文。每个 agent 的重建描述都指向捕获的任务、纠正、结果、原始进度、工作目录和父子关系。清单版本 2 将原始路径映射到包内快照，删除原始日志后仍可查阅。CLI 分别显示未完成状态数量和有警告的上下文数量；它们都不是重启队列。父 agent 完成不会隐藏未完成的子任务，historical 关系或相似名称也不能证明任务已被替代。重启已关闭或中断的任务前，先检查已有结果。缺失日志和无法确定的状态会明确标注，不会被猜测为已完成。

Git 快照禁用文件系统监控钩子、内容过滤器、外部 diff 工具和可选的索引刷新；只检查主工作区，不检查子模块内部未提交的改动。交接文档会说明该范围，不会宣称整个仓库干净。使用自定义内容规范化的项目可能显示不同的原始文件差异。有内容过滤器时，安全覆盖配置需要 Git 支持 `--config-env`；无法安全检查过滤器配置时，工作区状态保留为不可用。

## 带不过来的

- **加密的委派指令**：部分 Codex Desktop 版本会在本地日志中加密保存子 agent 的任务和后续指令。Hop 会保留这些证据，但无法解密，也不能保证恢复原始指令。识别为不透明的输入必须经过重建核实；可读的进度或较早的任务说明不能证明缺失的后续纠正是什么。重新创建相关工作前，应从捕获的上下文中找到完整、可读的任务说明，或向用户确认缺失的范围。切回 Claude 时同样受此限制。
- **完整思考过程**：Codex 用 OpenAI 模型时，reasoning 是加密存储的，只有一句简短的 summary 标题。Claude Code 的 thinking 在本地记录里通常只有签名，正文是空的。Codex 走第三方 provider 时有明文思考，会一起带过来。
- **正在运行的进程**：dev server、watcher 这些没法搬，文档里会列出来告诉新 agent。
- **shell 状态**：会话里 `export` 的变量、激活的虚拟环境等。
- **agent 的实时运行状态**：交接包是任务证据，不会迁移仍在运行的 agent。记录的状态只是最后一次观察，不代表已完成，也不是实时进程检查。原生 agent ID、API 和工具、模型、权限、自定义 agent 定义、运行时状态和记忆不会自动迁移。历史或未关联的 agent 需要先确认是否仍相关；远程或未记录的数据无法恢复。
- **顶层源会话查找**：`codex exec`、`claude -p` / SDK 会话和子 agent 会话不会作为独立源会话被选中；但选定的交互式根会话关联的子 agent 仍可出现在交接包中。

## 原理

1. **找源会话**
   - Codex：本机 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`。会跨创建日期目录按文件修改时间查找，所以近期活跃的旧会话也能找到。根据记录里的 originator 识别 Codex Desktop；其他 `vscode` 记录由 `--source all` 包含，并显示为 `[vscode]`。
   - Claude Code：本机 `~/.claude/projects/<slug>/<id>.jsonl`（或 `CLAUDE_CONFIG_DIR` 下）的会话记录，只读取 `entrypoint` 为 `cli` 或 `claude-desktop` 的会话。桌面会话的可选元数据位于 `HOP_CLAUDE_DESKTOP_DIR/claude-code-sessions/<account>/<org>/local_*.json`，用于把 `local_<id>` 对应到普通记录 ID，并提供桌面会话信息；它不能代替真实会话记录。
   - 只读取磁盘上已有的记录。`hop` 不会拉取云端、SSH、VM 或 Cowork 会话。
2. **解析根会话记录**
   - Codex：把 `response_item` 记录按轮次分组；丢掉 Codex 注入到 user 角色里的内容（`<environment_context>`、AGENTS.md 等）；按 `call_id` 把工具调用和输出配对；遇到 `compacted` 就用压缩摘要替换之前的历史。
   - Claude Code：从最新一条非 sidechain（子 agent）消息开始，沿 `parentUuid` 往回走，rewind 掉的分支不会带上；还原斜杠命令，过滤 system reminder 和各种通知。
3. **收集相关 agent 记录**：源会话仍由人工交互的根会话决定；子会话作为关联证据收集，不会成为独立源会话候选。Codex 会依据明确的父会话元数据，递归收集活跃和归档会话中的子 agent，并纳入已记录的协作消息和状态。Claude Code/Desktop 会读取标准 `Agent` / `Task` 任务、sidechain 子会话记录、agent 元数据和嵌套父 ID，以及本地桌面工作流日志和报告。没有子会话记录关联的 Claude Desktop 排队任务卡片会保留为带警告的 stub；无法恢复任意团队或云端任务。只读取本地记录，不调用 provider，也不修改源存储。
4. **拍环境快照**：用 `git` 和 `lsof`。
5. **生成交接文档和证据包**：紧凑主文档写到 `~/.hop/handoffs/`，尝试用 6 档细节接近 `--budget` 目标；配套证据包写在旁边，不计入该目标，也不会被截断。
6. **启动**：默认生成脚本放到 `~/.hop/run/`，用 AppleScript 在 iTerm2 或 Terminal 新标签页里执行 CLI；加 `--desktop` 时改为打开预填目标应用提示框的 URL。

两个工具的会话格式都是私有的，没有公开文档，随时可能在某个版本里变掉。升级后解析出错，先看 `lib/codex.mjs` 和 `lib/claude.mjs`。

## 常见问题

- **选错了会话**：先 `hop cc --list`，再用 `--session <id>` 指定。
- **提示找不到会话**：试试 `--latest` 或 `--days 60`，再确认 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 指向的是你会话实际存放的位置。
- **没有开出新标签页**：可能是 macOS 拦了自动化权限。到「系统设置 → 隐私与安全性 → 自动化」里允许你的终端，或者改用 `--here`。
- **桌面应用没有打开**：桌面启动需要 macOS，并且目标应用已安装、URL scheme 已注册。`--dry-run --desktop` 仍会打印链接供检查。
- **Claude Desktop 工作目录不对**：发送前确认链接指定的文件夹。`.claude/worktrees/` 下的路径可能被改成父仓库；需要严格使用原 worktree 时，请用 CLI。
- **启动目录不对**：`hop` 给 Codex 传 `-C <cwd>`，给 Claude Code 是先 `cd` 进去再启动。看输出里的「工作目录」那一行，它取的是会话最新的 cwd。

## 开发

```bash
npm test
```

```
bin/hop.mjs        命令行入口
lib/codex.mjs      Codex 会话查找与解析
lib/claude.mjs     Claude Code 会话查找与解析
lib/codex-agents.mjs Codex 子会话收集
lib/claude-agents.mjs Claude agent 与桌面工作流收集
lib/subagents.mjs  agent 证据包生成
lib/artifacts.mjs  交接登记与安全清理
lib/recovery.mjs   agent 恢复上下文生成
lib/assignment-input.mjs 可读与不透明任务输入分类
lib/snapshot.mjs   git / 监听端口快照
lib/render.mjs     交接文档渲染与大小控制
lib/launch.mjs     启动脚本与终端标签页
```

## 路线图

- 会话内命令：源 agent 还能用的时候，让它自己写一份更完整的交接说明
- 切回时恢复原会话，并附上这段时间的增量交接
- 支持 Linux 终端

## 许可证

MIT
