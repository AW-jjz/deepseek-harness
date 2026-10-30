/**
 * Durable record of which project-local skills a human enabled for model use.
 *
 * A project skill root (`.dsh/skills`, `.agents/skills`) is authored by whoever
 * owns the checked-out repository, so discovering a body there is not a decision
 * to hand that body to a model. Each entry therefore pins the exact SHA-256 of
 * the decoded instruction file that was approved: editing the skill (or pulling
 * a commit that edits it) revokes the approval and the skill returns to the
 * pending state instead of inheriting trust from an earlier decision.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { readFile, rename, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Current on-disk schema version; unknown versions are read as unapproved. */
const STORE_VERSION = 1

/** Entry recorded for one approved skill under one project root. */
export interface SkillApprovalEntry {
  /** SHA-256 of the decoded instruction file at approval time. */
  readonly sha256: string
  /** ISO-8601 instant of the approving decision. */
  readonly approvedAt: string
}

/** One project's approved skills, keyed by skill name. */
export interface SkillApprovalProject {
  /** Project root as the discovering session reported it. */
  readonly root: string
  /** Approved skills by name. */
  readonly skills: Readonly<Record<string, SkillApprovalEntry>>
}

interface StoreDocument {
  version: number
  projects: Record<string, { root: string; skills: Record<string, SkillApprovalEntry> }>
}

/**
 * Digest of the decoded instruction text; the value a project approval pins.
 * @param text - decoded file text read through the filesystem service or Node I/O.
 * @returns lowercase hexadecimal SHA-256 of the UTF-8 encoding of `text`.
 */
export function skillDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Stable storage key for one project root.
 * Windows paths compare case-insensitively, so the key folds case there and
 * keeps the reported spelling only for display.
 */
function projectKey(root: string): string {
  return process.platform === 'win32' ? root.toLowerCase() : root
}

