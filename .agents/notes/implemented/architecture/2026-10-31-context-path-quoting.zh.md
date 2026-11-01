# Agent Note: 运行时上下文里的目录是「引号包裹」，不是「JSON 编码」

Status: implemented

[English](2026-10-31-context-path-quoting.md) | 中文

## 问题

两层被压成了一层，而这次合并只在 Windows 上露出。

交给模型的那行运行时上下文原本是 `Current working directory: "C:\\Users\\…"`：`JSON.stringify` 包上目录，同时把每个反斜杠翻倍。POSIX 目录本来就不需要转义，所以这个差异在语料的整个生命周期里都看不见；到了 Windows，模型被告知的是一个任何工具都解析不了的路径。同一个字符串又被当成录制夹具的占位契约：重放时用朴素的 `replaceAll` 把本次运行的真实目录塞进 `{{cwd}}`，对 `/tmp/…` 正确，对 `C:\…` 则产出 `\A`——一个非法的 JSON 转义。于是凡带这个 token 的夹具，在 Windows 检出上都会在 `JSON.parse(line)` 处因 `Bad escaped character` 直接死掉。

第二个缺陷藏在第一个后面：一旦那行能解析了，录制下来的 `{{cwd}}` 反而认不出来——运行侧报的是翻倍的 `C:\\…`，而归一化器只认识单反斜杠的写法。

## 决定

token 只为消费它的那一层转义一次。

`quoteContextPath`（在 `working-directory` 里）渲染模型读到的目录：用双引号保证可读，路径含引号时转成 `\"`，分隔符保持单个——`JSON.stringify(path).replaceAll('\\\\', '\\')`。POSIX 目录的渲染结果与改动前逐字节相同，所以没有任何既有期望被移动。

`hydrateSessionFixtureCwd`（在 `session-snapshot` 里，紧挨着它所反向的 tokenizer）把目录以 **JSON 转义形式** 塞回夹具，因为 token 永远位于 JSON 字符串字面量内部：`text.replaceAll('{{cwd}}', JSON.stringify(path).slice(1, -1))`。这两个函数不是彼此的逆函数；各自只是自己那一层的正确写法。

`minimal-image-compaction` 场景会把临时目录名补齐，使那行**渲染后**的长度固定为 192 字符，因此它现在也经 `quoteContextPath` 计量。POSIX 上什么都不会变；Windows 上补齐量跟的是真正发出去的那段文本。

## 被否的方案

**保留 `JSON.stringify`，让归一化器额外认识转义写法。** 这能让套件变绿，而模型继续读 `C:\\Users\\…`：绿是靠压制信号换来的，不是靠修。语料的存在意义就是让平台差异显形，所以这个渗漏该修在产品里。

**夹具里直接钉真实的临时目录，不用 token。** 路径每次运行、每台机器都不同，夹具将永远无法重放。

**比较会话 header 时把 shell 工具归一化，让一套语料服务两个平台。** 这正是剩下的那条 Windows 红所需要的形状——`session-resume` 现在卡在 header：录制的 header 列的是 `bash`，这台机器挂的是 `pwsh`——但它会改变所有语料共用的比较语义，而一个会悄悄丢掉会话真实拥有过的工具的 header 是更弱的钉子。所以它留作待决问题，而不是搭这次修复的车。

## 后果

Windows 下的会话现在显示与工具解析结果一致的单分隔符目录，Windows 检出也能重放带 `{{cwd}}` 的夹具。翻倍写法不再存在于任何地方：没有任何期望、夹具或 locale 字符串仍在用 `JSON.stringify` 拼这段文本。

Windows 上的 `pnpm run test:snapshot` 仍未全绿，但这已经从「解析失败」变成「语料设计边界」：`session-resume` 现在能跑到会话日志比对（记录、运行时上下文、sidecar 全部一致），停在 header 的工具列表上——`bash` 对 `pwsh`。ACP 语料同样钉着这个 shell 工具，所以「Windows 全绿」需要二者之一：平台中立的 shell 条目，或分平台语料——在 Windows 上录制之前先把这个定下来。

测试支撑侧多了一个纯函数，正反两面都有测试（Windows 目录经 `JSON.parse` 原样取回、POSIX 目录不变、不含 token 的夹具逐字节不变），文档与 tokenizer 并列。
