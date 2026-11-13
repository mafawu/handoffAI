---
handoff: 2
task: scan-rules
created: 2026-11-12T17:20+08:00
repo: F:/AI服务/awu-ui
branch: main
head: ac99bcb
status: in-progress
prev: 2026-11-12T14-05_scan-rules.handoff.md
---

# 交接：扫描器从 29 条规则扩到 40 条

## 任务
补齐侦测盲区：XAML 绑定错误、QML 字面颜色、Markdown 里的假精度数字。
验收：`examples/` 三个样例的命中变化能逐条解释，且不新增误报。

## 坐标
- 分支 `main`，HEAD `ac99bcb`，工作区干净
- 在 F:/AI服务/awu-ui 跑 `node scripts/slop-scan.mjs examples` → 59 处（P0 7 · P1 32 · P2 20），退出码 1
- 跑 `node scripts/slop-scan.mjs examples/after.html --strict` → 0 处，退出码 0
- 没有服务在跑，无端口占用

## 账
| 项 | 状态 | 证据 |
| --- | --- | --- |
| 规则表拆成行级 + 文件级两段 | 已验 | `scripts/slop-scan.mjs:21-60`；上面两条命令的数字对得上 |
| top-label 改成结构识别，最多回看 3 行 | 已验 | before.html 命中 3 处（23、24、32 行） |
| 文档同步了 29 条 id | 未验 | 要跑一遍 id 对账，确认代码与目录差异为 0 |
| 把提醒也做成退出码 1 | 放弃 | CI 噪音太大，改成 `--strict` 显式开启 |

## 已排除
- 用正则区分「标题上方的标签」和面包屑：`<p class>` 无法区分，两种写法都误伤，改成看行距与相邻元素
- 把账目做成 YAML：手写麻烦且 diff 难读，改回表格

## 下一步
1. 在 `scripts/slop-scan.mjs:21` 的规则表里加 `xaml-binding`：匹配 `{Binding` 但 `Path=` 为空或 `ElementName` 拼错，先只报 P2
2. 加 `markdown-stat`：扫 `.md` 里的 `\d+%` 与 `\d+x`，跳过代码块，报 P1
3. 跑 `node scripts/slop-scan.mjs examples`，确认新增命中只落在新规则上，旧的 59 处不变

## 边界
- 要人定：扩到 40 条后要不要给目录扫描加 `--max-files` 上限？倾向加，但要定个值
- 只读别动：`references/ai-tells.md`，改规则必须同步它
- 外部依赖：GitHub 推送靠 Windows 凭据管理器，环境里没有 token
