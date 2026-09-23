import { opendir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { put } from '@vercel/blob'

async function files(directory: string): Promise<string[]> {
  const result: string[] = []
  const entries = await opendir(directory)
  for await (const entry of entries) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await files(filename))
    else if (entry.isFile()) result.push(filename)
  }
  return result
}

const root = path.resolve(process.argv[2] ?? 'generated/hosted')
const token = process.env.BLOB_READ_WRITE_TOKEN
if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is required.')

const active = JSON.parse(await readFile(path.join(root, 'active-catalog.json'), 'utf8')) as {
  catalogHash: string
}
const contentRoot = path.join(root, 'content', 'v1', active.catalogHash)
const uploaded: Record<string, string> = {}
for (const filename of await files(contentRoot)) {
  const relative = path.relative(root, filename).split(path.sep).join('/')
  const blob = await put(relative, await readFile(filename), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: false,
    cacheControlMaxAge: 31_536_000,
    token,
  })
  uploaded[relative] = blob.url
}
console.log(JSON.stringify({ catalogHash: active.catalogHash, uploaded }, null, 2))
