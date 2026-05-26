import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'

const execFileAsync = promisify(execFile)

const OPENCLAW_BASE = process.env.OPENCLAW_WORKSPACE_DIR ?? '/mnt/openclaw-workspace'
const WORKSPACE_DIR = path.join(OPENCLAW_BASE, 'workspace')

/**
 * GET /api/workspace/git-log?n=20&after=2026-01-01
 *
 * Returns the git commit history of the openclaw agent workspace, including
 * which files were created / modified / deleted in each commit — this shows
 * exactly what artifacts the agent has produced over time.
 *
 * Query params:
 *   n      — max commits to return (default 20, max 100)
 *   after  — ISO date string to filter commits newer than this date
 *   file   — if provided, show history for a specific file path only
 *
 * Response:
 *   {
 *     workspace: string,
 *     commits: [{
 *       hash: string,        // short SHA
 *       fullHash: string,
 *       author: string,
 *       email: string,
 *       date: string,        // ISO date
 *       subject: string,
 *       files: [{status: "A"|"M"|"D"|"R", path: string}]
 *     }]
 *   }
 *
 * Requires git to be available in the MC container (present in node:22-slim).
 * If git is not installed, returns 503 with a clear message.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  if (!fs.existsSync(WORKSPACE_DIR)) {
    return NextResponse.json(
      {
        error: 'Workspace not mounted',
        hint: 'openclaw-workspace-ro-pvc is not mounted or the workspace directory does not exist yet',
        expected: WORKSPACE_DIR,
      },
      { status: 503 }
    )
  }

  if (!fs.existsSync(path.join(WORKSPACE_DIR, '.git'))) {
    return NextResponse.json(
      {
        error: 'Not a git repository',
        path: WORKSPACE_DIR,
        hint: 'openclaw has not initialized the workspace as a git repository yet',
      },
      { status: 404 }
    )
  }

  const sp = request.nextUrl.searchParams
  const n = Math.min(Math.max(1, parseInt(sp.get('n') ?? '20', 10)), 100)
  const after = sp.get('after') // e.g. "2026-01-01" or ISO datetime
  const filePath = sp.get('file') // filter to a specific file

  // Use a unit separator (\x1f) to safely split fields that might contain spaces
  const format = '%H\x1f%h\x1f%ae\x1f%an\x1f%aI\x1f%s'

  const args: string[] = [
    '-C', WORKSPACE_DIR,   // run git against the repo (safer than cwd)
    'log',
    `--max-count=${n}`,
    `--format=${format}`,
    '--name-status',       // show file status (A/M/D)
    '--diff-filter=ACDMR', // Added, Copied, Deleted, Modified, Renamed
  ]

  if (after) {
    // Validate: only allow safe date strings to prevent arg injection
    if (!/^[\d\-T:.Z+]+$/.test(after)) {
      return NextResponse.json({ error: 'Invalid after date format' }, { status: 400 })
    }
    args.push(`--after=${after}`)
  }

  if (filePath) {
    // Validate: must be a relative path without shell metacharacters
    if (/[;&|`$<>\\]/.test(filePath)) {
      return NextResponse.json({ error: 'Invalid file path' }, { status: 400 })
    }
    args.push('--', filePath)
  }

  try {
    const { stdout } = await execFileAsync('git', args, {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      // Do NOT use shell: true — we're passing args as array (no injection risk)
    })

    const commits = parseGitLog(stdout)
    return NextResponse.json({ workspace: WORKSPACE_DIR, commits })
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return NextResponse.json(
        {
          error: 'git binary not found in Mission Control container',
          hint: 'Add git to the MC Dockerfile: RUN apt-get install -y --no-install-recommends git',
        },
        { status: 503 }
      )
    }
    return NextResponse.json(
      { error: 'git log failed', detail: err.message },
      { status: 500 }
    )
  }
}

interface GitFile {
  status: string
  path: string
  oldPath?: string // for renames
}

interface GitCommit {
  fullHash: string
  hash: string
  email: string
  author: string
  date: string
  subject: string
  files: GitFile[]
}

/**
 * Parse the raw stdout from `git log --format=<fields> --name-status`.
 * The output interleaves commit header lines and file-status lines, separated
 * by blank lines between commits.
 */
function parseGitLog(raw: string): GitCommit[] {
  const commits: GitCommit[] = []
  // Each commit is a block of: header line + blank line + file lines + blank line
  const blocks = raw.trim().split(/\n(?=[\da-f]{40})/)

  for (const block of blocks) {
    if (!block.trim()) continue
    const lines = block.split('\n')
    const headerLine = lines[0]
    const parts = headerLine.split('\x1f')
    if (parts.length < 6) continue

    const [fullHash, hash, email, author, date, ...subjectParts] = parts
    const subject = subjectParts.join('\x1f')

    const files: GitFile[] = []
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue
      const cols = line.split('\t')
      const status = cols[0]?.trim()
      if (!status || cols.length < 2) continue
      if (status.startsWith('R')) {
        // Rename: R100\told-path\tnew-path
        files.push({ status: 'R', path: cols[2] ?? cols[1], oldPath: cols[1] })
      } else {
        files.push({ status, path: cols[1] })
      }
    }

    commits.push({ fullHash, hash, email, author, date, subject, files })
  }

  return commits
}