function emptyDocument(): StoreDocument {
  return { version: STORE_VERSION, projects: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a stored document, discarding anything this module cannot fully trust.
 * @param value - parsed JSON of an existing store file.
 * @returns the document, or an empty one when the shape is unrecognized.
 */
function readDocument(value: unknown): StoreDocument {
  if (!isRecord(value) || value.version !== STORE_VERSION || !isRecord(value.projects)) {
    return emptyDocument()
  }
  const projects: StoreDocument['projects'] = {}
  for (const [key, project] of Object.entries(value.projects)) {
    if (!isRecord(project) || typeof project.root !== 'string' || !isRecord(project.skills)) continue
    const skills: Record<string, SkillApprovalEntry> = {}
    for (const [name, entry] of Object.entries(project.skills)) {
      if (!isRecord(entry) || typeof entry.sha256 !== 'string' || typeof entry.approvedAt !== 'string') continue
      skills[name] = { sha256: entry.sha256, approvedAt: entry.approvedAt }
    }
    projects[key] = { root: project.root, skills }
  }
  return { version: STORE_VERSION, projects }
}

/** Callback invoked when the store cannot be read or written. */
export type SkillApprovalLogger = (message: string) => void

/** Answers the model-invocation question for one discovered project skill. */
export interface SkillApprovalGate {
  /** Whether the gate applies at all; a disabled gate approves every discovery. */
  readonly enabled: boolean
  /**
   * Decide whether one discovered project skill may reach a model.
   * @param root - project root that owns the skill root.
   * @param name - skill name from the instruction file frontmatter.
   * @param digest - digest of the decoded instruction file just parsed.
   * @returns whether an unexpired approval covers this exact content.
   */
  isApproved(root: string, name: string, digest: string): Promise<boolean>
}

/**
 * File-backed approval store shared by the discovering provider and the
 * human-facing command that writes decisions.
 *
 * Reads are cached after the first successful load; writes are serialized so a
 * concurrent approve/revoke pair cannot interleave read-modify-write cycles.
 * Failures never throw into discovery: an unreadable store reads as "nothing
 * approved", which fails closed.
 */
export class SkillApprovalStore implements SkillApprovalGate {
  /** Absolute path of the backing JSON file. */
  readonly file: string
  private cached: { key: string; document: StoreDocument } | undefined
  private pending: Promise<void> = Promise.resolve()
  private readonly logger: SkillApprovalLogger | undefined
  private readonly now: () => Date
  private readonly onChange: (() => void) | undefined
  /** Whether a recorded approval is required before a project skill reaches a model. */
  readonly enabled: boolean

  /**
   * Create one store bound to a harness home directory.
   * @param options - home directory, enabled flag, and optional diagnostics hooks.
   */
  constructor(options: {
    readonly dshHome: string
    readonly enabled: boolean
    readonly logger?: SkillApprovalLogger
    readonly now?: () => Date
    /**
     * Notified after this instance writes a decision. The discovering provider
     * uses it to invalidate its catalog: an approval the registry cache never
     * hears about would not take effect until some unrelated file changed.
     */
    readonly onChange?: () => void
  }) {
    this.file = join(options.dshHome, 'skill-approvals.json')
    this.enabled = options.enabled
    this.logger = options.logger
    this.now = options.now ?? (() => new Date())
    this.onChange = options.onChange
  }

  /**
   * Whether an exact-content approval exists for one project skill.
   * @param root - project root owning the skill root.
   * @param name - skill name.
   * @param digest - digest of the decoded instruction file.
   * @returns whether the gate is disabled or the stored digest matches.
   */
  async isApproved(root: string, name: string, digest: string): Promise<boolean> {
    if (!this.enabled) return true
    const document = await this.load()
    const project = document.projects[projectKey(root)]
    return project?.skills[name]?.sha256 === digest
  }

  /**
   * Record approval of one project skill at its current content digest.
   * @param root - project root owning the skill root.
   * @param name - skill name.
   * @param digest - digest of the decoded instruction file.
   * @returns the recorded entry.
   */
  async approve(root: string, name: string, digest: string): Promise<SkillApprovalEntry> {
    const entry: SkillApprovalEntry = { sha256: digest, approvedAt: this.now().toISOString() }
    await this.mutate((document) => {
      const key = projectKey(root)
      const project = document.projects[key] ?? { root, skills: {} }
      project.skills[name] = entry
      document.projects[key] = project
    })
    return entry
  }

  /**
   * Drop one project skill's approval, or every approval under one project.
   * @param root - project root owning the skill root.
   * @param name - skill name, or `undefined` to revoke the whole project.
   * @returns whether a record was removed.
   */
  async revoke(root: string, name?: string): Promise<boolean> {
    const key = projectKey(root)
    let removed = false
    await this.mutate((document) => {
      const project = document.projects[key]
      if (project === undefined) return
      if (name === undefined) {
        document.projects = Object.fromEntries(
          Object.entries(document.projects).filter(([entryKey]) => entryKey !== key),
        )
        removed = true
        return
      }
      if (project.skills[name] === undefined) return
      document.projects[key] = {
        root: project.root,
        skills: Object.fromEntries(
          Object.entries(project.skills).filter(([skillName]) => skillName !== name),
        ),
      }
      removed = true
    })
    return removed
  }

  /**
   * List the approvals recorded for one project.
   * @param root - project root owning the skill root.
   * @returns approved entries by skill name.
   */
  async list(root: string): Promise<Readonly<Record<string, SkillApprovalEntry>>> {
    const document = await this.load()
    return document.projects[projectKey(root)]?.skills ?? {}
  }

  private async load(): Promise<StoreDocument> {
    // Revalidate against (mtime, size) rather than reading once: a human-facing
    // command or a second provider instance writes the same file, and a cached
    // document would otherwise keep enforcing a decision the user already
    // reversed in the other instance.
    let key = ''
    try {
      const info = await stat(this.file)
      key = `${info.mtimeMs}:${info.size}`
      if (this.cached?.key === key) return this.cached.document
    } catch (error) {
      // A remembered absent document means this failure already surfaced; one
      // warning per broken store is enough when every catalog read asks again.
      if (this.cached?.key === '') return this.cached.document
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.(`skill approvals unreadable at ${this.file}: ${String(error)}`)
      }
      const absent = emptyDocument()
      this.cached = { key: '', document: absent }
      return absent
    }
    return this.read(key)
  }

  private async read(key: string): Promise<StoreDocument> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      this.logger?.(`skill approvals unreadable at ${this.file}: ${String(error)}`)
      const absent = emptyDocument()
      this.cached = { key: '', document: absent }
      return absent
    }
    let document: StoreDocument
    try {
      document = readDocument(JSON.parse(text))
    } catch (error) {
      // A corrupt store must fail closed and stay recoverable by an approval
      // written later, so it is replaced rather than trusted or deleted.
      this.logger?.(`skill approvals ignored at ${this.file}: ${String(error)}`)
      document = emptyDocument()
    }
    this.cached = { key, document }
    return document
  }

  private async mutate(change: (document: StoreDocument) => void): Promise<void> {
    const write = this.pending.then(async () => {
      const document = await this.load()
      const next: StoreDocument = { version: STORE_VERSION, projects: {} }
      for (const [key, project] of Object.entries(document.projects)) {
        next.projects[key] = { root: project.root, skills: { ...project.skills } }
      }
      change(next)
      await this.persist(next)
      // Force the next read to observe the file this write just produced.
      this.cached = undefined
    })
    this.pending = write.catch(() => {
      // The caller observes the failure; this chain only keeps writes ordered.
    })
    await write
    this.onChange?.()
  }

  private async persist(document: StoreDocument): Promise<void> {
    const text = `${JSON.stringify(document, null, 2)}\n`
    const staging = `${this.file}.${process.pid}.tmp`
    // Staged write plus rename: a crash mid-write must not leave a truncated
    // store, because a truncated store reads as "nothing approved".
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(staging, text, { encoding: 'utf8', mode: 0o600 })
    await rename(staging, this.file)
  }
}
