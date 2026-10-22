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
  latestVersion: 'api/dsh-notes/latest-version',
  skills: 'api/dsh-notes/skills',
  skillContent: 'api/dsh-notes/skill-content',
  readSkillFile: 'api/dsh-notes/read-skill-file',
} as const;

/** 宿主能力探测结果。 */
export interface HostHealth {
  ok: boolean;
  plugin: string;
  home: string;
  /** 本平台是否支持删除到系统回收站；false 时客户端不显示删除入口。 */
  canDelete: boolean;
  /**
   * 宿主平台（`process.platform`，如 `darwin`/`win32`/`linux`）。
   *
   * 用来挑跟随平台的文案：系统对「定位到文件」的叫法各不相同
   * （访达 / 资源管理器 / 文件管理器）。旧宿主没有该字段，按通用说法兜底。
   */
  platform?: string;
  /**
   * 本插件是否以「本地目录链接」方式安装（profile 里是 `link:` / `file:`）。
   *
   * 真相只有宿主知道：它看自己的代码路径里有没有 `node_modules/dsh-client-ui-notes`。
   * 插件页的更新控件用它给出「更新会替换本地链接」的提醒。
   */
  localInstall?: boolean;
  /**
   * 是否启用「技能」阅读（插件配置 `skillsReading`，默认开）。
   *
   * 旧宿主没有这个字段，按「开」处理 —— 那时技能功能本来就存在。
   */
  skillsReading?: boolean;
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

/** 一条技能的摘要（字段与宿主 `SkillSummary` 对齐）。 */
export interface SkillSummary {
  name: string;
  description: string;
  whenToUse?: string;
  /** SKILL.md 的绝对路径；插件内置的技能可能没有文件。 */
  path?: string;
  /** 技能目录（内置技能靠它找图标）。 */
  resourceDir?: string;
  /**
   * 内置技能正文的不透明 token（宿主发，用来换正文）。
   *
   * 宿主只对「没有文件」的技能发它；有文件的技能直接读文件即可。
   */
  token?: string;
  /** 是否同时暴露给模型。 */
  modelInvocable: boolean;
  /** 来源分组：`bundled` 是系统/插件自带，其余是用户自己的。 */
  source?: 'bundled' | 'project' | 'user' | 'custom';
}

/** 技能盘点结果。 */
export interface SkillListing {
  /** 宿主是否挂载了官方 skill 注册表；false 时界面给出可读提示。 */
  available: boolean;
  /** 询问注册表时用的工作目录（调试与提示用）。 */
  cwd: string;
  /** 发现是否完整；false 表示有提供方出错，列表可能不全。 */
  complete: boolean;
  skills: SkillSummary[];
  /**
   * 图标映射：键是「技能目录 + NUL + 图标相对路径」，值是该图标的 data URL。
   *
   * 键里带技能目录，是因为不同来源的技能可能有同名图标文件；
   * 渲染时按「SKILL.md 所在目录 + 图标相对路径」查。
   */
  icons: Record<string, string>;
  /**
   * 不透明 token → 技能名（宿主用来核对）。
   *
   * 客户端把某个技能的 `token` 带上去换正文；这里保留原始映射便于调试。
   */
  inline: Record<string, string>;
  /** 本次技能来自哪些提供方（诊断用，界面上以小字显示）。 */
  providers?: string[];
  /** 询问注册表时用的工作目录（项目级技能靠它发现）。 */
  askedCwd?: string;
  /** 注册表里登记在册的提供方（不只是这次供出技能的）。诊断用。 */
  registeredProviders?: string[];
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
  /**
   * 读一个文件。
   *
   * @param root - 这个文件所属的根（**不是**当前浏览的根：切过文件夹之后两者可能不同）。
   * @param path - 文件绝对路径。
   * @param extraRoots - 其他已打开文件所属的根。宿主把它们当作额外允许范围，
   *   这样切根之后旧 tab 仍然能读。
   * @returns 文件内容。
   */
  read(root: string, path: string, extraRoots: readonly string[] = []): Promise<FileContent> {
    const extra = extraRoots
      .filter((item) => item !== '' && item !== root)
      .map((item) => `&roots=${encodeURIComponent(item)}`)
      .join('');
    return this.request(
      `${API.read}?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}${extra}`,
    );
  }

