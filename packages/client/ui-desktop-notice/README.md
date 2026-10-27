---
description: "Native task notifications for the Desktop shell: a long turn that finishes while the window is out of sight raises one notification, and a click returns to that Session"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-desktop-notice

English | [中文](README.zh.md)

## Overview

`dsh-client-ui-desktop-notice` turns a finished long turn into one native notification, but only in the Desktop application and only while the window is not in view. It reads the shell bridge `window.dshDesktop.notifications`, which the Desktop preload exposes; a browser tab has no such bridge and the plugin does nothing. The notification names the session, says the work finished in the background, and a click brings the window back and selects that session.

## What it watches

Every authoritative `ctx.sessions.list` update is folded per session: a session that starts running records that instant, and a session that stops running after at least 30 seconds of observed running time produces one notification when `document.visibilityState` is `hidden`. Shorter turns are not announced — an application that pings after a few seconds teaches its user to ignore it — and a session first observed mid-turn is measured from that observation, so the plugin never announces a turn it did not see begin. Sessions that leave the catalog while running are dropped rather than reported as finished.

Notifications are not a second inbox: the transcript keeps the completion, the failure row (if any) stays on screen, and nothing here changes what the session recorded. The shell also refuses to show one when the window is focused by the time the request arrives, and its `notifications.taskCompletion` preference (tray and macOS application menu, default on) turns the channel off entirely.

## Failure behavior

A missing or malformed bridge means no notifications and no error. A refused notification request is contained: the shell owns platform availability, and the transcript remains the record. A click that names a session which no longer exists opens nothing and leaves the window showing the application.

-----

## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Completion only** — approval waits and turn failures do not notify yet; both need per-binding observation rather than the catalog fold this package uses.
- **Open sessions only** — the catalog reports running state for sessions the Host lists, so a session running with no window open is still announced, but a session that never appears in the catalog is not.
