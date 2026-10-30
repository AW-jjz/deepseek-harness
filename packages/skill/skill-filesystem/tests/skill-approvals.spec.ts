import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '../src/index.ts'
import { SkillApprovalStore, skillDigest } from '../src/approvals.ts'

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-${name}-`))
  tempDirs.push(dir)
  return await realpath(dir)
}

async function writeSkill(root: string, name: string, body = 'Use the skill.'): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  await writeFile(file, `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`)
  return file
}

async function setup(
  home: string,
  config: Partial<SkillFileSystem.Config> = {},
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, {
    dshHome: join(home, '.dsh'),
    agentsHome: join(home, '.agents'),
    watch: false,
    // The gate is opt-in at this layer until the human approval command is
    // mounted by a composition; these cases exercise it switched on.
    requireProjectSkillApproval: true,
    ...config,
  })
  return ctx
}

/** Approve one project skill through the handle a human-facing command uses. */
async function approve(
  ctx: Context,
  projectRoot: string,
  name: string,
  file: string,
): Promise<void> {
  await ctx.skillApprovals.approve(projectRoot, name, skillDigest(await readFile(file, 'utf8')))
}

async function invocationOf(
  ctx: Context,
  name: string,
  cwd?: string,
): Promise<{ modelInvocable: boolean; userInvocable: boolean } | undefined> {
  const listed = await ctx.skills.list(cwd === undefined ? {} : { cwd })
  return listed.find(skill => skill.name === name)?.invocation
}

describe('project skill approval gate', () => {
  it('lists a project skill for the user but withholds it from models until approved', async () => {
    const home = await tempDir('approval-home')
    const project = await tempDir('approval-project')
    await mkdir(join(project, '.git'), { recursive: true })
    const file = await writeSkill(join(project, '.dsh/skills'), 'repo-skill')

    const ctx = await setup(home)

    expect(await invocationOf(ctx, 'repo-skill', project)).toEqual({
      modelInvocable: false,
      userInvocable: true,
    })

    await approve(ctx, project, 'repo-skill', file)

    expect(await invocationOf(ctx, 'repo-skill', project)).toEqual({
      modelInvocable: true,
      userInvocable: true,
    })
  })

  it('voids the approval when the approved content changes', async () => {
    const home = await tempDir('approval-edit-home')
    const project = await tempDir('approval-edit-project')
    await mkdir(join(project, '.git'), { recursive: true })
    const file = await writeSkill(join(project, '.dsh/skills'), 'edited-skill', 'Original body.')
    const ctx = await setup(home)
    await approve(ctx, project, 'edited-skill', file)
    expect((await invocationOf(ctx, 'edited-skill', project))?.modelInvocable).toBe(true)

    await writeFile(file, '---\nname: edited-skill\ndescription: edited-skill description\n---\n\nInjected body.\n')

    // A fresh composition rather than the warm registry: the catalog cache is
    // the watcher's concern, and the property under test is that the recorded
    // digest no longer describes this file.
    const discoveredAgain = await setup(home)
    expect((await invocationOf(discoveredAgain, 'edited-skill', project))?.modelInvocable).toBe(false)
  })

  it('re-checks the approval when the body is loaded, not only when it is listed', async () => {
    const home = await tempDir('approval-load-home')
    const project = await tempDir('approval-load-project')
    await mkdir(join(project, '.git'), { recursive: true })
    const file = await writeSkill(join(project, '.dsh/skills'), 'load-skill')
    const ctx = await setup(home)
    await approve(ctx, project, 'load-skill', file)

    const candidate = (await ctx.skills.list({ cwd: project })).find(skill => skill.name === 'load-skill')
    if (candidate === undefined) throw new Error('expected load-skill candidate')
    expect((await ctx.skills.get('load-skill', { cwd: project }))?.invocation.modelInvocable).toBe(true)

    // Revoked through a second instance over the same file, the way a separate
    // host surface would: the load path must observe it without a catalog rebuild.
    const store = new SkillApprovalStore({ dshHome: join(home, '.dsh'), enabled: true })
    await store.revoke(project, 'load-skill')

    expect((await ctx.skills.get('load-skill', { cwd: project }))?.invocation.modelInvocable).toBe(false)
    expect(candidate.source).toBe('project-dsh')
  })

  it('leaves user and custom roots model-invocable without a recorded approval', async () => {
    const home = await tempDir('approval-user-home')
    const custom = await tempDir('approval-user-custom')
    await mkdir(custom, { recursive: true })
    await writeSkill(join(home, '.dsh/skills'), 'user-skill')
    await writeSkill(join(home, '.agents/skills'), 'agents-skill')
    await writeSkill(custom, 'custom-skill')

    const ctx = await setup(home, { customSkillDirs: [custom] })

    for (const name of ['user-skill', 'agents-skill', 'custom-skill']) {
      expect(await invocationOf(ctx, name)).toEqual({ modelInvocable: true, userInvocable: true })
    }
  })

  it('applies no gate when a composition disables the requirement', async () => {
    const home = await tempDir('approval-off-home')
    const project = await tempDir('approval-off-project')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.dsh/skills'), 'open-skill')

    const ctx = await setup(home, { requireProjectSkillApproval: false })

    expect((await invocationOf(ctx, 'open-skill', project))?.modelInvocable).toBe(true)
  })

  it('approves nothing when the store is unreadable, and keeps discovery working', async () => {
    const home = await tempDir('approval-corrupt-home')
    const project = await tempDir('approval-corrupt-project')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.dsh/skills'), 'corrupt-skill')
    await mkdir(join(home, '.dsh'), { recursive: true })
    await writeFile(join(home, '.dsh/skill-approvals.json'), '{ not json')

    const ctx = await setup(home)

    expect(await invocationOf(ctx, 'corrupt-skill', project)).toEqual({
      modelInvocable: false,
      userInvocable: true,
    })
  })
})

describe('SkillApprovalStore', () => {
  it('persists approvals keyed by project and skill, and forgets revoked ones', async () => {
    const home = await tempDir('approval-store-home')
    await mkdir(home, { recursive: true })
    const store = new SkillApprovalStore({ dshHome: home, enabled: true })

    await store.approve('C:\\repo', 'alpha', 'digest-a')
    await store.approve('C:\\repo', 'beta', 'digest-b')
    await store.approve('C:\\other', 'alpha', 'digest-c')

    expect(await store.isApproved('C:\\repo', 'alpha', 'digest-a')).toBe(true)
    expect(await store.isApproved('C:\\repo', 'alpha', 'digest-b')).toBe(false)
    expect(await store.isApproved('C:\\other', 'alpha', 'digest-c')).toBe(true)
    expect(Object.keys(await store.list('C:\\repo')).sort()).toEqual(['alpha', 'beta'])

    expect(await store.revoke('C:\\repo', 'alpha')).toBe(true)
    expect(await store.isApproved('C:\\repo', 'alpha', 'digest-a')).toBe(false)
    expect(await store.revoke('C:\\repo', 'alpha')).toBe(false)
    expect(await store.revoke('C:\\repo')).toBe(true)
    expect(await store.list('C:\\repo')).toEqual({})

    const stored = JSON.parse(await readFile(join(home, 'skill-approvals.json'), 'utf8')) as {
      version: number
    }
    expect(stored.version).toBe(1)
  })

  it('observes a decision written by another store instance over the same file', async () => {
    const home = await tempDir('approval-store-shared-home')
    await mkdir(home, { recursive: true })
    const reader = new SkillApprovalStore({ dshHome: home, enabled: true })
    const writer = new SkillApprovalStore({ dshHome: home, enabled: true })

    expect(await reader.isApproved('C:\\repo', 'alpha', 'digest-a')).toBe(false)
    await writer.approve('C:\\repo', 'alpha', 'digest-a')
    expect(await reader.isApproved('C:\\repo', 'alpha', 'digest-a')).toBe(true)
  })

  it('reports every discovery as approved when the requirement is disabled', async () => {
    const home = await tempDir('approval-store-off-home')
    const store = new SkillApprovalStore({ dshHome: home, enabled: false })

    expect(await store.isApproved('C:\\repo', 'alpha', 'anything')).toBe(true)
  })

  it('fails closed and keeps reporting when the store path cannot be examined', async () => {
    const home = await tempDir('approval-store-unstatable-home')
    // A path the platform itself refuses to examine: not "no store yet" (that
    // is ENOENT) but a failure the user needs to hear about, and one that must
    // still fail closed instead of throwing into discovery.
    const messages: string[] = []
    const store = new SkillApprovalStore({
      dshHome: join(home, 'in\u0000valid'),
      enabled: true,
      logger: message => messages.push(message),
    })

    expect(await store.isApproved('C:\\repo', 'alpha', 'digest-a')).toBe(false)
    // The second read takes the remembered-absent branch instead of re-reporting.
    expect(await store.isApproved('C:\\repo', 'alpha', 'digest-a')).toBe(false)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('skill approvals unreadable')
  })

  it('reports a revoke that matched no project record', async () => {
    const home = await tempDir('approval-store-empty-revoke-home')
    await mkdir(home, { recursive: true })
    const store = new SkillApprovalStore({ dshHome: home, enabled: true })

    expect(await store.revoke('C:\\\\nowhere', 'alpha')).toBe(false)
    expect(await store.revoke('C:\\\\nowhere')).toBe(false)
  })

  it('surfaces a failed write to the caller and keeps reading fail-closed', async () => {
    const home = await tempDir('approval-store-unwritable-home')
    // A regular file where the store's parent directory should be: mkdir cannot
    // create the hierarchy, so the staged write fails before any rename.
    const blocked = join(home, 'blocked')
    await writeFile(blocked, 'not a directory\n')
    const store = new SkillApprovalStore({ dshHome: join(blocked, 'nested'), enabled: true })

    await expect(store.approve('C:\\\\repo', 'alpha', 'digest-a')).rejects.toThrow()
    expect(await store.isApproved('C:\\\\repo', 'alpha', 'digest-a')).toBe(false)
  })
  it('keeps case-distinct project keys where paths are case-sensitive', async () => {
    const home = await tempDir('approval-store-posix-home')
    await mkdir(home, { recursive: true })
    const store = new SkillApprovalStore({ dshHome: home, enabled: true })
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    // The Windows fold must not leak onto a case-sensitive host: two spellings
    // there are two projects, and merging them would enact a decision the user
    // never made for the other one.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      await store.approve('C:\\\\Repo', 'alpha', 'digest-a')
      expect(await store.isApproved('C:\\\\Repo', 'alpha', 'digest-a')).toBe(true)
      expect(await store.isApproved('C:\\\\repo', 'alpha', 'digest-a')).toBe(false)
    } finally {
      if (platform !== undefined) Object.defineProperty(process, 'platform', platform)
    }
  })
  it('ignores a store written by an unknown schema version', async () => {
    const home = await tempDir('approval-store-version-home')
    await mkdir(home, { recursive: true })
    // A newer writer's document: readable JSON, unknown semantics. Trusting it
    // would enforce decisions this build cannot interpret, so it reads as empty.
    await writeFile(join(home, 'skill-approvals.json'), JSON.stringify({
      version: 2,
      projects: { 'C:\\repo': { root: 'C:\\repo', skills: { alpha: { sha256: 'digest-a', approvedAt: 'now' } } } },
    }))
    const store = new SkillApprovalStore({ dshHome: home, enabled: true })

    expect(await store.list('C:\\repo')).toEqual({})
  })

  it('drops entries and projects whose stored shape is incomplete', async () => {
    const home = await tempDir('approval-store-shape-home')
    await mkdir(home, { recursive: true })
    // Keys fold case on Windows, so a fixture key must match the folded lookup.
    const key = (root: string): string => process.platform === 'win32' ? root.toLowerCase() : root
    await writeFile(join(home, 'skill-approvals.json'), JSON.stringify({
      version: 1,
      projects: {
        [key('C:\\repo')]: { root: 'C:\\repo', skills: { good: { sha256: 'd', approvedAt: 'now' }, partial: { sha256: 'd' } } },
        [key('C:\\stringly')]: 'not a project',
        [key('C:\\recordless')]: { root: 'C:\\recordless', skills: 'not skills' },
      },
    }))
    const store = new SkillApprovalStore({ dshHome: home, enabled: true })

    expect(Object.keys(await store.list('C:\\repo'))).toEqual(['good'])
    expect(await store.list('C:\\stringly')).toEqual({})
    expect(await store.list('C:\\recordless')).toEqual({})
  })

  it('fails closed when an absent store stays absent across reads', async () => {
    const home = await tempDir('approval-store-absent-home')
    await mkdir(home, { recursive: true })
    const store = new SkillApprovalStore({ dshHome: home, enabled: true })

    // No store file yet: the first read answers "nothing approved", and the
    // second takes the remembered-absent branch.
    expect(await store.isApproved('C:\\repo', 'alpha', 'digest-a')).toBe(false)
    expect(await store.isApproved('C:\\repo', 'alpha', 'digest-a')).toBe(false)
  })

  it('fails closed when the store file is readable as a path but not as text', async () => {
    const home = await tempDir('approval-store-directory-home')
    await mkdir(join(home, 'skill-approvals.json'), { recursive: true })
    const messages: string[] = []
    const store = new SkillApprovalStore({
      dshHome: home,
      enabled: true,
      logger: message => messages.push(message),
    })

    expect(await store.list('C:\\repo')).toEqual({})
    expect(messages.some(message => message.includes('skill-approvals.json'))).toBe(true)
  })
})

