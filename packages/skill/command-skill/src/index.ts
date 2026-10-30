/**
 * Human-facing `/skills` command over the project-local skill approval record.
 * @module @deepseek-ai/dsh-command-skill
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-skill'
import { resolveProjectSkillRoot } from '@deepseek-ai/dsh-skill-filesystem'
import type {} from '@deepseek-ai/dsh-working-directory'

export const name = 'command-skill'
export const inject = ['commands', 'skills', 'workingDirectory', 'skillApprovals']

const DESCRIPTION = 'Review and approve project-local skills'
const USAGE = 'Usage: /skills [approve <name>... | revoke <name>... | revoke --all]'

/** One request parsed from the text following `/skills`. */
interface SkillRequest {
  readonly action: 'list' | 'approve' | 'revoke'
  readonly names: readonly string[]
  readonly all: boolean
}

/** One project skill and the decision that currently covers it. */
type SkillRow =
  | {
    readonly name: string
    readonly state: 'approved'
    readonly approvedAt: string
    /** Digest of the approved content; an approved row always pins one. */
    readonly digest: string
  }
  | {
    readonly name: string
    readonly state: 'pending' | 'changed'
    /** Digest of the content on disk now; absent when the provider cannot supply one. */
    readonly digest?: string
  }

/** Whether a skill came from a root authored by the checked-out repository. */
function isProjectSkill(source: string): boolean {
  return source === 'project-dsh' || source === 'project-agents'
}

/**
 * Parse the text after `/skills` into one request.
 * @param rawInput - exact command tail, including the separator whitespace.
 * @returns the request, or a usage message describing why it was rejected.
 */
function parseRequest(rawInput: string): SkillRequest | string {
  const tokens = rawInput.trim().split(/\s+/u).filter(token => token.length > 0)
  switch (tokens[0]) {
    case undefined:
    case 'list':
      return tokens.length <= 1 ? { action: 'list', names: [], all: false } : `list takes no arguments.\n${USAGE}`
    case 'approve': {
      const names = tokens.slice(1)
      if (names.length === 0) return USAGE
      if (names.includes('--all')) return `approve needs skill names; --all applies to revoke only.\n${USAGE}`
      return { action: 'approve', names, all: false }
    }
    case 'revoke': {
      const rest = tokens.slice(1)
      const all = rest.includes('--all')
      const names = rest.filter(token => token !== '--all')
      if (all && names.length > 0) return `revoke takes either skill names or --all, not both.\n${USAGE}`
      if (!all && names.length === 0) return USAGE
      return { action: 'revoke', names, all }
    }
    default:
      return `Unknown /skills subcommand "${tokens[0]}".\n${USAGE}`
  }
}

/**
 * Collect every project skill visible to this session with its approval state.
 *
 * A skill the provider reports without a content digest cannot be approved at
 * all, so it is listed as pending rather than silently omitted: the human needs
 * to see that something project-authored is being withheld and why.
 * @param ctx - context carrying the skill catalog and the approval record.
 * @param invocation - the invoking command, supplying cwd scope and cancellation.
 * @param projectRoot - resolved project root that owns the approval entries.
 * @returns rows sorted by skill name.
 */
