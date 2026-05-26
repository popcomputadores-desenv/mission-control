'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { createClientLogger } from '@/lib/client-logger'

const log = createClientLogger('WorkspaceBrowser')

interface WorkspaceFile {
  path: string
  name: string
  type: 'file' | 'directory'
  size?: number
  modified?: number
  children?: WorkspaceFile[]
}

interface FileTaskInfo {
  file_path: string
  created_by_task: {
    task_id: number
    task_title: string
    task_status: string
    created_at: number
  } | null
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function fileIcon(name: string): string {
  if (name.endsWith('.py')) return '🐍'
  if (name.endsWith('.js') || name.endsWith('.ts')) return '📜'
  if (name.endsWith('.sh')) return '⚙️'
  if (name.endsWith('.json') || name.endsWith('.yaml')) return '⚙️'
  if (name.endsWith('.md')) return '📄'
  if (name.endsWith('.txt') || name.endsWith('.log')) return '📝'
  return '📄'
}

function isCodeFile(name: string): boolean {
  return name.endsWith('.py') || name.endsWith('.js') || name.endsWith('.ts') || 
         name.endsWith('.sh') || name.endsWith('.go') || name.endsWith('.rs')
}

export function WorkspaceBrowserPanel() {
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [fileTaskInfo, setFileTaskInfo] = useState<FileTaskInfo | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const loadFileTree = useCallback(async (path: string = '') => {
    setIsLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (path) params.set('path', path)
      
      const response = await fetch(`/api/workspace/files?${params.toString()}`)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      
      const data = await response.json()
      
      if (data.error) {
        setError(data.error)
        return
      }
      
      // Transform API entries to add path field and normalize type
      const transformedEntries = (data.entries || []).map((entry: any) => ({
        ...entry,
        path: path ? `${path}/${entry.name}` : entry.name,
        type: entry.type === 'dir' ? 'directory' : 'file',
      }))
      
      if (path === '') {
        // Root load
        setFiles(transformedEntries)
      } else {
        // Folder expansion - merge into existing tree
        setFiles(prev => mergeChildren(prev, path, transformedEntries))
      }
    } catch (error) {
      log.error('Failed to load workspace files:', error)
      setError(error instanceof Error ? error.message : 'Failed to load files')
    } finally {
      setIsLoading(false)
    }
  }, [])

  const mergeChildren = (files: WorkspaceFile[], targetPath: string, children: WorkspaceFile[]): WorkspaceFile[] => {
    return files.map((file) => {
      if (file.path === targetPath && file.type === 'directory') {
        return { ...file, children }
      }
      if (file.children) {
        return { ...file, children: mergeChildren(file.children, targetPath, children) }
      }
      return file
    })
  }

  useEffect(() => {
    loadFileTree()
  }, [loadFileTree])

