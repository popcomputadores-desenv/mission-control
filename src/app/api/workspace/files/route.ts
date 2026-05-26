import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import fs from 'fs'
import path from 'path'

// Base dir where openclaw-pvc is mounted read-only inside the MC container.
// Populated from env var set in dep_all_in_one.yaml (OPENCLAW_WORKSPACE_DIR).
// /mnt/openclaw-workspace/workspace/ is the git repo written by the agent.
const OPENCLAW_BASE = process.env.OPENCLAW_WORKSPACE_DIR ?? '/mnt/openclaw-workspace'
const WORKSPACE_DIR = path.join(OPENCLAW_BASE, 'workspace')

// Directories that should never be exposed to the caller.
const BLOCKED = new Set(['.git', 'node_modules', '__pycache__', '.venv', '.env'])

/**
 * Resolve a caller-supplied relative path safely, ensuring it stays inside
 * WORKSPACE_DIR (prevents path-traversal attacks).
 */
function resolveSecure(relative: string): string | null {
  const base = WORKSPACE_DIR
  const resolved = path.resolve(base, relative)
  // Must start with base + sep, or equal base exactly
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null
  return resolved
}

/**
 * GET /api/workspace/files?path=<relative>
 *
 * - No path / path=.  → list root of workspace
 * - path=src/foo.ts   → return file content (≤512 KB)
 * - path=src/         → list directory entries
 *
 * Response (directory):
 *   { path, entries: [{name, type, size?, mtime}] }
 *
 * Response (file):
 *   { path, content, size, mtime }
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  if (!fs.existsSync(WORKSPACE_DIR)) {
    return NextResponse.json(
      {
        error: 'Workspace not mounted',
        hint: 'openclaw-workspace-ro-pvc is not mounted or the workspace does not exist yet',
        expected: WORKSPACE_DIR,
      },
      { status: 503 }
    )
  }

  const relativePath = request.nextUrl.searchParams.get('path') ?? '.'
  const resolved = resolveSecure(relativePath)
  if (!resolved) {
    return NextResponse.json({ error: 'Invalid path — traversal outside workspace is not allowed' }, { status: 400 })
  }

  if (!fs.existsSync(resolved)) {
    return NextResponse.json({ error: 'Not found', path: relativePath }, { status: 404 })
  }

  const stat = fs.statSync(resolved)

  if (stat.isDirectory()) {
    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      .filter(e => !BLOCKED.has(e.name))
      .map(e => {
        const fullPath = path.join(resolved, e.name)
        const s = fs.statSync(fullPath)
        return {
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          size: e.isFile() ? s.size : undefined,
          mtime: s.mtime.toISOString(),
        }
      })
      .sort((a, b) => {
        // directories first, then files, alphabetical within each group
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    return NextResponse.json({ path: relativePath, entries })
  }

  // File — cap at 512 KB to prevent accidental large binary reads
  const MAX_BYTES = 512 * 1024
  if (stat.size > MAX_BYTES) {
    return NextResponse.json(
      { error: 'File too large to serve inline', size: stat.size, limit: MAX_BYTES, path: relativePath },
      { status: 413 }
    )
  }

  const content = fs.readFileSync(resolved, 'utf-8')
  return NextResponse.json({
    path: relativePath,
    content,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  })
}