async function collectRows(
  ctx: Context,
  invocation: CommandInvocation,
  projectRoot: string,
): Promise<SkillRow[]> {
  const listed = await ctx.skills.list({
    cwd: await ctx.workingDirectory.ensure(invocation.agent, invocation.signal),
    signal: invocation.signal,
    scope: invocation.agent,
  })
  const recorded = await ctx.skillApprovals.list(projectRoot)
  const rows: SkillRow[] = []
  for (const skill of listed) {
    if (!isProjectSkill(skill.source)) continue
    const entry = recorded[skill.name]
    const digest = skill.contentDigest
    if (entry !== undefined && digest !== undefined && digest === entry.sha256) {
      rows.push({ name: skill.name, state: 'approved', approvedAt: entry.approvedAt, digest })
      continue
    }
    rows.push({
      name: skill.name,
      state: entry === undefined ? 'pending' : 'changed',
      ...digest === undefined ? {} : { digest },
    })
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Render one state as a human sentence with the next action.
 * @param row - the row to describe.
 * @returns the state label shown after the skill name.
 */
function stateLabel(row: SkillRow): string {
  switch (row.state) {
    case 'approved':
      return `approved (${row.approvedAt})`
    case 'pending':
      return `pending (run /skills approve ${row.name})`
    case 'changed':
      return `changed since approval (run /skills approve ${row.name})`
  }
}

/**
 * Render the `/skills` listing.
 * @param projectRoot - project root the rows belong to.
 * @param rows - every project skill and its state.
 * @param required - whether this composition requires a recorded approval.
 * @returns the human-facing listing text.
 */
function listing(projectRoot: string, rows: readonly SkillRow[], required: boolean): string {
  const lines: string[] = []
  if (!required) {
    lines.push('Project skill approval is not required here, so every listed skill already reaches models.')
  }
  if (rows.length === 0) {
    lines.push(`No project skills found for ${projectRoot}.`)
    return lines.join('\n')
  }
  const width = Math.max(...rows.map(row => row.name.length))
  lines.push(`Project skills for ${projectRoot}:`)
  for (const row of rows) lines.push(`  ${row.name.padEnd(width)}  ${stateLabel(row)}`)
  lines.push('Approve with /skills approve <name>...; revoke with /skills revoke <name>...')
  return lines.join('\n')
}

/** A row whose content digest is known, and therefore approvable. */
type ApprovableRow = SkillRow & { readonly digest: string }

/**
 * Record approval for the named skills at the content the catalog reports.
 * @param ctx - context carrying the approval record.
 * @param projectRoot - project root owning the entries.
 * @param names - requested skill names.
 * @param rows - current project skills, used to resolve each name.
 * @returns the acknowledgement, or the reason nothing was approved.
 */
async function approve(
  ctx: Context,
  projectRoot: string,
  names: readonly string[],
  rows: readonly SkillRow[],
): Promise<CommandResult> {
  const known = new Map(rows.map(row => [row.name, row]))
  const selected: SkillRow[] = []
  const unknown: string[] = []
  for (const name of names) {
    const row = known.get(name)
    if (row === undefined) unknown.push(name)
    else selected.push(row)
  }
  if (unknown.length > 0) {
    return {
      kind: 'error',
      text: `No project skill named ${unknown.join(', ')} under ${projectRoot}. Nothing was approved.`,
    }
  }
  const approvable: ApprovableRow[] = []
  const digestless: string[] = []
  for (const row of selected) {
    const digest = row.digest
    if (digest === undefined) {
      digestless.push(row.name)
      continue
    }
    approvable.push({ ...row, digest })
  }
  if (digestless.length > 0) {
    return {
      kind: 'error',
      text: `The skill provider reports no content digest for ${digestless.join(', ')}, so its content cannot be pinned. Nothing was approved.`,
    }
  }
  for (const row of approvable) {
    await ctx.skillApprovals.approve(projectRoot, row.name, row.digest)
  }
  return { kind: 'success', text: `Approved ${names.join(', ')} for ${projectRoot}.` }
}

/**
 * Drop the recorded approvals requested by one invocation.
 * @param ctx - context carrying the approval record.
 * @param projectRoot - project root owning the entries.
 * @param request - revoke request naming either skills or the whole project.
 * @returns the acknowledgement, or the reason nothing was revoked.
 */
async function revoke(
  ctx: Context,
  projectRoot: string,
  request: SkillRequest,
): Promise<CommandResult> {
  if (request.all) {
    const recorded = await ctx.skillApprovals.list(projectRoot)
    const count = Object.keys(recorded).length
    await ctx.skillApprovals.revoke(projectRoot)
    return { kind: 'success', text: `Revoked every project skill approval for ${projectRoot} (${String(count)} removed).` }
  }
  const removed: string[] = []
  const kept: string[] = []
  for (const name of request.names) {
    if (await ctx.skillApprovals.revoke(projectRoot, name)) removed.push(name)
    else kept.push(name)
  }
  if (removed.length === 0) {
    return { kind: 'error', text: `No approval was recorded for ${kept.join(', ')} under ${projectRoot}.` }
  }
  const suffix = kept.length === 0 ? '' : ` No approval was recorded for ${kept.join(', ')}.`
  return { kind: 'success', text: `Revoked the approval for ${removed.join(', ')} under ${projectRoot}.${suffix}` }
}

/** Execute one `/skills` invocation against the invoking session's project. */
async function execute(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const request = parseRequest(invocation.rawInput)
  if (typeof request === 'string') return { kind: 'error', text: request }

  const cwd = await ctx.workingDirectory.ensure(invocation.agent, invocation.signal)
  const projectRoot = await resolveProjectSkillRoot(ctx, cwd)
  const rows = await collectRows(ctx, invocation, projectRoot)
  const required = ctx.skillApprovals.enabled

  switch (request.action) {
    case 'list': return { kind: 'success', text: listing(projectRoot, rows, required) }
    case 'approve': return await approve(ctx, projectRoot, request.names, rows)
    case 'revoke': return await revoke(ctx, projectRoot, request)
  }
}

/**
 * Register `/skills` for every composed human-command adapter.
 * @param ctx - context carrying the command registry, the skill catalog, the
 *   working-directory owner, and the project-skill approval record.
 */
export function apply(ctx: Context): void {
  const active = new Set<Promise<CommandResult>>()
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const operation = execute(ctx, invocation)
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    // Both branches retire without rethrowing, so the derived observer promise
    // cannot become an unhandled mirror of an expected handler rejection.
    void operation.then(retire, retire)
    return operation
  }

  ctx.effect(function* () {
    // Yield drain before registration: composite teardown is LIFO, so no new
    // invocation can enter while already-started handler promises quiesce.
    yield async () => { await Promise.allSettled(active) }
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-skill'),
      name: 'skills',
      description: DESCRIPTION,
      input: { hint: '[approve <name>...|revoke <name>...|revoke --all]' },
      handler,
    })
  }, 'command-skill lifecycle')
}
