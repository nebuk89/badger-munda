import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const root = path.resolve(import.meta.dirname, '..')
const entry = 'api/[...path].ts'

function relativeImports(filename: string) {
  const source = readFileSync(path.join(root, filename), 'utf8')
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const imports: Array<{ specifier: string; runtime: boolean }> = []

  sourceFile.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return
    const clause = node.importClause
    const named = clause?.namedBindings
    const runtime = !clause?.isTypeOnly && (
      !clause
      || Boolean(clause.name)
      || Boolean(named && ts.isNamespaceImport(named))
      || Boolean(named && ts.isNamedImports(named) && named.elements.some((element) => !element.isTypeOnly))
    )
    imports.push({ specifier: node.moduleSpecifier.text, runtime })
  })

  return imports.filter(({ specifier }) => specifier.startsWith('.'))
}

function sourcePath(importer: string, specifier: string) {
  assert.match(
    specifier,
    /\.js$/,
    `${importer} must use a .js specifier so Vercel's emitted ESM can resolve it`,
  )
  const imported = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier))
  const source = imported.replace(/\.js$/, '.ts')
  assert.ok(existsSync(path.join(root, source)), `${importer} imports missing source ${source}`)
  return source
}

test('Vercel function config covers a deployable JavaScript dependency closure', () => {
  const config = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8')) as {
    functions?: Record<string, unknown>
  }
  assert.ok(config.functions?.[entry], `vercel.json must configure ${entry}`)

  const pending = [entry]
  const runtimeFiles = new Set<string>()
  while (pending.length) {
    const filename = pending.pop()!
    if (runtimeFiles.has(filename)) continue
    runtimeFiles.add(filename)
    for (const dependency of relativeImports(filename)) {
      const source = sourcePath(filename, dependency.specifier)
      if (dependency.runtime) pending.push(source)
    }
  }

  assert.deepEqual([...runtimeFiles].sort(), [
    'api/[...path].ts',
    'server/config.ts',
    'server/hosted/app.ts',
    'server/hosted/catalog.ts',
    'server/hosted/crypto.ts',
    'server/hosted/db/client.ts',
    'server/hosted/device-store.ts',
    'server/hosted/env.ts',
    'server/hosted/password.ts',
    'server/hosted/store.ts',
    'server/station-engine.ts',
    'server/station.ts',
    'shared/game-events.ts',
  ])
})