  const loadFileContent = async (filePath: string) => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/workspace/files?path=${encodeURIComponent(filePath)}`)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      
      const data = await response.json()
      
      if (data.error) {
        setError(data.error)
        return
      }
      
      // API returns { content, ... } for files, { entries: [...] } for directories
      if (data.content !== undefined) {
        setSelectedFile(filePath)
        setFileContent(data.content)
        // Cargar información de la tarea que creó este archivo
        loadFileTaskInfo(filePath)
      } else if (data.entries) {
        // It's a directory, not a file - should not happen if called correctly
        log.warn('Tried to load directory as file:', filePath)
      }
    } catch (error) {
      log.error('Failed to load file content:', error)
      setError(error instanceof Error ? error.message : 'Failed to load file')
    } finally {
      setIsLoading(false)
    }
  }

  const loadFileTaskInfo = async (filePath: string) => {
    try {
      const response = await fetch(`/api/workspace/file-info?path=${encodeURIComponent(filePath)}`)
      if (!response.ok) {
        log.warn('Failed to load file task info:', response.status)
        return
      }
      
      const data = await response.json()
      setFileTaskInfo(data)
    } catch (error) {
      log.error('Failed to load file task info:', error)
      // No es crítico, solo no mostramos la información
    }
  }

  const toggleFolder = async (folderPath: string) => {
    const isExpanded = expandedFolders.has(folderPath)
    
    if (isExpanded) {
      setExpandedFolders(prev => {
        const next = new Set(prev)
        next.delete(folderPath)
        return next
      })
    } else {
      setExpandedFolders(prev => new Set(prev).add(folderPath))
      
      // Check if we need to load children
      const folder = findFile(files, folderPath)
      if (folder && folder.type === 'directory' && !folder.children) {
        await loadFileTree(folderPath)
      }
    }
  }

  const findFile = (files: WorkspaceFile[], path: string): WorkspaceFile | null => {
    for (const file of files) {
      if (file.path === path) return file
      if (file.children) {
        const found = findFile(file.children, path)
        if (found) return found
      }
    }
    return null
  }

  const renderFileTree = (files: WorkspaceFile[], level: number = 0) => {
    return files.map((file) => {
      const isExpanded = expandedFolders.has(file.path)
      const isSelected = selectedFile === file.path
      const isCode = isCodeFile(file.name)
      
      return (
        <div key={file.path} style={{ marginLeft: `${level * 20}px` }}>
          <div
            className={`flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-gray-800 ${
              isSelected ? 'bg-blue-900' : ''
            } ${isCode ? 'font-semibold text-green-400' : ''}`}
            onClick={() => {
              if (file.type === 'directory') {
                toggleFolder(file.path)
              } else {
                loadFileContent(file.path)
              }
            }}
          >
            {file.type === 'directory' && (
              <span className="text-gray-500">{isExpanded ? '▼' : '▶'}</span>
            )}
            <span className="text-xl">{fileIcon(file.name)}</span>
            <span className="flex-1">{file.name}</span>
            {file.size !== undefined && (
              <span className="text-xs text-gray-500">{formatFileSize(file.size)}</span>
            )}
          </div>
          
          {file.type === 'directory' && isExpanded && file.children && (
            <div>
              {renderFileTree(file.children, level + 1)}
            </div>
          )}
        </div>
      )
    })
  }

  const countCodeFiles = (files: WorkspaceFile[]): number => {
    return files.reduce((acc, file) => {
      if (file.type === 'file' && isCodeFile(file.name)) {
        return acc + 1
      }
      if (file.children) {
        return acc + countCodeFiles(file.children)
      }
      return acc
    }, 0)
  }

  const codeCount = countCodeFiles(files)

  return (
    <div className="flex h-full bg-gray-950 text-gray-100">
      {/* Sidebar - File Tree */}
      <div className="w-1/3 border-r border-gray-800 overflow-y-auto p-4">
        <div className="mb-4">
          <h2 className="text-xl font-bold mb-2">📁 OpenClaw Workspace</h2>
          <div className="text-sm text-gray-400">
            {codeCount > 0 && <div>🐍 {codeCount} archivos de código</div>}
            {error && <div className="text-red-400 mt-2">⚠️ {error}</div>}
          </div>
        </div>
        
        {isLoading && files.length === 0 ? (
          <Loader variant="inline" />
        ) : (
          <div className="space-y-1">
            {renderFileTree(files)}
          </div>
        )}
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto p-6">
        {selectedFile ? (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">{selectedFile}</h3>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setSelectedFile(null)
                  setFileContent(null)
                }}
              >
                ✕ Cerrar
              </Button>
            </div>
            
            {isLoading ? (
              <Loader />
            ) : fileContent !== null ? (
              <div>
                <pre className="bg-gray-900 p-4 rounded-lg overflow-x-auto text-sm">
                  <code>{fileContent}</code>
                </pre>
                
                {/* Información de la tarea que creó este archivo */}
                {fileTaskInfo?.created_by_task ? (
                  <div className="mt-4 p-3 bg-blue-900/20 border border-blue-500/30 rounded-lg text-sm">
                    <div className="flex items-center gap-2 text-blue-300">
                      <span className="text-lg">🔗</span>
                      <span>
                        Creado por{' '}
                        <a
                          href={`/tasks?taskId=${fileTaskInfo.created_by_task.task_id}`}
                          className="font-semibold text-blue-400 hover:text-blue-300 underline"
                        >
                          Task #{fileTaskInfo.created_by_task.task_id}: {fileTaskInfo.created_by_task.task_title}
                        </a>
                      </span>
                    </div>
                    <div className="text-xs text-gray-400 mt-1">
                      Estado: {fileTaskInfo.created_by_task.task_status} · {' '}
                      {new Date(fileTaskInfo.created_by_task.created_at * 1000).toLocaleString()}
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 p-3 bg-gray-900 rounded-lg text-sm text-gray-400">
                    💡 Este archivo no está vinculado a ninguna tarea
                  </div>
                )}
              </div>
            ) : (
              <div className="text-gray-500">No se pudo cargar el contenido</div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            <div className="text-center">
              <div className="text-6xl mb-4">📂</div>
              <div>Selecciona un archivo del árbol para ver su contenido</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
