/** The one environment a pnpm operation starts from: what survives, what never does, and which explicit entry wins. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { packageOperationEnvironment } from '@deepseek-ai/dsh-plugin-manager'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('packageOperationEnvironment', () => {
  it('withholds credential-shaped names and harness identity from a package script', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-ambient')
    vi.stubEnv('DASHSCOPE_API_KEY', 'sk-ambient')
    vi.stubEnv('DSH_HOME', 'C:/dsh')
    vi.stubEnv('DSH_SESSION_ID', 'session')
    const env = packageOperationEnvironment()
    expect(env['DEEPSEEK_API_KEY']).toBeUndefined()
    expect(env['DASHSCOPE_API_KEY']).toBeUndefined()
    expect(env['DSH_HOME']).toBeUndefined()
    expect(env['DSH_SESSION_ID']).toBeUndefined()
  })

  it('drops the npm/pnpm configuration layer where a registry token normally lives', () => {
    vi.stubEnv('npm_config_registry', 'https://registry.example.test/')
    vi.stubEnv('NPM_CONFIG_REGISTRY', 'https://registry.example.test/')
    vi.stubEnv('npm_config__authToken', 'npm-token')
    const env = packageOperationEnvironment()
    expect(Object.keys(env).filter(name => /^npm_config_/i.test(name))).toEqual([])
  })

  it('keeps a proxy that names no user, and drops one that carries credentials', () => {
    vi.stubEnv('HTTP_PROXY', 'http://proxy.example.test:8080')
    vi.stubEnv('HTTPS_PROXY', 'http://user:password@proxy.example.test:8080')
    const env = packageOperationEnvironment()
    expect(env['HTTP_PROXY']).toBe('http://proxy.example.test:8080')
    expect(env['HTTPS_PROXY']).toBeUndefined()
  })

  it('keeps a certificate bundle, which is a path and not a credential', () => {
    vi.stubEnv('NODE_EXTRA_CA_CERTS', 'C:/certs/corporate.pem')
    expect(packageOperationEnvironment()['NODE_EXTRA_CA_CERTS']).toBe('C:/certs/corporate.pem')
  })

  it('lets the profile forward one deliberate entry past every scrub', () => {
    const deliberate = 'http://user:password@proxy.example.test:8080'
    vi.stubEnv('HTTPS_PROXY', deliberate)
    expect(packageOperationEnvironment({ HTTPS_PROXY: deliberate })['HTTPS_PROXY']).toBe(deliberate)
  })
})
