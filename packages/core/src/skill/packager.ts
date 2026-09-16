import { generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { OpcError } from '../errors.js'
import type { SkillDefinition } from './distiller.js'

/** DSH 版本兼容基线（PRD 7.4：v0.1.0-rc.7+） */
const DSH_COMPAT = '>=0.1.0-rc.7'

export interface PackageManifest {
  skillId: string
  name: string
  version: string
  authorId: string
  createdAt: number
  compat: { dsh: string }
}

/**
 * .skillpkg 创意归属元数据（prd2.md 7.5，从 .dshpkg 演进）：
 * stage=生命周期阶段、category=技能类别、compatibleIdeas=适用创意类型、
 * ideaId=产出该 Skill 的创意（作者惯例写 `idea-<ideaId>`）。
 * 元数据进入签名载荷，防篡改；缺省时为纯 .dshpkg 形态（向后兼容）。
 */
export interface SkillPkgMeta {
  stage?: 'description' | 'product' | 'operation' | 'asset'
  category?: string
  compatibleIdeas?: string[]
  ideaId?: string
}

/** .dshpkg/.skillpkg 信封：manifest + 蒸馏产物（+ 创意元数据）+ Ed25519 签名（SF-04 / AR-S05） */
export interface SkillPackage {
  manifest: PackageManifest
  skillDefinition: SkillDefinition
  /** base64(Ed25519 signature over canonicalJson({manifest, skillDefinition, skillpkg?})) */
  signature: string
  /** .skillpkg 扩展元数据（可选；prd2.md 7.5） */
  skillpkg?: SkillPkgMeta
}

export interface Ed25519KeyPair {
  publicKeyPem: string
  privateKeyPem?: string
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** 待签名载荷：manifest + skillDefinition（+ .skillpkg 元数据）的规范 JSON（键排序） */
function signingPayload(pkg: Pick<SkillPackage, 'manifest' | 'skillDefinition' | 'skillpkg'>): string {
  return canonicalJson({ manifest: pkg.manifest, skillDefinition: pkg.skillDefinition, skillpkg: pkg.skillpkg })
}

export function createPackage(
  skill: SkillDefinition,
  authorId: string,
  keyPair?: Ed25519KeyPair,
  skillpkg?: SkillPkgMeta,
): { pkg: SkillPackage; keys: Ed25519KeyPair } {
  const keys: Ed25519KeyPair =
    keyPair ??
    (() => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      return {
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        // 私钥仅在测试/本地打包场景返回，生产应由调用方持有（PRD 7.2）
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }
    })()

  const manifest: PackageManifest = {
    skillId: skill.name,
    name: skill.name,
    version: skill.version,
    authorId,
    createdAt: Date.now(),
    compat: { dsh: DSH_COMPAT },
  }
  const pkg: SkillPackage = {
    manifest,
    skillDefinition: skill,
    ...(skillpkg ? { skillpkg } : {}),
    signature: sign(
      null,
      Buffer.from(signingPayload({ manifest, skillDefinition: skill, skillpkg })),
      createPrivateKey(keys.privateKeyPem!),
    ).toString('base64'),
  }
  return { pkg, keys }
}

/** Ed25519 验签：任何对 manifest/skillDefinition 的篡改都必须被拒绝（AR-S05） */
export function verifyPackage(pkg: SkillPackage, publicKeyPem: string): boolean {
  try {
    return verify(
      null,
      Buffer.from(signingPayload(pkg)),
      createPublicKey(publicKeyPem),
      Buffer.from(pkg.signature, 'base64'),
    )
  } catch {
    return false
  }
}

/**
 * 安装 .dshpkg 到 targetDir/<skillId>/（SF-04）。
 * 先验签，失败抛 OpcError('SIGNATURE_INVALID')（PRD 6.1.3：技能被恶意篡改）；
 * 写入失败时回滚，不留残余文件。
 */
export async function installPackage(pkg: SkillPackage, targetDir: string, publicKeyPem: string): Promise<string> {
  if (!verifyPackage(pkg, publicKeyPem)) {
    throw new OpcError('SIGNATURE_INVALID', `package ${pkg.manifest.skillId} failed signature verification`)
  }
  const installDir = join(targetDir, pkg.manifest.skillId)
  await mkdir(installDir, { recursive: true })
  try {
    await writeFile(join(installDir, 'manifest.json'), JSON.stringify(pkg.manifest, null, 2) + '\n', 'utf8')
    await writeFile(join(installDir, 'skill.json'), JSON.stringify(pkg.skillDefinition, null, 2) + '\n', 'utf8')
  } catch (err) {
    // 回滚：安装失败不留残余（PRD 6.1.3）
    await rm(installDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
  return installDir
}
