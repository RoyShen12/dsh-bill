/**
 * Host-platform helpers, borrowed from DSH when it is reachable.
 *
 * File replacement and cross-process locking are already solved inside DSH, by
 * `@deepseek-ai/dsh-atomic-write`, and that is the authority: `writeFileAtomic`
 * opens its temp sibling with exclusive create, so it refuses to follow a
 * symlink planted at the scratch path and carries explicit permission bits
 * through the rename.
 *
 * It cannot be imported statically. It is not a dependency of this package —
 * it belongs to the harness the plugin is mounted into — and a bare `import`
 * of a package that is only present in the host profile makes the whole module
 * fail to load in any other layout (a `link:`ed checkout resolves from the
 * checkout, not from the profile, and finds nothing). So it is probed once,
 * asynchronously, and every helper here works before and without it: the
 * fallbacks are the same behaviour written locally.
 *
 * The seam is drawn around the ASYNC I/O primitives only. Borrowing is worth a
 * probe when it buys real behaviour that is awkward to restate — O_EXCL temp
 * files, mode bits, locking — and those are already async, so the probe rides
 * along for free. It is not worth it for a synchronous three-line env read
 * (see `resolveDshHome`), where the probe would instead impose an ordering rule
 * on every caller.
 *
 * `withFileLock` is the reason this file exists rather than two inline
 * helpers. A temp-and-rename write is atomic against a READER, but two dsh
 * processes sharing one `$DSH_HOME` still interleave: the rollup is a
 * read-modify-write cycle, and without a lock the second writer's rename
 * silently discards what the first one just committed.
 *
 * @module dsh-bill/hostkit
 */

import { promises as fsPromises } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

/** Permission bits for the files this plugin writes: spend history is private. */
const FILE_MODE = 0o600
/** Permission bits for the directory holding them. */
const DIR_MODE = 0o700

/** Resolved `@deepseek-ai/dsh-atomic-write` module, or null until/unless probed. */
let atomicWrite = null

/**
 * One-shot probe for the optional host package.
 *
 * Awaited by the plugin's startup chain so the borrowed implementation is in
 * place before the first write, but never required: a rejected import leaves
 * the local fallback in charge for the process lifetime.
 */
export const hostkitReady = optionalHostImport('@deepseek-ai/dsh-atomic-write').then((mod) => {
  if (typeof mod?.writeFileAtomic === 'function' && typeof mod?.withFileLock === 'function') atomicWrite = mod
})

/**
 * Import a package that exists only inside the harness's own module graph.
 *
 * Try normal package resolution first. A linked checkout resolves from its
 * real path, outside the Host's module tree, so also try DSH_INSTALL_DIR (the
 * CLI package directory, including in Desktop's ASAR) and the Host entry for
 * older launches. Electron's entry is not necessarily the CLI script.
 * Import the resolved file as a URL so drive letters and special characters in
 * Windows paths work as well. If no Host copy loads, callers can degrade.
 */
export async function optionalHostImport(specifier) {
  try { return await import(specifier) } catch { /* try the Host's module tree */ }
  const installDir = process.env.DSH_INSTALL_DIR
  const anchors = [installDir && join(installDir, 'package.json'), process.argv[1]]
  for (const anchor of anchors) {
    if (!anchor || !isAbsolute(anchor)) continue
    try {
      const resolved = createRequire(anchor).resolve(specifier)
      return await import(pathToFileURL(resolved).href)
    } catch { /* try the next anchor */ }
  }
  return null
}

/**
 * Resolve the harness home: the configured `dshHome`, else `$DSH_HOME`, else
 * `~/.dsh`.
 *
 * The same precedence as `resolveDshHome` in `@deepseek-ai/dsh-home-paths`,
 * which the harness's own stores (`dsh-credentials-local`,
 * `dsh-attachment-local`, `dsh-skill-filesystem`, `dsh-shell-env`) resolve
 * their `dshHome` config through. An explicit path comes first because
 * `$DSH_HOME` belongs to the whole process, and one process can host several
 * harness instances that must not share a store. Whichever one wins is spelled
 * the way the harness spells it: a leading `~` is the OS home, and a relative
 * path is resolved against the working directory. That includes `$DSH_HOME`:
 * read raw, `DSH_HOME=~/x` put this store under a literal `./~/x` while the
 * harness kept its own under `$HOME/x`.
 *
 * Deliberately NOT borrowed from `@deepseek-ai/dsh-home-paths`, though that
 * package exports exactly this. Borrowing it would make the answer depend on
 * whether the async probe had landed yet — an "await the probe before
 * computing any path" rule that the startup chain can honour but the persist
 * queue and the backfill pass cannot, and which would let the file location
 * change under an in-flight write. Three lines of env reading are not worth a
 * startup-ordering discipline, and the rule they encode ("a blank override is
 * not an override") is stable enough to restate.
 *
 * The async seam below is kept for `writeFileAtomic` / `withFileLock`, which
 * borrow real behaviour — O_EXCL temp files, mode bits, cross-process locking
 * — and are already async, so the probe rides along for free.
 */
export function resolveDshHome(configured, env = process.env) {
  const fromEnv = env.DSH_HOME
  const chosen = configured ?? (fromEnv !== undefined && fromEnv.trim() ? fromEnv : join(homedir(), '.dsh'))
  return resolve(expandHome(chosen))
}

