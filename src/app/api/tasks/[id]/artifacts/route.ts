import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'

/**
 * GET /api/tasks/[taskId]/artifacts
 * Obtiene todos los archivos/artifacts creados por una tarea específica
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const resolvedParams = await params
    const taskId = parseInt(resolvedParams.id, 10)

    if (isNaN(taskId)) {
      return NextResponse.json(
        { error: 'Invalid task ID' },
        { status: 400 }
      )
    }

    const artifacts = db.prepare(`
      SELECT id, task_id, file_path, file_type, file_size, created_at, metadata
      FROM task_artifacts
      WHERE task_id = ?
      ORDER BY created_at DESC
    `).all(taskId)

    return NextResponse.json({ artifacts })
  } catch (error: any) {
    console.error('[artifacts] GET error:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: error.statusCode || 500 }
    )
  }
}

/**
 * POST /api/tasks/[taskId]/artifacts
 * Registra un nuevo artifact creado por una tarea
 * Body: { file_path: string, file_type?: string, file_size?: number, metadata?: object }
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const resolvedParams = await params
    const taskId = parseInt(resolvedParams.id, 10)

    if (isNaN(taskId)) {
      return NextResponse.json(
        { error: 'Invalid task ID' },
        { status: 400 }
      )
    }

    const body = await request.json()
    const { file_path, file_type, file_size, metadata } = body

    if (!file_path) {
      return NextResponse.json(
        { error: 'file_path is required' },
        { status: 400 }
      )
    }

    // Verificar que la tarea existe
    const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId)
    if (!task) {
      return NextResponse.json(
        { error: 'Task not found' },
        { status: 404 }
      )
    }

    // Insertar el artifact
    const result = db.prepare(`
      INSERT INTO task_artifacts (task_id, file_path, file_type, file_size, metadata)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      taskId,
      file_path,
      file_type || null,
      file_size || null,
      metadata ? JSON.stringify(metadata) : null
    )

    return NextResponse.json({
      id: result.lastInsertRowid,
      task_id: taskId,
      file_path,
      file_type,
      file_size,
      metadata
    }, { status: 201 })
  } catch (error: any) {
    console.error('[artifacts] POST error:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: error.statusCode || 500 }
    )
  }
}
