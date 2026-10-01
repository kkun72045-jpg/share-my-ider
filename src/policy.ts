export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_GARMENTS = 6;
export const SESSION_LIMIT_SECONDS = 180;

export function brokerOrigin(value: string): string {
  const url = new URL(value);
  const secureRemote = url.protocol === 'https:';
  const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if ((!secureRemote && !loopback) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('凭证服务须使用本机 HTTP 或个人 HTTPS 服务域名，不能包含路径或密钥。');
  }
  return url.origin;
}

export function validateImage(type: string, size: number): void {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new Error('请选择 PNG、JPEG 或 WebP 服装图片。');
  if (size <= 0 || size > MAX_IMAGE_BYTES) throw new Error('每张服装图片需小于 8 MB，且不能为空。');
}

export function garmentSource(value: string): URL {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('此图片地址不支持导入，请下载后手动选择。');
  return url;
}

// New operations invalidate old asynchronous results (camera grants and connections).
export class OperationGate {
  private revision = 0;
  begin(): number { return ++this.revision; }
  cancel(): void { ++this.revision; }
  current(id: number): boolean { return id === this.revision; }
}
