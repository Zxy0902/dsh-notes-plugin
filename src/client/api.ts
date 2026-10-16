/**
 * 笔记插件 Host 路由的浏览器端客户端。
 *
 * 路由路径刻意写成「文档相对」（不带前导斜杠）：DSH 用 `<base href="./">` 提供
 * GUI，子路径部署（如 /dsh/dsh/）下根绝对路径 /api/... 会逃出前缀而 404，
 * 官方客户端同样用 `api/session.list` 这种写法。
 *
 * 宿主侧有信任围栏（仅 loopback），这里不做额外鉴权。
 */

/** 路由路径（与 Host 的 ROUTES 字面量一一对应）。 */
export const API = {
  list: 'api/dsh-notes/list',
  read: 'api/dsh-notes/read',
  write: 'api/dsh-notes/write',
  create: 'api/dsh-notes/create',
  remove: 'api/dsh-notes/remove',
  move: 'api/dsh-notes/move',
  health: 'api/dsh-notes/health',
} as const;

/** 宿主能力探测结果。 */
export interface HostHealth {
  ok: boolean;
  plugin: string;
  home: string;
  /** 本平台是否支持删除到系统回收站；false 时客户端不显示删除入口。 */
  canDelete: boolean;
}

/** 目录项。 */
export interface DirEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file' | 'other';
  editable: boolean;
  size?: number;
  mtimeMs?: number;
}

/** 目录列举结果。 */
export interface DirListing {
  path: string;
  root: string;
  entries: DirEntry[];
}

/** 文件读取结果。 */
export interface FileContent {
  path: string;
  content: string;
  size: number;
  mtimeMs: number;
}

/** 带宿主错误信息的 API 异常。 */
export class NotesApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'NotesApiError';
  }
}

/** 笔记插件 API 客户端。 */
export class NotesApi {
  /** 列出目录的直接子项。 */
  list(root: string, path: string): Promise<DirListing> {
    return this.request(`${API.list}?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
  }

  /** 读取一个文件。 */
  read(root: string, path: string): Promise<FileContent> {
    return this.request(`${API.read}?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
  }

  /** 覆盖保存一个文件。 */
  write(root: string, path: string, content: string): Promise<{ ok: true; mtimeMs: number }> {
    return this.request(API.write, { method: 'POST', body: { root, path, content } });
  }

  /** 在根目录下新建一个文件。 */
  create(root: string, name: string, content: string): Promise<{ ok: true; path: string }> {
    return this.request(API.create, { method: 'POST', body: { root, name, content } });
  }

  /**
   * 删除一个文件。
   *
   * 宿主优先移入系统回收站（可从系统回收站还原）；
   * 跨分区或权限失败时回退到根目录下的 `dsh-notes-trash`，
   * 所以 `fallback` 为 true 时提示语要告诉用户去哪找。
   *
   * 仅在 `health().canDelete` 为 true 的平台可用；Windows 上调它会得到 403。
   */
  remove(root: string, path: string): Promise<{ ok: true; moved: string; fallback: boolean }> {
    return this.request(API.remove, { method: 'POST', body: { root, path } });
  }

  /** 把文件或目录移动到另一个目录里（拖拽）。 */
  move(root: string, path: string, to: string): Promise<{ ok: true; from: string; to: string }> {
    return this.request(API.move, { method: 'POST', body: { root, path, to } });
  }

  /** 读取宿主能力（目前用于判断本平台是否支持删除）。 */
  health(): Promise<HostHealth> {
    return this.request(API.health);
  }

  /** 发一次请求并把非 2xx 转成 NotesApiError。 */
  private async request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set('content-type', 'application/json');

    const response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    // 宿主错误体是 { error: string }；解析失败时退回状态码文案。
    if (!response.ok) {
      let message = `请求失败（HTTP ${response.status}）`;
      try {
        const parsed: unknown = await response.json();
        if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
          const raw = (parsed as { error: unknown }).error;
          if (typeof raw === 'string') message = raw;
        }
      } catch {
        // 保留默认文案。
      }
      throw new NotesApiError(message, response.status);
    }

    return (await response.json()) as T;
  }
}
