import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { createInboxStub, provideWorkingDirectoryFixture, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import * as commandSkill from '../src/index.ts'

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
let sessionCounter = 0
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-${name}-`))
  tempDirs.push(dir)
  return await realpath(dir)
}

/** Write one project skill and return its instruction file. */
async function writeSkill(project: string, name: string, body = 'Use the skill.'): Promise<string> {
  const directory = join(project, '.dsh/skills', name)
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'SKILL.md')
  await writeFile(file, `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`)
  return file
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly project: string
  readonly home: string
  readonly plugin: { dispose(): Promise<void> }
}

/** Compose the command with a live skill provider over one temp project. */
async function harness(
  options: { readonly requireApproval?: boolean; readonly home?: string; readonly project?: string } = {},
): Promise<Harness> {
  const home = options.home ?? await tempDir('command-skill-home')
  const project = options.project ?? await tempDir('command-skill-project')
  await mkdir(join(project, '.git'), { recursive: true })

  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, {
    dshHome: join(home, '.dsh'),
    agentsHome: join(home, '.agents'),
    watch: false,
    requireProjectSkillApproval: options.requireApproval ?? true,
  })
  provideWorkingDirectoryFixture(ctx)
  const plugin = await ctx.plugin(commandSkill)

  const session = ctx.sessions.create(SessionId(`command-skill-${String(sessionCounter++)}`), {
    meta: { cwd: project },
  })
  const inbox = createInboxStub()
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    model: unsupportedModel(),
    inbox,
    ctx: new Context(),
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { this.inbox.append('next-step', input) },
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  await ctx.agents.register(agent)
  return { ctx, agent, session, project, home, plugin }
}

/** Execute one `/skills` invocation through the registry boundary a UI adapter uses. */
async function run(test: Harness, tail = ''): Promise<CommandResult> {
  const execution = await test.ctx.commands.execute(
    test.agent,
    `/skills${tail}`,
    [],
    new AbortController().signal,
  )
  if (execution === undefined) throw new Error('skills command was not registered')
  return execution.result
}

/** Whether a skill currently reaches models for this project. */
async function modelInvocable(test: Harness, name: string): Promise<boolean | undefined> {
  const listed = await test.ctx.skills.list({ cwd: test.project })
  return listed.find(skill => skill.name === name)?.invocation.modelInvocable
}

describe('@deepseek-ai/dsh-command-skill registration', () => {
  it('registers one global command and disposes it', async () => {
    const test = await harness()
    expect(commandSkill.name).toBe('command-skill')
    expect(commandSkill.inject).toEqual(['commands', 'skills', 'workingDirectory', 'skillApprovals'])
    expect('default' in commandSkill).toBe(false)

    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      definitionId: '@deepseek-ai/dsh-command-skill',
      name: 'skills',
      description: 'Review and approve project-local skills',
      input: { hint: '[approve <name>...|revoke <name>...|revoke --all]' },
    })
    expect(test.ctx.commands.find(test.agent, 'skills')).toBeDefined()

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'skills')).toBeUndefined()
  })
})

describe('/skills listing', () => {
  it('reports a project skill as pending and keeps it away from models', async () => {
    const test = await harness()
    await writeSkill(test.project, 'repo-skill')

    await expect(run(test)).resolves.toEqual({
      kind: 'success',
      text: [
        `Project skills for ${test.project}:`,
        '  repo-skill  pending (run /skills approve repo-skill)',
        'Approve with /skills approve <name>...; revoke with /skills revoke <name>...',
      ].join('\n'),
    })
    await expect(modelInvocable(test, 'repo-skill')).resolves.toBe(false)
  })

  it('lists a project-agents root and ignores roots the user owns', async () => {
    const test = await harness()
    const agentsRoot = join(test.project, '.agents/skills/agent-skill')
    await mkdir(agentsRoot, { recursive: true })
    await writeFile(
      join(agentsRoot, 'SKILL.md'),
      '---\nname: agent-skill\ndescription: agent-skill description\n---\n\nAgents root body.\n',
    )
    const userRoot = join(test.home, '.dsh/skills/user-skill')
    await mkdir(userRoot, { recursive: true })
    await writeFile(
      join(userRoot, 'SKILL.md'),
      '---\nname: user-skill\ndescription: user-skill description\n---\n\nUser root body.\n',
    )

    const listed = await run(test)
    expect(listed.kind).toBe('success')
    if (listed.kind !== 'success' || listed.text === undefined) throw new Error('expected listing text')
    expect(listed.text).toContain('agent-skill  pending (run /skills approve agent-skill)')
    // A user root is authored by the user, so it is never gated and never listed here.
    expect(listed.text).not.toContain('user-skill')
  })

  it('reports an empty project without inventing an action line', async () => {
    const test = await harness()

    await expect(run(test, ' list')).resolves.toEqual({
      kind: 'success',
      text: `No project skills found for ${test.project}.`,
    })
  })

  it('reports the approved content and the changed state after an edit', async () => {
    const test = await harness()
    const file = await writeSkill(test.project, 'alpha')
    await writeSkill(test.project, 'beta')
    await run(test, ' approve alpha')

    const approved = await run(test)
    if (approved.kind !== 'success' || approved.text === undefined) throw new Error('expected listing text')
    const lines = approved.text.split('\n')
    expect(lines[0]).toBe(`Project skills for ${test.project}:`)
    expect(lines[1]).toContain('alpha  approved (')
    expect(lines[2]).toBe('  beta   pending (run /skills approve beta)')

    await writeFile(file, '---\nname: alpha\ndescription: alpha description\n---\n\nRewritten body.\n')
    // A fresh composition rather than the warm registry: with the watcher off in
    // this harness nothing invalidates the catalog, and the property under test
    // is that the recorded digest no longer describes the file.
    const composedAgain = await harness({ home: test.home, project: test.project })
    const edited = await run(composedAgain)
    expect(edited.kind).toBe('success')
    if (edited.kind !== 'success' || edited.text === undefined) throw new Error('expected listing text')
    expect(edited.text).toContain('alpha  changed since approval (run /skills approve alpha)')
    await expect(modelInvocable(composedAgain, 'alpha')).resolves.toBe(false)
  })

  it('says the requirement is off when the composition does not gate project skills', async () => {
    const test = await harness({ requireApproval: false })
    await writeSkill(test.project, 'open-skill')

    const listed = await run(test)
    expect(listed.kind).toBe('success')
    if (listed.kind !== 'success' || listed.text === undefined) throw new Error('expected listing text')
    expect(listed.text).toContain('Project skill approval is not required here')
    expect(listed.text).toContain('open-skill  pending (run /skills approve open-skill)')
    await expect(modelInvocable(test, 'open-skill')).resolves.toBe(true)
  })
})

describe('/skills approve', () => {
  it('records the decision and lets the approved skill reach models', async () => {
    const test = await harness()
    await writeSkill(test.project, 'alpha')

    await expect(run(test, ' approve alpha')).resolves.toEqual({
      kind: 'success',
      text: `Approved alpha for ${test.project}.`,
    })
    await expect(modelInvocable(test, 'alpha')).resolves.toBe(true)

    const stored = JSON.parse(await readFile(join(test.home, '.dsh/skill-approvals.json'), 'utf8')) as {
      projects: Record<string, { skills: Record<string, { sha256: string }> }>
    }
    const project = Object.values(stored.projects)[0]
    expect(Object.keys(project?.skills ?? {})).toEqual(['alpha'])
  })

  it('refuses an unknown name and approves nothing', async () => {
    const test = await harness()
    await writeSkill(test.project, 'alpha')

    await expect(run(test, ' approve alpha zeta')).resolves.toEqual({
      kind: 'error',
      text: `No project skill named zeta under ${test.project}. Nothing was approved.`,
    })
    await expect(modelInvocable(test, 'alpha')).resolves.toBe(false)
  })

  it('refuses a project skill whose provider reports no content digest', async () => {
    const test = await harness()
    test.ctx.skills.register({
      name: 'runtime-project',
      description: 'a project-tagged runtime skill',
      source: 'project-dsh',
      content: 'Registered in memory.',
    })

    const listed = await run(test)
    expect(listed.kind).toBe('success')
    if (listed.kind !== 'success' || listed.text === undefined) throw new Error('expected listing text')
    expect(listed.text).toContain('runtime-project  pending (run /skills approve runtime-project)')

    await expect(run(test, ' approve runtime-project')).resolves.toEqual({
      kind: 'error',
      text: 'The skill provider reports no content digest for runtime-project, so its content cannot be pinned. Nothing was approved.',
    })
  })
})

describe('/skills revoke', () => {
  it('drops one recorded approval and withholds the skill again', async () => {
    const test = await harness()
    await writeSkill(test.project, 'alpha')
    await expect(run(test, ' approve alpha')).resolves.toEqual({
      kind: 'success',
      text: `Approved alpha for ${test.project}.`,
    })

    await expect(run(test, ' revoke alpha')).resolves.toEqual({
      kind: 'success',
      text: `Revoked the approval for alpha under ${test.project}.`,
    })
    await expect(modelInvocable(test, 'alpha')).resolves.toBe(false)
  })

  it('names the skills that had no recorded approval', async () => {
    const test = await harness()
    await writeSkill(test.project, 'alpha')
    await writeSkill(test.project, 'beta')
    await run(test, ' approve alpha')

    await expect(run(test, ' revoke alpha beta')).resolves.toEqual({
      kind: 'success',
      text: `Revoked the approval for alpha under ${test.project}. No approval was recorded for beta.`,
    })
  })

  it('reports an error when nothing was recorded', async () => {
    const test = await harness()
    await writeSkill(test.project, 'alpha')

    await expect(run(test, ' revoke alpha')).resolves.toEqual({
      kind: 'error',
      text: `No approval was recorded for alpha under ${test.project}.`,
    })
  })

  it('clears the whole project and reports how many records went', async () => {
    const test = await harness()
    await writeSkill(test.project, 'alpha')
    await writeSkill(test.project, 'beta')
    await run(test, ' approve alpha beta')

    await expect(run(test, ' revoke --all')).resolves.toEqual({
      kind: 'success',
      text: `Revoked every project skill approval for ${test.project} (2 removed).`,
    })
    await expect(modelInvocable(test, 'alpha')).resolves.toBe(false)
    await expect(modelInvocable(test, 'beta')).resolves.toBe(false)
  })

  it('reports zero removals when the project recorded nothing', async () => {
    const test = await harness()

    await expect(run(test, ' revoke --all')).resolves.toEqual({
      kind: 'success',
      text: `Revoked every project skill approval for ${test.project} (0 removed).`,
    })
  })
})

describe('/skills usage errors', () => {
  const usage = 'Usage: /skills [approve <name>... | revoke <name>... | revoke --all]'

  it.each([
    [' list now', `list takes no arguments.\n${usage}`],
    [' approve', usage],
    [' approve --all', `approve needs skill names; --all applies to revoke only.\n${usage}`],
    [' revoke', usage],
    [' revoke --all alpha', `revoke takes either skill names or --all, not both.\n${usage}`],
    [' nope', `Unknown /skills subcommand "nope".\n${usage}`],
  ])('rejects %s with the canonical usage', async (tail, expected) => {
    const test = await harness()
    await expect(run(test, tail)).resolves.toEqual({ kind: 'error', text: expected })
  })
})
