import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import fs from 'fs'
import path from 'path'

const OPENCLAW_BASE = process.env.OPENCLAW_WORKSPACE_DIR ?? '/mnt/openclaw-workspace'

// Strict allowlist for agent names — only alphanumeric, dash, underscore
const AGENT_RE = /^[a-zA-Z0-9_-]{1,64}$/
// Strict allowlist for session IDs (openclaw uses UUIDs or slug-style IDs)
const SESSION_RE = /^[a-zA-Z0-9_-]{1,128}$/

/**
 * GET /api/workspace/sessions?agent=main
 *   → returns sessions.json index for the agent
 *
 * GET /api/workspace/sessions?agent=main&session=<id>
 *   → returns full message list from the .jsonl file for that session
 *
 * Sessions live at:
 *   /mnt/openclaw-workspace/agents/<agent>/sessions/sessions.json   (index)
 *   /mnt/openclaw-workspace/agents/<agent>/sessions/<id>.jsonl      (messages)
 *
 * Response (index):
 *   { agent, sessions: [{id, title, createdAt, ...}] }
 *
 * Response (single session):
 *   { agent, sessionId, messages: [{role, content, ...}] }
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const agent = request.nextUrl.searchParams.get('agent') ?? 'main'
  if (!AGENT_RE.test(agent)) {
    return NextResponse.json({ error: 'Invalid agent name' }, { status: 400 })
  }

  const agentsBase = path.join(OPENCLAW_BASE, 'agents')
  if (!fs.existsSync(agentsBase)) {
    return NextResponse.json(
      {
        error: 'Agents directory not found',
        hint: 'openclaw-workspace-ro-pvc may not be mounted or openclaw has not run yet',
        expected: agentsBase,
      },
      { status: 503 }
    )
  }

  const sessionsDir = path.join(agentsBase, agent, 'sessions')
  if (!fs.existsSync(sessionsDir)) {
    return NextResponse.json({ agent, sessions: [], hint: 'No sessions directory for this agent' })
  }

  const sessionId = request.nextUrl.searchParams.get('session')

  // ── Return a specific session's messages ──────────────────────────────────
  if (sessionId) {
    if (!SESSION_RE.test(sessionId)) {
      return NextResponse.json({ error: 'Invalid session id' }, { status: 400 })
    }

    const jsonlPath = path.join(sessionsDir, `${sessionId}.jsonl`)
    // Double-check the resolved path stays inside sessionsDir (paranoid)
    if (!jsonlPath.startsWith(sessionsDir + path.sep)) {
      return NextResponse.json({ error: 'Invalid session id' }, { status: 400 })
    }
    if (!fs.existsSync(jsonlPath)) {
      return NextResponse.json({ error: 'Session not found', sessionId }, { status: 404 })
    }

    const messages = fs.readFileSync(jsonlPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .flatMap(line => {
        try { return [JSON.parse(line)] } catch { return [] }
      })

    return NextResponse.json({ agent, sessionId, messages })
  }

  // ── Return the session index ───────────────────────────────────────────────
  const indexPath = path.join(sessionsDir, 'sessions.json')
  let sessions: unknown[] = []
  if (fs.existsSync(indexPath)) {
    try {
      sessions = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
    } catch {
      sessions = []
    }
  }

  // Also enumerate .jsonl files present on disk as a fallback if index is empty
  const jsonlFiles = fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const s = fs.statSync(path.join(sessionsDir, f))
      return { id: f.replace(/\.jsonl$/, ''), size: s.size, mtime: s.mtime.toISOString() }
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime))

  return NextResponse.json({ agent, sessions, jsonlFiles })
}
