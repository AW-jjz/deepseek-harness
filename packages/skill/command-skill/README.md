---
description: "Project-skill approval: the `/skills` command that lists project-local skills, records an approval bound to the exact instruction text, and revokes it; for users and maintainers choosing, composing, or debugging which `.dsh/skills` bodies reach a model."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-skill

English | [中文](README.zh.md)

## Summary

`dsh-command-skill` is the human side of project-skill approval. A skill under `.dsh/skills` or `.agents/skills` is authored by whoever owns the checkout, so once the requirement is on, the provider keeps that skill in your own catalog but withholds it from models until you approve it. `/skills` lists every project skill and its state; `/skills approve <name>` pins the exact instruction text; `/skills revoke` takes the decision back. Editing an approved skill, or pulling a commit that edits it, voids the approval automatically.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The command ships in the standard `dsh` base and in every shipped agent preset, so a project skill a user wants is one command away. It needs no configuration of its own; what it reports depends on how the mounted `skill-filesystem` was configured.

### The three states

| State | Meaning | What the model sees |
|---|---|---|
| `pending` | Discovered, never approved in this project | Nothing from this skill |
| `approved` | An approval pins the content on disk right now | The skill, as an ordinary catalog entry |
| `changed since approval` | An approval exists for different content | Nothing from this skill until re-approved |

`changed` is the state that matters most: it is what a `git pull` that rewrites an approved skill produces, and it is why an approval is bound to content rather than to a name.

### Commands

| Input | Result |
|---|---|
| `/skills` | List every project skill under the session's project root with its state and the next action |
| `/skills list` | The same listing |
| `/skills approve <name>...` | Record approval at the content the catalog reports now |
| `/skills revoke <name>...` | Drop one or more approvals |
| `/skills revoke --all` | Drop every approval recorded for this project |

Names resolve against the catalog the session sees, so a typo fails loudly instead of recording a decision about nothing: `No project skill named zeta under /repo. Nothing was approved.` A mixed batch is rejected whole for the same reason — `/skills approve alpha zeta` approves neither.

Only the model-facing face is withheld while a skill is pending. The skill stays in your own discovery surface and stays reachable by typing `/` plus its name, so an approval decision is never a prerequisite for a human using their own repository's notes.

### Composing the command

The command reads three collaborators: the skill catalog, the working-directory owner, and the approval record the provider publishes as `ctx.skillApprovals`. Mount it beside the provider whose record it edits:

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

Without `requireProjectSkillApproval` the provider withholds nothing and the listing says so: `Project skill approval is not required here, so every listed skill already reaches models.` Recording decisions in that composition is harmless and takes effect if the requirement is turned on later.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The approval is a property of *content*, not of a path or a name. A project skill file is editable by anyone who can push to the repository the user cloned, so "the skill called `deploy`" is not a stable thing to trust — the body behind that name can change between two sessions without the user doing anything. Pinning the SHA-256 of the decoded instruction file makes the decision about a specific body, and makes re-approval the only way to trust a new one.

The command is a presenter, not a decision-maker. It reads the same catalog models read, takes the digest the provider computed while parsing, and writes through the shared record. It never reads instruction files itself: a second read path could decode a file differently from discovery and pin a digest that the gate would then reject forever.

### How one decision travels

`/skills approve` resolves each name against `ctx.skills.list(...)`, collects the name and `contentDigest` pair, and calls `ctx.skillApprovals.approve(projectRoot, name, digest)`. The provider that published that record subscribed to its writes, so the write invalidates every composed skill registry — without that, the approval would sit in the file and the next catalog read would still answer "pending" from its collect cache. Revocation travels the same way, including from a second process: the record revalidates on `(mtime, size)` rather than reading once at startup.

The project root comes from `resolveProjectSkillRoot`, the same function discovery uses to decide which project owns `.dsh/skills`. Sharing it is what keeps a decision pinned to a root that discovery will later report; a second walk could store it under a path discovery never asks about.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: argument grammar, listing renderer, approve and revoke handlers, `/skills` registration |
| [`../skill-filesystem/src/approvals.ts`](../skill-filesystem/src/approvals.ts) | The record itself: digest pinning, atomic writes, cache revalidation, per-project keys |
| [`../skill-filesystem/src/index.ts`](../skill-filesystem/src/index.ts) | The gate that withholds pending project skills from models, and `resolveProjectSkillRoot` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-skill-filesystem](../skill-filesystem/README.md) — the provider that enforces the decision and owns the record format.
- [dsh-tool-skill](../tool-skill/README.md) — the model-facing loader the gate withholds skills from.
- [dsh-commands](../../interaction/commands/README.md) — the registry that discovers `/skills` and owns command lifecycle records.
- [Skill package map](../README.md) — where approval sits among discovery, loading, and bundled skills.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/skills` control

#### What the model sees

Nothing from the command itself: its invocation, its output, and the `command/run` lifecycle records it produces never enter a model request. What it can change is the catalog the model was already given — approving a pending project skill makes that skill's name, description, and body loadable from the next request onward, and revoking it removes them again. A pending skill contributes no text at all, so a repository cannot inject instructions by shipping a `.dsh/skills` directory.

#### Token effect

Zero direct tokens. An approval can move a project skill's catalog entry and body into later requests, which costs exactly what any other skill of that size costs; nothing this package adds is model-visible on its own.

#### KV Cache effect

An approval or revocation changes the skill catalog and therefore the system prompt of later requests, so it invalidates the reusable prefix from that point on — the same effect as any other catalog change, paid once rather than per turn. Listing and usage errors touch nothing the model reads.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No client-side approval UI** — the decision surface is the slash command; a user who does not know `/skills` exists finds a withheld skill only by reading the provider's documentation. A skill-list row with an Enable control is the natural next step, and it needs a Host Remote rather than another command.
- **Project roots only** — the requirement covers `.dsh/skills` and `.agents/skills`. User roots (`~/.dsh/skills`, `~/.agents/skills`), custom roots, and bundled skills are authored by the user or the installation and keep reaching models without a decision.
- **Catalog visibility only** — the approval is enforced where the catalog and loader read, so a skill body already in a conversation's history stays there; revoking takes effect from the next request, not retroactively.
- **Shadowed names are invisible here** — the command lists the merged catalog, so a project skill shadowed by a same-name user skill does not appear. It could not reach a model in that state, but a user looking for it by name will not find it listed.
- **No expiry and no bulk import** — approvals do not age out, and there is no way to accept a directory of skills in one decision; each name is approved individually or not at all.
- **Content, not capability** — approving a skill approves its instructions. Anything those instructions tell a model to run still passes through the ordinary tool, sandbox, and permission boundaries.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Shipped behavior, limits, and rationale live in the sections above and the package code.

- The listing lines and the usage sentences are pinned by [`tests/command-skill.spec.ts`](tests/command-skill.spec.ts) as literals; changing them changes user-visible copy.
- The state machine is derived, not stored: `pending` and `changed` are the two ways an approval can fail to cover the current content, so adding a stored state would need a migration and a reason the file itself cannot express.
- A digest-less project skill is listed and refused rather than hidden, because silently omitting it would look like an empty project.

</details>