  /**
   * 覆盖保存一个文件。
   *
   * @param root - 这个文件所属的根。
   * @param path - 文件绝对路径。
   * @param content - 新内容。
   * @param extraRoots - 其他已打开文件所属的根（与 `read` 同一套规则）。
   * @returns 写入结果。
   */
  write(
    root: string,
    path: string,
    content: string,
    extraRoots: readonly string[] = [],
  ): Promise<{ ok: true; mtimeMs: number }> {
    const roots = extraRoots.filter((item) => item !== '' && item !== root);
    return this.request(API.write, {
      method: 'POST',
      body: roots.length === 0 ? { root, path, content } : { root, path, content, roots },
    });
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

  /**
   * 列出当前可见的技能。
   *
   * 只读：数据来自 DSH 官方 skill 注册表，本插件不做启用/禁用，也不改任何文件。
   * 宿主没有注册表时返回 `available: false`，而不是抛错 —— 精简环境下这是正常情况。
   */
  skills(): Promise<SkillListing> {
    return this.request(API.skills);
  }

  /**
   * 读一条「没有文件」的内置技能的正文。
   *
   * 必须带列表接口发的不透明 token：宿主据此认定「这条技能确实来自上一次列表」，
   * 不接受按名字随便取。
   *
   * @param token - 该技能的 `token`。
   * @returns 技能名与正文。
   */
  skillContent(token: string): Promise<{ ok: true; name: string; content: string }> {
    return this.request(`${API.skillContent}?token=${encodeURIComponent(token)}`);
  }

  /**
   * 读一个技能文件（`SKILL.md`）。
   *
   * 与 `read()` 的区别：**不需要根目录参数**，也不需要用户先选文件夹。
   * 宿主那边用「必须在技能根之内」的围栏替代用户根 —— 这样看技能就不会
   * 改动、也不会污染用户的文件夹历史。
   *
   * @param path - 技能文件绝对路径。
   * @returns 文件内容。
   */
  readSkillFile(path: string): Promise<FileContent> {
    return this.request(`${API.readSkillFile}?path=${encodeURIComponent(path)}`);
  }

  /** 读取宿主能力（目前用于判断本平台是否支持删除）。 */
  health(): Promise<HostHealth> {
    return this.request(API.health);
  }

  /**
   * 查本插件在 npm 上的最新版本（插件页「检查更新」用）。
   *
   * 由**本插件自己的宿主半边**去问 npm —— 不用插件管理服务的 `inspect`：
   * 那个接口是「安装前校验」，已安装的包会被它以 `already-installed` 拒绝。
   *
   * 404 会被翻译成可执行的提示：客户端半边是热更的、宿主半边要重启才会加载新路由，
   * 两者不同步时这里必然 404，直接说清楚比丢个状态码让用户猜有用。
   *
   * @param fresh - true 时绕过宿主端 5 分钟缓存（用户手动点「重新检查」）。
   * @returns 包名、最新版本号，以及该版本的 tarball 直链（宿主 0.1.7 起提供）。
   */
  async latestVersion(
    fresh = false,
  ): Promise<{ ok: true; name: string; version: string; tarball?: string }> {
    try {
      return await this.request(`${API.latestVersion}${fresh ? '?fresh=1' : ''}`);
    } catch (error) {
      if (error instanceof NotesApiError && error.status === 404) {
        throw new NotesApiError(
          '宿主半边还没提供查版本的接口（客户端已更新、宿主未重启），请完全退出并重开 DSH',
          404,
        );
      }
      throw error;
    }
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
