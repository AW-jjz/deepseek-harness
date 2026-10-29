import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as officeSkills from '@deepseek-ai/dsh-skill-office'
import * as workspaceDependencies from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import * as desktopOffice from '../src/office.ts'

it('loads Desktop Office CLI paths and removes them on disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-office-'))
  vi.stubEnv('DSH_HOME', root)
  const ctx = new Context()

  try {
    const assets = join(root, 'runtime', 'office-skills')
    await cp(new URL('../../../packages/skill/skill-office/assets/', import.meta.url), assets, { recursive: true })
    const nodeDirectory = join(root, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin')
    await mkdir(nodeDirectory, { recursive: true })
    await cp(process.execPath, join(nodeDirectory, process.platform === 'win32' ? 'node.exe' : 'node'))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    expect('default' in desktopOffice).toBe(false)
    expect(ctx.loader.unwrapExports(desktopOffice)).toBe(desktopOffice)
    const modules = new Map<string, unknown>([
      ['agents', AgentRegistry], ['systemPrompt', SystemPrompt], ['tools', ToolRuntime], ['toolExecutor', NativeToolExecutor],
      ['skills', SkillRegistry], ['office', desktopOffice],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected plugin ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    const config = join(root, 'cordis.yml')
    await writeFile(config, [
      '- name: agents', '- name: systemPrompt', '- name: tools', '- name: skills', '- name: office',
      '  config:', `    source: ${JSON.stringify(join(root, 'runtime', 'primary-runtime'))}`,
      `    root: ${JSON.stringify(join(root, 'installed'))}`,
      `    runtimeDir: ${JSON.stringify(join(root, 'dsh'))}`, '',
    ].join('\n'))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['office', 'office-docx', 'office-export-pdf', 'office-pptx', 'office-recalculate', 'office-render', 'office-xlsx'])
    expect((await ctx.skills.get('office-pptx'))?.resourceBase).toEqual({ kind: 'directory', path: join(assets, 'office-pptx').split(sep).join('/') })
    expect((await ctx.skills.get('office-pptx'))?.content).toContain('office-render')
    expect((await ctx.skills.get('office-pptx'))?.content).not.toContain(nodeDirectory)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['load_workspace_dependencies'])
    const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'office')
    expect(entry).toBeDefined()
    await entry?.fiber?.dispose()
    expect(await ctx.skills.list()).toEqual([])
    expect(ctx.tools.schemas()).toEqual([])
  } finally {
    try { await ctx.fiber.dispose() }
    finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  }
})

/** Build a payload whose three Office resources all exist, plus the module resolver that finds it. */
async function officePayload(root: string): Promise<{ config: desktopOffice.Config; resolveModule: (specifier: string) => string }> {
  const source = join(root, 'runtime', 'primary-runtime')
  await mkdir(join(root, 'runtime', 'office-skills'), { recursive: true })
  const nodeDirectory = join(source, 'dependencies', 'node', 'bin')
  await mkdir(nodeDirectory, { recursive: true })
  await writeFile(join(nodeDirectory, process.platform === 'win32' ? 'node.exe' : 'node'), '')
  const engine = join(root, 'engine', 'libreoffice-kit')
  await mkdir(join(engine, 'lib'), { recursive: true })
  await writeFile(join(engine, 'lib', 'cli.js'), '')
  await writeFile(join(engine, 'package.json'), '{"name":"@deepseek-ai/libreoffice-kit"}')
  return {
    config: { source, root: join(root, 'installed'), runtimeDir: join(root, 'dsh') },
    resolveModule: (specifier: string) => {
      if (specifier !== '@deepseek-ai/libreoffice-kit/package.json') throw new Error(`unexpected specifier ${specifier}`)
      return pathToFileURL(join(engine, 'package.json')).href
    },
  }
}

it('resolves the three payload resources and names the first one that is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-office-resolve-'))
  try {
    const { config, resolveModule } = await officePayload(root)
    expect(desktopOffice.resolveOfficeResources(config, resolveModule)).toEqual({
      resources: {
        assetRoot: join(root, 'runtime', 'office-skills'),
        node: join(config.source, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
        cli: join(root, 'engine', 'libreoffice-kit', 'lib', 'cli.js'),
      },
    })
    // The CLI is the last check, so a pruned engine reports itself rather than the assets.
    await rm(join(root, 'engine', 'libreoffice-kit', 'lib', 'cli.js'))
    const pruned = desktopOffice.resolveOfficeResources(config, resolveModule)
    expect('unavailable' in pruned && pruned.unavailable).toContain('LibreOffice Kit CLI is missing')
    const unresolvable = desktopOffice.resolveOfficeResources(config, () => { throw new Error('not installed') })
    expect('unavailable' in unresolvable && unresolvable.unavailable).toContain('LibreOffice Kit engine is not resolvable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('starts the Host without Office authoring when the payload is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-office-absent-'))
  const registered: unknown[] = []
  const ctx = { plugin: async (module: unknown) => { registered.push(module) } } as unknown as Context
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await desktopOffice.apply(ctx, {
      source: join(root, 'runtime', 'primary-runtime'), root: join(root, 'installed'), runtimeDir: join(root, 'dsh'),
    })
    expect(registered).toEqual([workspaceDependencies])
    expect(registered).not.toContain(officeSkills)
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).toContain('continuing without Office authoring')
    expect(String(warn.mock.calls[0]?.[0])).toContain('office-skills')
  } finally {
    warn.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

it('fails startup instead of degrading when the deployment requires Office authoring', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-office-required-'))
  const ctx = { plugin: async () => {} } as unknown as Context
  vi.stubEnv('DSH_DESKTOP_REQUIRE_OFFICE', '1')
  try {
    await expect(desktopOffice.apply(ctx, {
      source: join(root, 'runtime', 'primary-runtime'), root: join(root, 'installed'), runtimeDir: join(root, 'dsh'),
    })).rejects.toThrow(/DSH_DESKTOP_REQUIRE_OFFICE=1/)
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
