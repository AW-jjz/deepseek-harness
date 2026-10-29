/**
 * Windows credentials-file protection: refuse to serve secrets out of a file whose DACL
 * grants a broad principal read access.
 *
 * POSIX answers this with permission bits. NTFS has no such bits, so the check reads the
 * DACL as SDDL and rejects only *granted* access to well-known broad principals — Everyone,
 * Authenticated Users, Users, Interactive, Guests. SIDs are language independent, so this
 * keeps working on a localized Windows while leaving ordinary per-user grants (the current
 * user, Administrators, SYSTEM) alone.
 */

import { spawnSync } from 'node:child_process'

/**
 * Principals whose read access to a credentials document is unacceptable.
 *
 * These are the well-known SIDs every such grant renders as, not display names: SDDL carries
 * either the SID or a two-letter alias for a well-known principal, and both are mapped here so a
 * localized Windows cannot change the answer. AppContainer package SIDs (`S-1-15-2-*`) are
 * deliberately not on this list: Windows adds them by inheritance on many user-profile trees, and
 * a check that refused those would refuse to start on ordinary machines.
 */
const BROAD_PRINCIPALS: ReadonlyMap<string, string> = new Map([
  ['S-1-1-0', 'Everyone'],
  ['S-1-5-2', 'Network'],
  ['S-1-5-4', 'Interactive'],
  ['S-1-5-7', 'Anonymous Logon'],
  ['S-1-5-11', 'Authenticated Users'],
  ['S-1-5-32-545', 'Users'],
  ['S-1-5-32-546', 'Guests'],
  ['S-1-5-32-547', 'Power Users'],
  ['S-1-5-32-555', 'Remote Desktop Users'],
  ['S-1-5-32-562', 'Distributed COM Users'],
])

/**
 * Two-letter SDDL aliases for well-known principals.
 *
 * `GetSecurityDescriptorSddlForm` emits these instead of a SID whenever the trustee is a
 * well-known one, so an unaliased parser rejects almost every real DACL.
 */
const TRUSTEE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['WD', 'S-1-1-0'],
  ['CO', 'S-1-3-0'],
  ['CG', 'S-1-3-1'],
  ['OW', 'S-1-3-4'],
  ['NU', 'S-1-5-2'],
  ['IU', 'S-1-5-4'],
  ['SU', 'S-1-5-6'],
  ['AN', 'S-1-5-7'],
  ['AU', 'S-1-5-11'],
  ['RC', 'S-1-5-12'],
  ['SY', 'S-1-5-18'],
  ['LS', 'S-1-5-19'],
  ['NS', 'S-1-5-20'],
  ['BA', 'S-1-5-32-544'],
  ['BU', 'S-1-5-32-545'],
  ['GU', 'S-1-5-32-546'],
  ['PU', 'S-1-5-32-547'],
  ['RD', 'S-1-5-32-555'],
  ['NO', 'S-1-5-32-556'],
])

/** One discretionary ACE, reduced to the two fields this check reads. */
interface DiscretionaryAce {
  /** `A` (allow), `D` (deny), `OA`/`OD` (object), or `AU`/`AL`/… (audit kinds, ignored here). */
  type: string
  /** The trustee SID. */
  sid: string
}

/**
 * Parse the discretionary part of one SDDL string.
 *
 * SDDL is `O:<owner>G:<group>D:<flags><aces>S:<sacl>`; an ACE is
 * `(type;flags;rights;objectGuid;inheritObjectGuid;trustee)`. Only the trustee and the ACE
 * type carry meaning for this check, and a malformed ACE makes the whole read fail closed.
 * @param sddl - SDDL as returned by `(Get-Acl -LiteralPath $p).Sddl`.
 * @returns Every discretionary ACE, or `null` when the DACL is absent or unparseable.
 */
