---
description: "桌面壳的原生任务通知：窗口不在视野内时，长时间轮次结束会弹出一条通知，点击即可回到该会话"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-desktop-notice

[English](README.md) | 中文

## 概述

`dsh-client-ui-desktop-notice` 把“结束的长轮次”变成一条原生通知，但只在桌面应用中、且窗口不在视野内时。它读取桌面预加载暴露的 `window.dshDesktop.notifications`；浏览器标签页没有该桥接，插件因此什么也不做。通知会写明会话、说明任务已在后台完成，点击后窗口回到前台并选中该会话。

## 目录

- [它观察什么](#what-it-watches)
- [失败行为](#failure-behavior)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-it-watches"></a>
## 它观察什么

每次权威的 `ctx.sessions.list` 更新都会按会话折叠：开始运行的会话记录该时刻，而在被观察到至少运行 30 秒后停止运行的会话，会在 `document.visibilityState` 为 `hidden` 时产生一条通知。更短的轮次不通知——几秒就弹一次的应用会让用户学会忽略它；首次观察到时已在运行的会话从观察时刻起算，因此插件绝不宣告自己没看到开始的轮次。运行中从目录里消失的会话会被丢弃，而不是被报告为已完成。

通知不是第二个收件箱：对话记录照常保留完成状态，失败行（如果有）仍在屏幕上，这里不改变会话记录的任何内容。当请求到达时窗口已经获得焦点，壳会拒绝显示；其 `notifications.taskCompletion` 偏好（托盘与 macOS 应用菜单，默认开启）可以完全关闭该通道。

<a id="failure-behavior"></a>
## 失败行为

桥接缺失或格式不对意味着没有通知、也没有错误。被拒绝的通知请求会被兜住：平台可用性由壳负责，记录仍然是对话记录。点击指向已不存在的会话时什么也不打开，窗口继续显示应用。

<a id="model-experience"></a>
## 模型体验

无：本包是浏览器侧 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无：本包既不组装也不发送提供方请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **仅完成事件**——等待审批与轮次失败暂不通知；两者需要按绑定观察，而不是本包使用的目录折叠。
- **仅目录中的会话**——Host 为目录中列出的会话报告运行状态，因此“没有打开窗口但在运行”的会话仍会通知，而从未进入目录的会话不会。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>给维护者的上下文——点击展开</summary>

`NOTICE_MINIMUM_MS`（30 秒，在 `src/index.ts`）是唯一阈值：一个轮次在被观察的状态下累计运行多久才值得通知。调低它只会让功能变吵，而不是更有用。可见性读取发生在折叠完成事件的那一刻，因此“请求到达壳之前窗口已回到前台”不会重复通知——壳自己会再判一次焦点。

桥接是可选契约，整体就是 `window.dshDesktop?.notifications`；浏览器构建只走“桥接缺失”这条路径。通知文案在 `src/client/locales.ts`，与 `locale/` 对应；桌面壳渲染预加载交来的文本，因此改文案不需要重发壳。

测试在 `tests/`：用假的 `ctx.sessions.list` 数据源与桩桥接驱动插件，覆盖阈值边界、隐藏/可见分流、以及会话消失被丢弃三种情形。

</details>
