---
description: "项目技能审批：`/skills` 命令列出项目本地技能，记录绑定到确切指令文本的批准，并可撤销；供用户与维护者选择、组合或排查哪些 `.dsh/skills` 正文能到达模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-skill

[English](README.md) | 中文

## Summary

`dsh-command-skill` 是项目技能审批的人机界面。`.dsh/skills` 或 `.agents/skills` 下的技能由克隆出的仓库作者撰写，因此一旦启用该要求，提供方会把它保留在你自己的目录里，但在你批准之前不交给模型。`/skills` 列出每个项目技能及其状态；`/skills approve <name>` 钉住确切的指令文本；`/skills revoke` 收回决定。编辑已批准的技能，或拉取一个编辑了它的提交，会自动使该批准失效。

## Table of Contents

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与推迟的工作](#known-limitations-and-deferred-work)
- [开发者注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

该命令随标准 `dsh` base 与所有随附 agent 预设一同挂载，因此用户想要的某个项目技能只需一条命令即可启用。它自身不需要配置；它报告什么取决于挂载的 `skill-filesystem` 如何配置。

### 三种状态

| 状态 | 含义 | 模型可见内容 |
|---|---|---|
| `pending` | 已发现，但本项目从未批准 | 该技能的任何内容 |
| `approved` | 某次批准钉住了当前磁盘上的内容 | 该技能，作为普通目录条目 |
| `changed since approval` | 存在批准，但针对的是不同内容 | 重新批准前，该技能的任何内容 |

`changed` 是最要紧的状态：一次重写了已批准技能的 `git pull` 就会产生它，这也正是批准绑定内容而非绑定名称的原因。

### 命令

| 输入 | 结果 |
|---|---|
| `/skills` | 列出会话项目根下的每个项目技能、其状态与下一步动作 |
| `/skills list` | 同一列表 |
| `/skills approve <name>...` | 按目录当前报告的内容记录批准 |
| `/skills revoke <name>...` | 撤销一个或多个批准 |
| `/skills revoke --all` | 撤销本项目记录的全部批准 |

名称按会话看到的目录解析，所以拼错会明确失败，而不是对一个不存在的对象记录决定：`No project skill named zeta under /repo. Nothing was approved.` 混入未知名称的批次会被整体拒绝——`/skills approve alpha zeta` 两个都不会批准。

技能处于 `pending` 时只对模型一侧隐藏。它仍留在你自己的发现面里，也仍可用 `/` 加名称显式调用，因此人使用自己仓库里的笔记从不以审批为前提。

### 组合该命令

命令读取三个协作者：技能目录、工作目录所有者，以及提供方以 `ctx.skillApprovals` 发布的批准记录。把它挂载在它所要编辑的那份记录旁边：

```yaml
- id: skill
  name: '@deepseek-ai/dsh-skill'
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    requireProjectSkillApproval: true
- id: working-directory
  name: '@deepseek-ai/dsh-working-directory'
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-skill
  name: '@deepseek-ai/dsh-command-skill'
```

不设 `requireProjectSkillApproval` 时提供方不隐藏任何东西，列表也会照实说明：`Project skill approval is not required here, so every listed skill already reaches models.` 在这种组合里记录决定无害，若之后启用该要求则立即生效。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 —— 点击展开</summary>

### 设计理念

批准是**内容**的属性，不是路径或名称的属性。项目技能文件可由任何能向用户克隆的仓库推送的人编辑，所以「名叫 `deploy` 的技能」并不是稳定可信的对象——同一个名称背后的正文可能在两次会话之间被改动，而用户什么都没做。钉住解码后指令文件的 SHA-256，使决定针对特定正文，并使「重新批准」成为信任新正文的唯一途径。

命令是呈现者，不是决策者。它读取模型所读的同一份目录，取用提供方解析时算出的摘要，并写入共享记录。它自身从不读取指令文件：第二条读取路径可能以不同方式解码同一文件，钉进一个闸此后永远不认的摘要。

### 一次决定的传播路径

`/skills approve` 按 `ctx.skills.list(...)` 解析每个名称，收集名称与 `contentDigest` 对，再调用 `ctx.skillApprovals.approve(projectRoot, name, digest)`。发布该记录的提供方订阅了它的写入，因此写入会使每个已组合的技能注册表失效——缺了这一步，批准只会躺在文件里，而下一次目录读取仍会从 collect 缓存回答「pending」。撤销走同一条路，跨进程亦然：记录按 `(mtime, size)` 重新校验，而不是启动时只读一次。

项目根来自 `resolveProjectSkillRoot`，与发现阶段判定「哪个项目拥有 `.dsh/skills`」用的是同一个函数。共用它才能保证决定钉在发现阶段此后会报告的根上；另写一套向上查找可能把决定存在发现阶段从不询问的路径下。

### 源码导览

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：参数文法、列表渲染、批准与撤销处理器、`/skills` 注册 |
| [`../skill-filesystem/src/approvals.ts`](../skill-filesystem/src/approvals.ts) | 记录本体：摘要钉定、原子写入、缓存重校验、按项目分键 |
| [`../skill-filesystem/src/index.ts`](../skill-filesystem/src/index.ts) | 把待批准项目技能从模型侧隐藏的闸，以及 `resolveProjectSkillRoot` |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-skill-filesystem](../skill-filesystem/README.zh.md) —— 执行该决定并拥有记录格式的提供方。
- [dsh-tool-skill](../tool-skill/README.zh.md) —— 闸要从其隐藏技能的面向模型的加载器。
- [dsh-commands](../../interaction/commands/README.zh.md) —— 发现 `/skills` 并拥有命令生命周期记录的注册表。
- [技能包地图](../README.zh.md) —— 审批在发现、加载与随附技能之间的位置。

-----

<a id="model-experience"></a>
## 模型体验

### 人类 `/skills` 控制

#### 模型看到什么

命令自身的东西什么都不进：它的调用、输出以及它产生的 `command/run` 生命周期记录都不会进入模型请求。它可能改变的是模型此前已获得的目录——批准一个待批准项目技能，会使该技能的名称、描述与正文从下一次请求起可加载；撤销则再次移除它们。待批准技能不贡献任何文本，因此仓库无法通过附带一个 `.dsh/skills` 目录来注入指令。

#### Token 影响

直接 token 为零。一次批准可能把某个项目技能的目录条目与正文带入后续请求，其代价与该大小的任何其他技能完全一致；本包自身新增的内容对模型不可见。

#### KV 缓存影响

批准或撤销会改变技能目录，从而改变后续请求的系统提示，因此从那一刻起使可复用前缀失效——与其他任何目录变化一样，付一次而不是每轮都付。列出与用法错误不触碰模型读取的任何内容。

## 已知限制与推迟的工作

<a id="known-limitations-and-deferred-work"></a>

- **没有客户端批准界面** —— 决定面是斜杠命令；不知道 `/skills` 存在的用户只能通过阅读提供方文档才知道技能被隐藏。在技能列表中加一个「启用」按钮是自然的下一步，那需要 Host Remote 而不是再加一条命令。
- **仅限项目根** —— 该要求覆盖 `.dsh/skills` 与 `.agents/skills`。用户根（`~/.dsh/skills`、`~/.agents/skills`）、自定义根与随附技能由用户或安装包撰写，无需决定即可到达模型。
- **仅目录可见性** —— 审批在目录与加载器读取处执行，因此已经进入对话历史的技能正文仍留在那里；撤销从下一次请求起生效，不追溯既往。
- **被遮蔽的名称在此不可见** —— 命令列出合并后的目录，因此被同名用户技能遮蔽的项目技能不会出现。它在该状态下无法到达模型，但按名称查找它的用户不会在列表里看到它。
- **无过期、无批量导入** —— 批准不会自然失效，也无法一次性接受整目录技能；每个名称要么单独批准，要么不批准。
- **是内容，不是能力** —— 批准一个技能是批准它的指令。指令让模型执行的东西仍要经过常规的工具、沙箱与权限边界。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

本注记是维护者的工作上下文，明确非权威。既有行为、限制与理由在上文各节与包代码中。

- 列表行与用法句子在 [`tests/command-skill.spec.ts`](tests/command-skill.spec.ts) 中以字面量钉定；改动它们即改动用户可见文案。
- 状态是推导出来的而非存储的：`pending` 与 `changed` 是「批准未能覆盖当前内容」的两种方式，因此新增存储状态需要迁移，并需要说明文件本身表达不了什么。
- 无摘要的项目技能会被列出并被拒绝批准，而不是隐藏——静默省略会看起来像一个空项目。

</details>