export function parseDiscretionaryAces(sddl: string): DiscretionaryAce[] | null {
  const start = sddl.indexOf('D:')
  if (start < 0) return null
  const section = sddl.slice(start + 2)
  // The DACL flags precede the first ACE and end at the system ACL or the end of the string.
  const systemStart = section.indexOf('S:')
  const dacl = systemStart < 0 ? section : section.slice(0, systemStart)
  if (dacl.startsWith('NO_ACCESS_CONTROL')) return null
  if (dacl.startsWith('PAI') || dacl.startsWith('AI')) {
    return parseAceList(dacl.replace(/^(?:PAI|AI|AR|NO_ACCESS_CONTROL)+/u, ''))
  }
  return parseAceList(dacl)
}

/**
 * Split a DACL body into ACEs.
 * @param body - the DACL after its flags.
 * @returns the parsed ACEs, or `null` when any ACE is malformed.
 */
function parseAceList(body: string): DiscretionaryAce[] | null {
  const aces: DiscretionaryAce[] = []
  for (const match of body.matchAll(/\(([^()]*)\)/gu)) {
    const fields = (match[1] ?? '').split(';')
    if (fields.length < 6) return null
    const type = fields[0] ?? ''
    const trustee = fields[fields.length - 1] ?? ''
    if (type === '') return null
    const sid = TRUSTEE_ALIASES.get(trustee) ?? trustee
    if (!/^S-\d+(-\d+)+$/u.test(sid)) return null
    aces.push({ type, sid })
  }
  return aces
}

/**
 * Describe every broad-principal grant in one DACL.
 *
 * A document with no DACL at all (`NO_ACCESS_CONTROL`) grants everyone, so it is reported as
 * unprotected rather than silently passing.
 * @param sddl - SDDL as returned by `(Get-Acl -LiteralPath $p).Sddl`.
 * @returns Human-readable findings; empty means no broad principal was granted access.
 */
export function broadPrincipalGrants(sddl: string): string[] {
  const aces = parseDiscretionaryAces(sddl)
  if (aces === null) {
    return [sddl.includes('NO_ACCESS_CONTROL')
      ? 'the file has no discretionary ACL, so every process can read it'
      : 'the file ACL could not be parsed as SDDL']
  }
  const findings: string[] = []
  for (const ace of aces) {
    // Only allow-ACEs grant; deny- and audit-ACEs never open the file to anyone.
    if (ace.type !== 'A' && !ace.type.startsWith('OA') && !ace.type.startsWith('XA')) continue
    const name = BROAD_PRINCIPALS.get(ace.sid)
    if (name !== undefined) findings.push(`${name} (${ace.sid})`)
  }
  return findings
}

/** SDDL readings keyed by path, reused while the file is unchanged. */
const sddlCache = new Map<string, { stamp: string; sddl: string }>()

/**
 * Read one file's DACL as SDDL.
 *
 * `System.IO.File.GetAccessControl` is available to every Windows PowerShell without loading the
 * `Microsoft.PowerShell.Security` module (which `Get-Acl` needs and which is not autoloadable in
 * some host configurations). The path travels through the environment rather than the command
 * line, so no quoting rule can alter it, and SDDL carries SIDs rather than localized names.
 * @param filename - absolute path of the document.
 * @param stamp - change stamp of the file the caller already stat'ed.
 * @returns the SDDL string.
 * @throws when the OS cannot report an ACL; callers must treat that as unprotected.
 */
export function readFileSddl(filename: string, stamp: string): string {
  const cached = sddlCache.get(filename)
  if (cached?.stamp === stamp) return cached.sddl
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "[System.IO.File]::GetAccessControl($env:DSH_ACL_PATH).GetSecurityDescriptorSddlForm('Access')",
  ], { encoding: 'utf8', windowsHide: true, env: { ...process.env, DSH_ACL_PATH: filename } })
  if (result.error !== undefined) throw result.error
  const sddl = result.stdout.trim()
  if (result.status !== 0 || sddl === '') {
    throw new Error(`credentials-local: could not read the ACL of ${filename}: ${result.stderr.trim() || `exit ${String(result.status)}`}`)
  }
  if (sddlCache.size >= 32) sddlCache.clear()
  sddlCache.set(filename, { stamp, sddl })
  return sddl
}

/**
 * Clear the ACL reading cache. Tests use it; production code never needs it.
 */
export function resetAclCache(): void {
  sddlCache.clear()
}
