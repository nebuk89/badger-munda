import { createHash } from 'node:crypto'
import { opendir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { put } from '@vercel/blob'
import { parseHostedCatalog, type HostedCatalog } from '../server/hosted/catalog.ts'

interface PackageAsset {
  absolutePath: string
  pathname: string
  contentType: string
  bytes: Buffer
}

export function resolveBlobAuthOptions(
  token: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): { token?: string } {
  if (token !== undefined) {
    if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is required unless --dry-run is set.')
    return { token }
  }
  if (environment.VERCEL_OIDC_TOKEN && environment.BLOB_STORE_ID) return {}
  if (!environment.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN is required unless --dry-run is set.')
  }
  return { token: environment.BLOB_READ_WRITE_TOKEN }
}

function digest(value: Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

async function files(directory: string): Promise<string[]> {
  const result: string[] = []
  const entries = await opendir(directory)
  for await (const entry of entries) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await files(filename))
    else if (entry.isFile()) result.push(filename)
  }
  return result.sort()
}

function assetType(filename: string) {
  if (filename.endsWith('.ubf')) return 'application/octet-stream'
  if (filename.endsWith('.png')) return 'image/png'
  if (filename.endsWith('.mp4')) return 'video/mp4'
  if (filename.endsWith('.json')) return 'application/json'
  throw new Error(`The hosted package contains an unsupported file: ${filename}`)
}

function checkFrame(bytes: Buffer, frameId: number, filename: string) {
  if (
    bytes.length < 28
    || bytes.subarray(0, 4).toString() !== 'UBF1'
    || bytes[8] !== 4
    || bytes.readUInt32LE(12) !== frameId
    || bytes.readUInt32LE(16) !== bytes.length - 20
    || !bytes.subarray(20, 28).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new Error(`The hosted package contains an invalid indexed-PNG frame: ${filename}`)
  }
}

function expectedFiles(catalog: HostedCatalog) {
  const expected = new Map<string, { hash?: string; frameId?: number }>()
  expected.set('catalog.json', {})
  for (const clip of catalog.clips) {
    expected.set(clip.posterPath, { hash: clip.posterHash })
    expected.set(clip.videoPath, { hash: clip.videoHash })
    for (let index = 0; index < clip.frameCount; index++) {
      expected.set(clip.framePaths[index], {
        hash: clip.frameHashes[index],
        frameId: clip.frameIds[index],
      })
    }
  }
  return expected
}

export async function checkHostedPackage(root = path.resolve('generated', 'hosted')) {
  const active = JSON.parse(await readFile(path.join(root, 'active-catalog.json'), 'utf8')) as {
    version?: unknown
    catalogHash?: unknown
    catalogPath?: unknown
  }
  if (
    active.version !== 1
    || typeof active.catalogHash !== 'string'
    || active.catalogPath !== `content/v1/${active.catalogHash}/catalog.json`
  ) {
    throw new Error('The active hosted catalog pointer is invalid.')
  }
  const contentRoot = path.join(root, 'content', 'v1', active.catalogHash)
  const catalog = parseHostedCatalog(JSON.parse(await readFile(path.join(contentRoot, 'catalog.json'), 'utf8')))
  if (catalog.catalogHash !== active.catalogHash) {
    throw new Error('The active hosted catalog hash does not match the package directory.')
  }
  const expected = expectedFiles(catalog)
  const packaged = await files(contentRoot)
  const relativeFiles = packaged.map((filename) => path.relative(contentRoot, filename).split(path.sep).join('/'))
  if (
    relativeFiles.some((filename) => filename.endsWith('.rgba'))
    || relativeFiles.length !== expected.size
    || relativeFiles.some((filename) => !expected.has(filename))
  ) {
    throw new Error('The hosted package does not match the immutable catalog asset list.')
  }
  const assets: PackageAsset[] = []
  for (const filename of relativeFiles) {
    const absolutePath = path.join(contentRoot, filename)
    const bytes = await readFile(absolutePath)
    const metadata = expected.get(filename)!
    if (metadata.hash && digest(bytes) !== metadata.hash) {
      throw new Error(`The hosted package hash does not match the catalog: ${filename}`)
    }
    if (metadata.frameId !== undefined) checkFrame(bytes, metadata.frameId, filename)
    assets.push({
      absolutePath,
      pathname: `content/v1/${catalog.catalogHash}/${filename}`,
      contentType: assetType(filename),
      bytes,
    })
  }
  return { catalog, assets }
}

export async function uploadHostedContent(
  root = path.resolve('generated', 'hosted'),
  options: { dryRun?: boolean; token?: string } = {},
) {
  const checked = await checkHostedPackage(root)
  if (options.dryRun) {
    return {
      catalogHash: checked.catalog.catalogHash,
      assetCount: checked.assets.length,
      totalBytes: checked.assets.reduce((sum, asset) => sum + asset.bytes.length, 0),
      catalogPath: `content/v1/${checked.catalog.catalogHash}/catalog.json`,
    }
  }
  const authOptions = resolveBlobAuthOptions(options.token)
  const uploaded: Record<string, string> = {}
  for (const asset of checked.assets) {
    const blob = await put(asset.pathname, asset.bytes, {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 31_536_000,
      contentType: asset.contentType,
      ...authOptions,
    })
    uploaded[asset.pathname] = blob.url
  }
  return { catalogHash: checked.catalog.catalogHash, uploaded }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const dryRun = process.argv.includes('--dry-run')
  console.log(JSON.stringify(await uploadHostedContent(undefined, { dryRun }), null, 2))
}
