import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialVault } from './credential-vault.js'
import { OpcError } from '../errors.js'

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'opcos-vault-'))
}

test('vault: 加解密往返，密文不含明文且格式为 iv:tag:ciphertext', () => {
  const vault = new CredentialVault(CredentialVault.randomMasterKey())
  const secret = 'sk-live-9f8e7d6c5b4a3210'
  const payload = vault.encrypt(secret)

  const parts = payload.split(':')
  assert.equal(parts.length, 3)
  Buffer.from(parts[0], 'base64') // 三段均为合法 base64
  Buffer.from(parts[1], 'base64')
  Buffer.from(parts[2], 'base64')
  assert.ok(!payload.includes(secret))
  assert.equal(vault.decrypt(payload), secret)
})

test('vault: 同一明文两次加密产生不同密文（随机 IV）', () => {
  const vault = new CredentialVault(CredentialVault.randomMasterKey())
  assert.notEqual(vault.encrypt('same-secret'), vault.encrypt('same-secret'))
})

test('vault: 篡改密文/标签/IV 均拒绝（AR-S01 认证加密）', () => {
  const vault = new CredentialVault(CredentialVault.randomMasterKey())
  const payload = vault.encrypt('sk-tenant-a')

  const [iv, tag, ct] = payload.split(':')
  const flip = (b64: string): string => {
    const buf = Buffer.from(b64, 'base64')
    buf[0] ^= 0xff
    return buf.toString('base64')
  }
  const cases: Array<[string, string]> = [
    ['篡改密文', `${iv}:${tag}:${flip(ct)}`],
    ['篡改认证标签', `${iv}:${flip(tag)}:${ct}`],
    ['篡改IV', `${flip(iv)}:${tag}:${ct}`],
  ]
  for (const [name, candidate] of cases) {
    assert.throws(
      () => vault.decrypt(candidate),
      (err: unknown) => err instanceof OpcError && err.code === 'CREDENTIAL_DECRYPT_FAILED',
      `${name}必须被拒绝`,
    )
  }
})

test('vault: 错误 masterKey 拒绝解密', () => {
  const encrypter = new CredentialVault(CredentialVault.randomMasterKey())
  const payload = encrypter.encrypt('sk-tenant-b')
  const decrypter = new CredentialVault(CredentialVault.randomMasterKey())
  assert.throws(
    () => decrypter.decrypt(payload),
    (err: unknown) => err instanceof OpcError && err.code === 'CREDENTIAL_DECRYPT_FAILED',
  )
})

test('vault: 损坏 payload（坏 base64 / 缺段 / 空串）统一拒绝', () => {
  const vault = new CredentialVault(CredentialVault.randomMasterKey())
  for (const bad of ['', 'not-a-payload', 'a:b', 'a:b:c:d']) {
    assert.throws(
      () => vault.decrypt(bad),
      (err: unknown) => err instanceof OpcError && err.code === 'CREDENTIAL_DECRYPT_FAILED',
    )
  }
})

test('vault: 非法 masterKey 长度抛 RangeError', () => {
  assert.throws(() => new CredentialVault(Buffer.alloc(16)), RangeError)
  assert.throws(() => new CredentialVault(Buffer.alloc(64)), RangeError)
})

test('vault: 凭据落盘文件权限 0o600 且可回读（DE-02）', () => {
  const tmp = makeTmp()
  try {
    const vault = new CredentialVault(CredentialVault.randomMasterKey())
    const file = join(tmp, 'tenant-a.key')
    vault.writeCredential(file, 'sk-live-tenant-a')

    const mode = statSync(file).mode & 0o777
    assert.equal(mode, 0o600)
    assert.equal(vault.readCredential(file), 'sk-live-tenant-a')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('vault: 宽松 umask 下重复写入仍收敛到 0o600', () => {
  const tmp = makeTmp()
  try {
    const vault = new CredentialVault(CredentialVault.randomMasterKey())
    const file = join(tmp, 'tenant-b.key')
    const first = vault.writeCredential(file, 'sk-1')
    vault.writeCredential(file, 'sk-2-longer-secret')
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(vault.decrypt(first), 'sk-1')
    assert.equal(vault.readCredential(file), 'sk-2-longer-secret')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
