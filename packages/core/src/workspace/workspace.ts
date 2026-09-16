import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, resolve, sep } from 'node:path'

import { PermissionError } from '../errors.js'

/**
 * 创意工作区隔离（prd2.md 3.3 工作区隔离 / IP-02）：
 * 每个创意的 Agent 读写根限定在 ideas/<id>/workspace/ 内，
 * 越界路径（../ 逃逸、绝对路径、其他创意目录）一律 PERMISSION_DENIED。
 * 这是对"Agent 不能访问其他创意的工作区"约束的文件系统级守卫：
 * 一切读写都经 resolveIn() 归一化后做前缀校验，不信任调用方传参。
 */
export class IdeaWorkspace {
  constructor(
    /** 工作区根：ideas/<idea-id>/workspace（不存在时首次写入自动创建，0700） */
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** 工作区根（诊断/展示用） */
  get path(): string {
    return this.root
  }

  /**
   * 相对路径 → 工作区内绝对路径：绝对路径（POSIX / 或 Windows 盘符）与
   * .. 逃逸一律拒绝；余下经 normalize + resolve 归一化后做前缀校验。
   */
  resolveIn(relative: string): string {
    if (typeof relative !== 'string' || relative.length === 0) {
      throw new PermissionError('workspace path must be a non-empty relative path')
    }
    if (relative.includes('\0')) {
      throw new PermissionError('workspace path must not contain NUL bytes')
    }
    if (/^([a-zA-Z]:)[\\/]/.test(relative) || relative.startsWith('/') || relative.startsWith('\\')) {
      throw new PermissionError(`absolute path is not allowed in workspace: ${relative}`)
    }
    const candidate = resolve(this.root, normalize(relative))
    const rootWithSep = this.root.endsWith(sep) ? this.root : this.root + sep
    if (candidate !== this.root && !candidate.startsWith(rootWithSep)) {
      throw new PermissionError(`path escapes idea workspace: ${relative}`)
    }
    return candidate
  }

  /** 写文件（父目录自动创建）；root 本身只允许以 '.' 列目录，不作为写目标 */
  writeFile(relative: string, content: string): { path: string; bytes: number; at: number } {
    const target = this.resolveIn(relative)
    if (target === this.root) {
      throw new PermissionError('cannot write workspace root itself; use a relative file path')
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    writeFileSync(target, content, { mode: 0o600 })
    return { path: target, bytes: Buffer.byteLength(content), at: this.now() }
  }

  /** 读文件；不存在返回 undefined（由调用方决定 404 语义） */
  readFile(relative: string): string | undefined {
    const target = this.resolveIn(relative)
    if (target === this.root) return undefined
    try {
      statSync(target)
    } catch {
      return undefined
    }
    return readFileSync(target, 'utf8')
  }

  /** 列工作区文件（相对路径，目录递归）；工作区不存在返回空 */
  list(): string[] {
    if (!exists(this.root)) return []
    const out: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const absolute = join(dir, name)
        if (statSync(absolute).isDirectory()) walk(absolute)
        else out.push(absolute === this.root ? name : absolute.slice(this.root.length + 1))
      }
    }
    walk(this.root)
    return out.sort()
  }

  /** 删除工作区文件（创意删稿等清理场景）；越界同样拒绝 */
  removeFile(relative: string): boolean {
    const target = this.resolveIn(relative)
    if (target === this.root) return false
    if (!exists(target)) return false
    rmSync(target)
    return true
  }
}

function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/** 从创意目录根派生工作区路径（ideas/<id>/workspace，prd2.md 3.3 约定） */
export function workspacePathFor(ideaHomeDir: string): string {
  return join(ideaHomeDir, 'workspace')
}
