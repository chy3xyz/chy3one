/** 领域错误基类：所有 OPC-OS 业务异常携带稳定 code，供插件层映射为用户提示 */
export class OpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'OpcError'
  }
}

export class PermissionError extends OpcError {
  constructor(message: string) {
    super('PERMISSION_DENIED', message)
  }
}

export class ConflictError extends OpcError {
  constructor(message: string) {
    super('VERSION_CONFLICT', message)
  }
}
