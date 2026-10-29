/** Windows DACL verification for the credentials document. */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { broadPrincipalGrants, parseDiscretionaryAces, readFileSddl, resetAclCache } from '../src/windows-acl.ts'

/** SDDL of a document only its owner, SYSTEM and Administrators may read. */
const OWNER_ONLY = 'O:S-1-5-21-1-2-3-1001G:S-1-5-21-1-2-3-513D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;S-1-5-21-1-2-3-1001)'

describe('parseDiscretionaryAces', () => {
  it('reads the trustee and type of every discretionary ACE', () => {
    expect(parseDiscretionaryAces(OWNER_ONLY)).toEqual([
      { type: 'A', sid: 'S-1-5-18' },
      { type: 'A', sid: 'S-1-5-32-544' },
      { type: 'A', sid: 'S-1-5-21-1-2-3-1001' },
    ])
  })

  it('separates the DACL from the system ACL that follows it', () => {
    expect(parseDiscretionaryAces('O:S-1-5-18G:S-1-5-18D:PAI(A;;FA;;;BA)S:(AU;FA;SA;WD;;;WD)'))
      .toEqual([{ type: 'A', sid: 'S-1-5-32-544' }])
  })

  it('reports a missing DACL and a malformed one as unparseable', () => {
    expect(parseDiscretionaryAces('O:S-1-5-18G:S-1-5-18D:NO_ACCESS_CONTROL')).toBeNull()
    expect(parseDiscretionaryAces('O:S-1-5-18')).toBeNull()
    expect(parseDiscretionaryAces('D:(A;;FA;;;not-a-sid)')).toBeNull()
    expect(parseDiscretionaryAces('D:(A;;FA)')).toBeNull()
  })
})

describe('broadPrincipalGrants', () => {
  it('accepts a DACL held by the owner, SYSTEM and Administrators', () => {
    expect(broadPrincipalGrants(OWNER_ONLY)).toEqual([])
  })

  it('names every broad principal an allow-ACE grants', () => {
    expect(broadPrincipalGrants('D:AI(A;;FA;;;S-1-1-0)(A;;FR;;;S-1-5-11)(A;;FA;;;S-1-5-18)'))
      .toEqual(['Everyone (S-1-1-0)', 'Authenticated Users (S-1-5-11)'])
  })

  it('ignores a deny-ACE, which never opens the file', () => {
    expect(broadPrincipalGrants('D:AI(D;;FR;;;S-1-1-0)(A;;FA;;;S-1-5-18)')).toEqual([])
  })

  it('treats a null DACL as unprotected instead of passing it', () => {
    expect(broadPrincipalGrants('O:S-1-5-18G:S-1-5-18D:NO_ACCESS_CONTROL'))
      .toEqual(['the file has no discretionary ACL, so every process can read it'])
  })

  it('fails closed when the DACL cannot be parsed', () => {
    expect(broadPrincipalGrants('O:S-1-5-18G:S-1-5-18')).toEqual(['the file ACL could not be parsed as SDDL'])
  })
})

describe.skipIf(process.platform !== 'win32')('readFileSddl on a real file', () => {
  let directory = ''
  let file = ''

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'dsh-acl-'))
    file = join(directory, '.credentials.yaml')
    writeFileSync(file, 'version: 1\n')
    resetAclCache()
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('reads the DACL the OS reports for the file', () => {
    expect(readFileSddl(file, 'stamp-1')).toMatch(/^D:/u)
  })

  it('refuses a document Everyone can read, and accepts it once that grant is gone', () => {
    execFileSync('icacls', [file, '/grant', '*S-1-1-0:(R)'], { windowsHide: true, stdio: 'ignore' })
    resetAclCache()
    expect(broadPrincipalGrants(readFileSddl(file, 'stamp-2'))).toEqual(['Everyone (S-1-1-0)'])
    execFileSync('icacls', [file, '/remove', '*S-1-1-0'], { windowsHide: true, stdio: 'ignore' })
    resetAclCache()
    expect(broadPrincipalGrants(readFileSddl(file, 'stamp-3'))).toEqual([])
  })

  it('treats an unreadable path as a failure rather than assuming protection', () => {
    expect(() => readFileSddl(join(directory, 'missing.yaml'), 'stamp-4')).toThrow(/could not read the ACL/u)
  })
})
