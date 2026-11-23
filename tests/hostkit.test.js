/**
 * A write into a `$DSH_HOME/dsh-bill` that does not exist yet must land.
 *
 * This is the first write of a fresh install, and it used to fail silently:
 * `withFileLock` delegated to the borrowed `@deepseek-ai/dsh-atomic-write`
 * before creating the parent, and that module's `withFileLock` — unlike its
 * `writeFileAtomic` — requires the parent to exist. The lock is taken first, so
 * the first lock of a fresh home raised ENOENT on `<file>.lock` and no byte was
 * ever written: no records, no budget, no preferences. The failure surfaced as
 * an error in the client and nothing on disk, which is why it read as "the
 * setting does not stick" rather than "the write never happened".
 *
 * Run: node tests/hostkit.test.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { withFileLock, writeFileAtomic, optionalHostImport, hostkitReady } = await import('../lib/hostkit.js')
await hostkitReady

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}

// Which implementation is in charge decides whether this test reaches the bug
// at all: the delegating path is the one that lacked the mkdir. Say so out
// loud, and let `npm test` in a harness checkout cover it.
const borrowed = await optionalHostImport('@deepseek-ai/dsh-atomic-write')
console.log(borrowed
  ? '  note: @deepseek-ai/dsh-atomic-write is resolvable — the delegating path is covered'
  : '  note: @deepseek-ai/dsh-atomic-write is not resolvable here — only the fallback is covered')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bill-hostkit-'))
const file = path.join(root, 'fresh', 'nested', 'prefs.json')
assert(!fs.existsSync(path.dirname(file)), 'the parent directory starts out missing')

let ran = false
await withFileLock(file, async () => {
  ran = true
  await writeFileAtomic(file, '{"currency":"EUR"}')
})

assert(ran, 'the locked operation ran')
assert(fs.existsSync(path.dirname(file)), 'the parent directory was created')
assert(fs.existsSync(file), 'the file was written')
assert(
  fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).currency === 'EUR',
  'the bytes survived the round trip',
)

// The Host library and fallback must both serialize overlapping updates and
// replace an existing file, the shape the rollup actually uses.
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'))
const { promise: entered, resolve: firstEntered } = deferred()
const { promise: hold, resolve: release } = deferred()
const first = withFileLock(file, async () => {
  const current = read()
  firstEntered()
  await hold
  await writeFileAtomic(file, JSON.stringify({ ...current, budgetAmount: 25 }))
})
await entered
const second = withFileLock(file, async () => {
  await writeFileAtomic(file, JSON.stringify({ ...read(), budgetPeriod: 'month' }))
})
await new Promise((resolve) => setTimeout(resolve, 60))
release()
await Promise.all([first, second])
const after = read()
assert(after.currency === 'EUR' && after.budgetAmount === 25 && after.budgetPeriod === 'month',
  'overlapping locked replacements preserve both changes')

// Resolve a Host-only package even when the plugin checkout and Host entry
// are elsewhere. Space and # also exercise URL conversion of the native path.
const host = path.join(root, 'Desktop # runtime', 'node_modules', '@fixture', 'dsh')
const helper = path.join(host, '..', 'host-helper')
fs.mkdirSync(host, { recursive: true })
fs.mkdirSync(helper, { recursive: true })
fs.writeFileSync(path.join(helper, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }))
fs.writeFileSync(path.join(helper, 'index.js'), 'export const detected = true')
const savedInstallDir = process.env.DSH_INSTALL_DIR
try {
  process.env.DSH_INSTALL_DIR = host
  const found = await optionalHostImport('@fixture/host-helper')
  assert(found?.detected === true, 'linked checkout borrows a module anchored at DSH_INSTALL_DIR')
} finally {
  if (savedInstallDir === undefined) delete process.env.DSH_INSTALL_DIR
  else process.env.DSH_INSTALL_DIR = savedInstallDir
  fs.rmSync(root, { recursive: true, force: true })
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall checks passed')
