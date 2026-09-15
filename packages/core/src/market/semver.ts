/**
 * 极简 semver 工具（SF-05 兼容性标记）：
 * 只支持 PRD 用到的 '>=x.y.z' / '>=x.y.z-rc.n' 下界范围，不实现 npm 完整 range 语法。
 *
 * 排序规则（semver.org §11 子集）：
 * - major / minor / patch 按数值比较；
 * - prerelease 逐段比较：数字段按数值（rc.7 < rc.10），数字段低于字母段，
 *   前缀相同时字段多者大（rc.7 < rc.7.build.1）；
 * - 无 prerelease 的正式版大于任意 prerelease（0.1.0-rc.7 < 0.1.0）。
 * 注意与 npm 语义不同：不做“prerelease 排除”，'>=0.1.0-rc.7' 可命中 0.1.0 正式版
 * （与 skill/packager.ts 的 DSH_COMPAT 兼容基线语义一致）。
 */

const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

function parse(version: string): ParsedVersion {
  const match = VERSION_RE.exec(version.trim())
  if (!match) throw new RangeError(`invalid semver version: ${JSON.stringify(version)}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function isNumericIdentifier(identifier: string): boolean {
  return /^(0|[1-9]\d*)$/.test(identifier)
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  // 正式版（无 prerelease）大于任何 prerelease
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x: string | undefined = a[i]
    const y: string | undefined = b[i]
    if (x === undefined) return -1 // 前缀相同，字段更少者更小
    if (y === undefined) return 1
    const xNum = isNumericIdentifier(x)
    const yNum = isNumericIdentifier(y)
    if (xNum && yNum) {
      const xn = Number(x)
      const yn = Number(y)
      if (xn !== yn) return xn < yn ? -1 : 1
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1 // 数字标识符低于字母数字标识符
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** 语义版本全序比较：a < b → -1、a == b → 0、a > b → 1 */
export function compareVersions(a: string, b: string): number {
  const va = parse(a)
  const vb = parse(b)
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1
  return comparePrerelease(va.prerelease, vb.prerelease)
}

/** '>=x.y.z(-rc.n)' 范围满足判断：version ≥ 下界即命中 */
export function satisfies(range: string, version: string): boolean {
  const match = /^>=\s*(\S+)$/.exec(range.trim())
  if (!match) {
    throw new RangeError(
      `unsupported semver range ${JSON.stringify(range)}: only '>=x.y.z' / '>=x.y.z-rc.n' is supported`,
    )
  }
  return compareVersions(version, match[1]) >= 0
}
