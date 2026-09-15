import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { OpcError } from '../errors.js'

/** AES-256-GCM 推荐 IV 长度（NIST SP 800-38D） */
const IV_BYTES = 12
/** GCM 认证标签长度 */
const TAG_BYTES = 16

/**
 * 租户 API Key 加密保险库（DE-02 / AR-S01）：
 * 每条凭据以 iv:tag:ciphertext（均 base64）落盘，认证失败即拒绝解密。
 * 落盘文件强制 0600，masterKey 永不写盘。
 */
export class CredentialVault {
  /** 生成 32 字节随机主密钥（aes-256-gcm 密钥长度） */
  static randomMasterKey(): Buffer {
    return randomBytes(32)
  }

  constructor(private readonly masterKey: Buffer) {
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
      throw new RangeError('masterKey must be a 32-byte Buffer for aes-256-gcm')
    }
  }

  /** 加密明文，返回 "iv:tag:ciphertext"（三段均 base64） */
  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv)
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':')
  }

  /** 解密 "iv:tag:ciphertext"；篡改 / 错误 masterKey / 格式损坏统一抛 CREDENTIAL_DECRYPT_FAILED */
  decrypt(payload: string): string {
    let parts: string[]
    try {
      parts = payload.split(':')
      if (parts.length !== 3) throw new Error('malformed payload')
      const iv = Buffer.from(parts[0], 'base64')
      const tag = Buffer.from(parts[1], 'base64')
      const ciphertext = Buffer.from(parts[2], 'base64')
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('malformed iv/tag')
      const decipher = createDecipheriv('aes-256-gcm', this.masterKey, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    } catch (err) {
      throw new OpcError(
        'CREDENTIAL_DECRYPT_FAILED',
        `credential payload failed authentication or is malformed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * 加密并落盘凭据（AR-S01 / DE-02）：writeFileSync 后立即 chmodSync 0600，
   * 确保即便 umask 宽松凭据文件也不可被同机其他用户读取。返回加密 payload。
   */
  writeCredential(filePath: string, plain: string): string {
    const payload = this.encrypt(plain)
    writeFileSync(filePath, payload, { mode: 0o600 })
    chmodSync(filePath, 0o600)
    return payload
  }

  /** 读取并解密 writeCredential 落盘的凭据文件 */
  readCredential(filePath: string): string {
    return this.decrypt(readFileSync(filePath, 'utf8'))
  }
}
