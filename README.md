# handoff-ai

会话切换时的工作交接：交接方把**现场、证据、已排除的路、下一刀**压成一页可复核的记录；接手方先跑 `check` 核对漂移，再给三行计划，才动手。

用于会话快满、换会话/模型/工具、派子任务，以及接手一个可能有人做过的项目。

## 三条立场

1. **交接是现场记录，不是会议纪要。** 聊天里的状态是叙述，命令输出才是现场。
2. **每条状态带证据，或者标未验。** 「应该可以了」「理论上没问题」一律算未验。
3. **一页写完。** 正文 ≤ 60 行；超了就拆任务或写设计文档。

## 装

目录本身就是交付物：

| 工具 | 位置 |
| --- | --- |
| Claude Code | `.claude/skills/handoff-ai/` |
| Codex | `~/.codex/skills/handoff-ai/` |
| 项目内通用 | `skills/handoff-ai/`，在规则文件里指向 `SKILL.md` |

交接固定放项目根的 `.handoff/`，**加进 `.gitignore`**：本机草稿，不进版本库。

## 用

```bash
# 交接方：生成骨架（分支、HEAD、脏文件已填好）
node scripts/handoff.mjs write --task scan-rules

# 接手方：先核验，再动手
node scripts/handoff.mjs check .handoff/2026-11-12T17-20_scan-rules.handoff.md

# 找最新的
node scripts/handoff.mjs list
```

`write` 结束会打印一句，直接粘进新会话：

```
读 .handoff/2026-11-12T17-20_scan-rules.handoff.md，先跑 check 再动手。
```

## 一页长什么样

```markdown
---
handoff: 2          # 第几次交接
task: scan-rules    # 同一任务全程不变
created: 2026-11-12T17:20+08:00
repo: F:/AI服务/awu-ui
branch: main
head: ac99bcb
status: in-progress  # in-progress | blocked | review | done
prev: 2026-11-12T14-05_scan-rules.handoff.md
---

## 任务      做完是什么样 + 验收标准
## 坐标      分支 / HEAD / 脏文件 / 跑过的命令 / 在跑的进程
## 账        表格：项 | 状态 | 证据（已验 / 未验 / 放弃）
## 已排除    试过不通的路与原因
## 下一步    编号，第一条立刻能开始
## 边界      要人定 / 只读别动 / 外部依赖
```

「账」是表格不是清单，因为**空格子写不下去**：

```markdown
| 项 | 状态 | 证据 |
| --- | --- | --- |
| 规则表拆成两段 | 已验 | `scripts/slop-scan.mjs:21-60`；`node --test` 12 通过 |
| 文档同步 29 条 id | 未验 | 要跑一遍 id 对账，确认差异为 0 |
| 提醒也返回退出码 1 | 放弃 | CI 噪音太大，改 `--strict` |
```

逐节写法见 [references/format.md](references/format.md)，三态与漂移处置见 [references/verify.md](references/verify.md)，好坏对照见 [references/examples/](references/examples/)。

## check 检查什么

**硬错误（退出码 1）**：缺字段、缺节、「坐标」为空、账目没有表格行、账里状态不是 `已验/未验/放弃`、「已验」没有可复核的证据、「未验」没写怎么验、占位符没删、正文超 60 行、「已排除」为空、「下一步」没有编号条目。

**提醒（退出码 0）**：HEAD / 分支漂移、工作区脏了、`prev` 指向的文件不存在、序号不连续、`status: done` 但「边界」还有要人定的事、`created` 不是 ISO 8601。

新生成的骨架本来就过不了 `check` —— 占位符没删完的交接不算交接。

## 文件

```
handoff-ai/
├─ SKILL.md                 立场、交出四步、接手四步
├─ references/
│  ├─ format.md             字段表、六节逐节写法、账目 schema、预算
│  ├─ verify.md             三态判定、什么算跑过、漂移四类、像完成的话
│  └─ examples/             good.md / bad.md 同一任务对照
└─ scripts/handoff.mjs      write / check / list，零依赖，Node 18+
```

## 边界

- **串行假设**：同一时间只有一个会话动同一件工作。交接发出后旧会话就停，否则坐标立刻过期。
- 不替代设计文档：长期有效的「为什么这么设计」写进文档或提交信息。
- 不替代 git：它记状态，不记改动历史。
