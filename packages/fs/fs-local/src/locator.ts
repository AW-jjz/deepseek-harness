/**
 * Model-facing locator schemes for the local backend: a path written
 * `<scheme>:/<relative>` names a file under a registered directory instead of at
 * an absolute position. A locator persisted in a session log therefore keeps
 * resolving after the directory moves — a relocated harness home, a renamed
 * portable install — because both sides recompute the directory from the same
 * configuration instead of storing it in every reference.
 *
 * @module @deepseek-ai/dsh-fs-local/locator
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import { FsError } from '@deepseek-ai/dsh-fs'

/**
 * One registered scheme: the model-facing name and the directory it names. Both
 * halves are configuration, so a scheme resolves to the CURRENT directory on
 * every call rather than to a path captured when the locator was written.
 */
export interface LocatorRoot {
  /** Scheme as written before the colon — at least two characters, lowercase, no `:`/separator. */
  scheme: string
  /** Absolute directory the scheme's paths resolve under, resolved at construction. */
  root: string
}

/**
 * A scheme is a lower-case URI-ish token of at least two characters. Requiring
 * two characters keeps a single letter from claiming a Windows drive prefix,
 * and the leading letter keeps the locator distinguishable from a relative path.
 */
const SCHEME = /^[a-z][a-z0-9+.-]+$/

/**
 * Validate configured locator roots into the form {@link expandLocatorPath}
 * uses, resolving each directory against the process working directory once so
 * a later `cwd` change cannot reinterpret it.
 *
 * @param roots - configured `{ scheme, root }` entries; `undefined` registers nothing.
 * @returns the validated entries, in registration order.
 * @throws Error when a scheme is malformed or repeated, or a root is not absolute.
 */
export function parseLocatorRoots(roots: readonly { scheme: string; root: string }[] | undefined): LocatorRoot[] {
  if (roots === undefined) return []
  const seen = new Set<string>()
  return roots.map((entry) => {
    if (!SCHEME.test(entry.scheme)) {
      throw new Error(`fs-local: locator scheme "${entry.scheme}" must be a lower-case token of at least two characters ([a-z][a-z0-9+.-]*)`)
    }
    if (seen.has(entry.scheme)) throw new Error(`fs-local: locator scheme "${entry.scheme}" is registered twice`)
    seen.add(entry.scheme)
    const root = entry.root.trim()
    if (root.length === 0 || !isAbsolute(root)) {
      throw new Error(`fs-local: locator scheme "${entry.scheme}" needs an absolute directory (got "${entry.root}")`)
    }
    return { scheme: entry.scheme, root: resolve(root) }
  })
}

/**
 * Rewrite a registered locator into the absolute path it names, leaving every
 * other path untouched. This runs before any other spelling rule, so a locator
 * never falls through to relative resolution against the session `cwd`.
 *
 * The relative part is joined under the registered directory and then
 * containment-checked: a locator whose segments climb out (`<scheme>:/../../etc`)
 * is refused rather than silently opened, because the only legitimate writer of
 * a locator is the backend that owns the directory.
 *
 * @param path - the requested path or locator.
 * @param roots - registered schemes from {@link parseLocatorRoots}.
 * @returns the absolute path a registered scheme names, else `path` unchanged.
 * @throws FsError `FS_NOT_FOUND` for a scheme with no file part,
 *   `FS_PERMISSION_DENIED` when the remainder leaves the registered directory.
 */
export function expandLocatorPath(path: string, roots: readonly LocatorRoot[]): string {
  if (roots.length === 0) return path
  for (const { scheme, root } of roots) {
    if (!path.startsWith(`${scheme}:`)) continue
    const rest = path.slice(scheme.length + 1).replace(/^[/\\]+/, '')
    if (rest.length === 0) {
      throw new FsError(`cannot resolve "${path}": the ${scheme} locator names no file`, 'FS_NOT_FOUND')
    }
    const target = resolve(root, ...rest.split(/[/\\]+/))
    const inside = relative(root, target)
    if (inside.length === 0 || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new FsError(`cannot resolve "${path}": the ${scheme} locator leaves its registered directory`, 'FS_PERMISSION_DENIED')
    }
    return target
  }
  return path
}
