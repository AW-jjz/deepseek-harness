/**
 * One environment builder for every pnpm invocation, so a package operation is
 * handed the same thing whether it was started from `dsh plugin install` or by
 * the running Host.
 *
 * @module @deepseek-ai/dsh-plugin-manager/install-environment
 */

import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/** npm and pnpm put their whole configuration — registry tokens included — in this name shape. */
const NPM_CONFIG_NAME = /^npm_config_/i

/** The transport variables a child Node reads for its own requests. */
const PROXY_NAME = /^(?:https?|ftp|all|no)_proxy$/i

/** A URL whose authority carries credentials: `scheme://user:password@host`. */
const PROXY_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/i

/**
 * The environment one pnpm operation starts from.
 *
 * Two kinds of value must not reach it. The first is credential-shaped at all
 * (the ambient scrub already removes `*_KEY`, `*_PASSWORD`, `*_SECRET`,
 * `*_TOKEN` and the harness's own `DSH_*` names). The second is transport
 * configuration that carries credentials for this machine: the `npm_config_*`
 * layer, where a registry token normally lives, and proxy URLs with userinfo
 * embedded. Package lifecycle scripts are exactly the process this is withheld
 * from — they run third-party code, and either value is a working credential.
 *
 * The cost is deliberate and recorded (audit P1-33): a user behind an
 * authenticated proxy, or one whose private registry is authenticated through
 * the environment rather than `.npmrc`, loses that ambient routing. The escape
 * hatch is `extra`, which merges after every scrub, so the one variable an
 * operator actually needs goes into the profile's `packageManager.env` instead
 * of being exported for every child on the machine.
 *
 * `NODE_EXTRA_CA_CERTS` and the rest of the locale, path, and certificate
 * variables survive: an allowlist here would silently break corporate
 * registries and Windows terminals, and neither of those is a credential.
 * @param extra Explicit entries from the calling profile, merged last so they win.
 * @returns A fresh environment object for one pnpm invocation.
 */
export function packageOperationEnvironment(
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  const forwarded: Record<string, string> = {}
  for (const [name, value] of Object.entries(scrubbedParentEnv())) {
    if (NPM_CONFIG_NAME.test(name)) continue
    if (PROXY_NAME.test(name) && PROXY_WITH_CREDENTIALS.test(value)) continue
    forwarded[name] = value
  }
  return { ...forwarded, ...extra }
}
