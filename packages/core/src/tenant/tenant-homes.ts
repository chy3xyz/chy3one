import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { OpcError } from '../errors.js'

/**
 * 租户 ID 白名单（AR-S07 / DE-01）：小写字母数字开头，允许连字符，总长 1..63。
 * 字符集不含 '.'、'/'、'\'，从根源上杜绝 '../etc'、'..' 等路径穿越与大写别名绕过。
 */
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

export function isValidTenantId(tenantId: string): boolean {
  return TENANT_ID_PATTERN.test(tenantId)
}

/**
 * 创建租户私有 $DSH_HOME（AR-S07）：rootDir/<tenantId>，权限强制 0700——
 * 公网多租户模式下每租户独立目录，防同机其他系统账号读取（PRD 6.4.2）。
 * tenantId 非法（含路径穿越片段 / 大写 / 空 / 超长）抛 INVALID_TENANT_ID。
 */
export function createTenantHome(rootDir: string, tenantId: string): string {
  if (!isValidTenantId(tenantId)) {
    throw new OpcError(
      'INVALID_TENANT_ID',
      `tenantId must match ${TENANT_ID_PATTERN.source} (got: ${JSON.stringify(tenantId)})`,
    )
  }
  const homeDir = join(rootDir, tenantId)
  mkdirSync(homeDir, { recursive: true })
  // chmod 在 mkdir 之后无条件执行：已存在且权限宽松的目录也会收敛回 0700
  chmodSync(homeDir, 0o700)
  return homeDir
}
