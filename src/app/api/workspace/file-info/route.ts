import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'

/**
 * GET /api/workspace/file-info?path=workspace/file.ext
 * Devuelve información sobre un archivo, incluyendo qué task lo creó (si existe)
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { searchParams } = new URL(request.url)
    const filePath = searchParams.get('path')

    if (!filePath) {
      return NextResponse.json(
        { error: 'path parameter is required' },
        { status: 400 }
      )
    }

    const db = getDatabase()

    // Buscar si este archivo está registrado como artifact de alguna tarea
    const artifact = db.prepare(`
      SELECT 
        ta.id,
        ta.task_id,
        ta.file_path,
        ta.file_type,
        ta.file_size,
        ta.created_at,
        ta.metadata,
        t.title as task_title,
        t.status as task_status
      FROM task_artifacts ta
      LEFT JOIN tasks t ON ta.task_id = t.id
      WHERE ta.file_path = ?
      ORDER BY ta.created_at DESC
      LIMIT 1
    `).get(filePath) as { task_id: number; task_title: string; task_status: string; created_at: number } | undefined

    if (!artifact) {
      return NextResponse.json({
        file_path: filePath,
        created_by_task: null
      })
    }

    return NextResponse.json({
      file_path: filePath,
      created_by_task: {
        task_id: artifact.task_id,
        task_title: artifact.task_title,
        task_status: artifact.task_status,
        created_at: artifact.created_at
      }
    })
  } catch (error: any) {
    console.error('[file-info] GET error:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: error.statusCode || 500 }
    )
  }
}