/** `~`, `~/...` and `~\...` against the OS home; any other path as given. */
function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Directories already created this process.
 *
 * Every write goes through `ensureParent`, and in the steady state that is one
 * `mkdir` per recorded model call (plus one per lock retry, which used to mean
 * up to 200 of them while waiting out a peer). The tree is created once and
 * then never disappears, so remembering it turns all but the first into
 * nothing. A failed `mkdir` is not remembered, so a transient error retries.
 */
const ensuredDirs = new Set()

/** Create a file's parent directory, private to the user. Idempotent. */
async function ensureParent(file) {
  const dir = dirname(file)
  if (ensuredDirs.has(dir)) return
  await fsPromises.mkdir(dir, { recursive: true, mode: DIR_MODE })
  ensuredDirs.add(dir)
}

/**
 * Replace a file's contents in one atomic step.
 *
 * `writeFile` truncates before it writes, so a process killed mid-write — or a
 * reader arriving mid-write — sees a half-written file. Rename is atomic on
 * one filesystem, so a reader sees either the old contents or the new ones.
 */
export async function writeFileAtomic(file, text) {
  // The borrowed implementation creates the tree itself, so only the fallback
  // path needs the directory prepared here.
  if (atomicWrite) {
    await atomicWrite.writeFileAtomic(file, text, { mode: FILE_MODE, dirMode: DIR_MODE })
    return
  }
  await ensureParent(file)
  // `wx` refuses to follow a symlink planted at the temp path, and the fresh
  // inode carries the mode through the rename. The pid keeps two processes
  // from colliding on the scratch name itself.
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  const handle = await fsPromises.open(temp, 'wx', FILE_MODE)
  try {
    try { await handle.writeFile(text, 'utf8') } finally { await handle.close() }
    await renameAtomicTemp(temp, file)
  } catch (error) {
    await fsPromises.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

// Match the Host's Windows replacement behavior when no Host library loads.
// Antivirus/indexer handles can briefly block rename. Keep the old target in
// place and publish the completed sibling only once Windows permits replacement.
const WINDOWS_TRANSIENT_RENAME_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM'])
async function renameAtomicTemp(temp, file) {
  for (let attempt = 0; ; attempt++) {
    try { return await fsPromises.rename(temp, file) } catch (error) {
      if (process.platform !== 'win32' || !WINDOWS_TRANSIENT_RENAME_ERRORS.has(error?.code) || attempt >= 8) throw error
    }
    await delay(Math.min(20 * 2 ** attempt, 200))
  }
}

/** Append to a file, creating it (and its directory) with private bits. */
export async function appendFilePrivate(file, text) {
  await ensureParent(file)
  await fsPromises.appendFile(file, text, { encoding: 'utf8', mode: FILE_MODE })
}

/** How long to keep retrying a lock another process is holding. */
const LOCK_TIMEOUT_MS = 5000
/** Age past which a lock file is assumed to be a crashed writer's leftover. */
const LOCK_STALE_MS = 30000

/**
 * Run `operation` while holding an exclusive lock on `file`.
 *
 * The lock is a `<file>.lock` sibling created with `wx`, so exactly one holder
 * wins. Readers never take it — the rename commit is already atomic for them;
 * it exists for the read-modify-write cycles, where two writers that each read
 * the old state would otherwise both write a state missing the other's change.
 *
 * The standalone fallback expires old lock files and fails on contention with
 * a lock that has not expired. The Host implementation checks holder PIDs
 * instead when available.
 */
export async function withFileLock(file, operation) {
  // Before either locker runs, and outside the retry loop either way: the tree
  // cannot vanish between attempts, and rebuilding it on every 25ms poll was
  // pure syscall churn.
  //
  // This has to happen even when the borrowed implementation is in use. Its
  // `writeFileAtomic` creates the parent, but its `withFileLock` does not —
  // that one's contract says "the parent directory must exist". Because the
  // lock is taken before the write, the first write into a fresh
  // `$DSH_HOME/dsh-bill` raised ENOENT on `<file>.lock` and nothing was ever
  // written: no records, no budget, no preferences.
  await ensureParent(file)
  if (atomicWrite) return atomicWrite.withFileLock(file, operation)
  const lock = `${file}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let retriedMissingLock = false
  let handle
  for (;;) {
    try {
      handle = await fsPromises.open(lock, 'wx', FILE_MODE)
      break
    } catch (error) {
      // Windows may report EPERM on an exclusive create of an existing file.
      const windowsPermission = process.platform === 'win32' && error?.code === 'EPERM'
      if (error?.code !== 'EEXIST' && !windowsPermission) throw error
      const stat = await fsPromises.lstat(lock).catch(() => null)
      if (!stat && windowsPermission) {
        // The holder can release between open and lstat. Retry once, but do
        // not interpret an actual permission denial as a contended lock.
        if (retriedMissingLock) throw error
        retriedMissingLock = true
      }
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fsPromises.rm(lock, { force: true }).catch(() => {})
      }
      if (Date.now() >= deadline) throw new Error(`dsh-bill: timed out waiting for writer lock at ${lock}`)
      await delay(25)
    }
  }
  try {
    await handle.close()
    return await operation()
  } finally {
    await fsPromises.rm(lock, { force: true }).catch(() => {})
  }
}

/** Read a file as utf8, or `null` when it does not exist. */
export async function readFileOrNull(file) {
  try {
    return await fsPromises.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}
