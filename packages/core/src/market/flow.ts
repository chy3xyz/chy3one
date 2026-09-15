import { OpcError } from '../errors.js'
import { installPackage, verifyPackage } from '../skill/packager.js'
import type { SkillPackage } from '../skill/packager.js'
import type { SqliteSkillIndex } from './sqlite-index.js'

/** .dshpkg 包仓库最小接口：市场后端的包存储（SF-04 产物、SF-05 分发） */
export interface PackageStore {
  get(id: string): SkillPackage | undefined
}

/**
 * 从市场安装 Skill（SF-05：浏览 / 搜索 / 购买 / 安装）：
 * 索引查条目 → 取包 → Ed25519 验签 → installPackage 落盘 → incDownloads 计数 → 记录安装时间。
 * - 索引或包缺失：抛 OpcError('SKILL_NOT_FOUND')；
 * - 验签失败：原样抛 packager 的 OpcError('SIGNATURE_INVALID')（AR-S05：技能被恶意篡改）；
 * - 返回安装路径 targetDir/<skillId>/。
 */
export async function installFromMarket(
  index: SqliteSkillIndex,
  pkgStore: PackageStore,
  publicKeyPem: string,
  skillId: string,
  targetDir: string,
  clock: () => number = Date.now,
): Promise<string> {
  const entry = index.get(skillId)
  if (!entry) throw new OpcError('SKILL_NOT_FOUND', `skill ${skillId} not in market index`)

  const pkg = pkgStore.get(skillId)
  if (!pkg) throw new OpcError('SKILL_NOT_FOUND', `package ${skillId} missing from package store`)

  if (!verifyPackage(pkg, publicKeyPem)) {
    // 与 packager.installPackage 抛出的错误同码同形
    throw new OpcError('SIGNATURE_INVALID', `package ${skillId} failed signature verification`)
  }

  const installPath = await installPackage(pkg, targetDir, publicKeyPem)
  index.incDownloads(skillId)
  index.setMetadata(skillId, 'last_installed_at', String(clock()))
  return installPath
}
