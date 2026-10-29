/**
 * notes — Host 半边。
 *
 * 为笔记插件提供文件系统能力：列出目录、读取文件、写入文件、创建文件。
 * 客户端半边（./client）在主面板里渲染阅读器/备忘录用它。
 *
 * 设计要点：
 * - 只注册自己的 HTTP 路由，不改动 DSH 任何源码。
 * - 所有路由都过信任围栏（仅 loopback，另加浏览器同源标记），
 *   因为这些路由能真实读写磁盘文件，绝不能让未配对的局域网客户端碰到。
 * - 写入走「原子写」：先写同目录临时文件再 rename，避免中途失败留下半个文件。
 * - 路径限制在用户显式选中的根目录内，防止 ../ 越权。
 */
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import z from '@deepseek-ai/schemastery';
import { isVolatile } from '@deepseek-ai/cosmokit';

/** cordis 插件名（稳定标识）。 */
export const name = 'notes';

/** 路由挂载前需要就绪的服务。 */
export const inject = ['webServer'];

/**
 * 插件配置。
 *
 * **刻意没有 `enabled`**：DSH 插件页自带「启用 / 禁用」开关，它会直接停掉整个插件。
 * 再提供一个是同一件事的两个入口，用户会困惑「我关哪个才是真的关」。
 * 所以这里只放插件自己的行为选项。
 */
export interface Config {
  /** 单文件读取上限（字节），默认 8 MiB。 */
  maxReadBytes?: number;
  /** 单文件写入上限（字节），默认 8 MiB。 */
  maxWriteBytes?: number;
  /** 是否启用「技能」阅读（默认开）。关掉后入口完全不出现。 */
  skillsReading?: boolean;
  /**
   * 额外的技能根目录（在默认根之外追加）。
   *
   * 默认根已覆盖 DSH 的官方约定（项目 `.dsh/skills`、`~/.dsh/skills` 等）；
   * 这里只用于「技能放在别处」的情况。
   */
  skillRoots?: string[];
}

/**
 * 插件配置的 schema。
 *
 * **必须导出**：DSH 的设置框架按 `entry.fiber.runtime.Config.toJSON()` 生成表单
 * （见 `dsh-settings` 的 `schema(entry)`），没有它插件页就只有一个「启用」开关，
 * 本插件的这些选项不会出现在界面上。
 */
export const ConfigSchema = z.object({
  // **必须 `.volatile()`**，这是 DSH 插件页出现「配置」入口的唯一条件：
  // `dsh-settings` 的 `describe()` 用 `volatileForm(schema)` 过滤，一个 volatile
  // 字段都没有时直接 `return undefined`，该行就不进配置表单目录，插件管理页的
  // `configure.has(row)` 因此为假 —— 行标题是纯文本，没有可点的「配置」按钮。
  //
  // 副作用是「改这一项不会重启插件」：`loader/entry.js` 的
  // `equalExceptVolatile()` 把 volatile 字段当作相等，只走 `_commitVolatile()`
  // 把新值写进运行中的 fiber。所以这些值必须**每次使用时现读**，不能在 apply
  // 里折算成常量（见下面的 `readConfig()`）。
  skillsReading: z
    .boolean()
    .default(true)
    .volatile()
    .description('在文件夹下拉里提供「浏览技能」，可阅读技能说明与正文'),
  skillRoots: z
    .array(z.string())
    .default([])
    .volatile()
    .description('额外的技能目录（每行一个绝对路径）；留空只用 DSH 约定的默认位置'),
  maxReadBytes: z
    .number()
    .default(8 * 1024 * 1024)
    .volatile()
    .description('单个文件读取上限（字节）'),
  maxWriteBytes: z
    .number()
    .default(8 * 1024 * 1024)
    .volatile()
    .description('单个文件写入上限（字节）'),
});

// ---------------------------------------------------------------------------
// 信任围栏
// ---------------------------------------------------------------------------

/** IPv4 127/8 判定（四段十进制，首段为 127）。 */
function isIPv4Loopback(v4: string): boolean {
  const parts = v4.split('.');
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** socket 远端地址是否属于 loopback（127/8、::1、IPv4-mapped）。 */
function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const normalized = address.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7));
  return isIPv4Loopback(normalized);
}

/** 主机名是否指向 loopback 权威（localhost、[::1]、127/8）。 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  return isIPv4Loopback(hostname);
}

/**
 * 请求级信任围栏：socket 必须是 loopback，且 Host 头也必须是 loopback，
 * 另外校验浏览器同源标记。socket 地址是权威依据，永不信任 X-Forwarded-For。
 */
function isLoopbackRequest(request: {
  socket: { remoteAddress?: string };
  headers: Record<string, unknown>;
}): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false;

  const host = request.headers.host;
  if (typeof host !== 'string') return false;

  let hostUrl: URL;
  try {
    hostUrl = new URL('http://' + host);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;

  // 跨站请求一律拒绝（CSRF 防护）。
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;

  const origin = request.headers.origin;
  if (typeof origin !== 'string') return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 回收站与删除能力
// ---------------------------------------------------------------------------

/**
 * 本平台是否支持「删除到系统回收站」。
 *
 * macOS 有 `~/.Trash`、Linux 有 XDG 回收站，都能直接移入并由系统提供还原；
 * **Windows 没有可移植的用户态回收站路径** —— 真正的回收站只能通过
 * `SHFileOperation` / PowerShell 的 `Microsoft.VisualBasic.FileIO.FileSystem` 等
 * API 写入，而官方文档注明「非用户交互的应用程序不支持 recycle 参数」，
 * 我们跑在后台进程里，无法保证可靠。
 *
 * 既然做不到「可还原的删除」，就不提供删除：本插件的删除本意是清理文件，
 * 若只能挪进一个自建目录，既没清掉垃圾、又让用户以为还能从系统回收站找回，
 * 反而更容易误判。所以 Windows 上直接不显示删除入口。
 */
export const CAN_DELETE = process.platform !== 'win32';

/**
 * 本插件当前是不是「本地目录链接」安装（profile 里写的是 `link:` / `file:`）。
 *
 * 判据：宿主自己的代码路径里有没有 `node_modules/dsh-client-ui-notes` 这一段。
 * npm / pnpm 装进 profile 时，真实路径一定落在
 * `.../node_modules/dsh-client-ui-notes/lib/index.js`（pnpm 经 `.pnpm/...` 中转，
 * 解析后同样含这一段）；而 `link:` 安装会把目录指向开发者自己的工程，路径里没有它。
 *
 * 只用于界面提示：本地链接安装时，插件页的「更新」会提示「会替换掉本地链接」。
 * 判断不出来时按「不是本地」处理 —— 宁可多显示一个按钮，也不能让正常安装的用户
 * 看不到更新入口。插件若被改名/复刻，这里就会判定为「不是本地」，也只是少一条提示。
 */
const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const LOCAL_INSTALL = !/(^|[\\/])node_modules[\\/]dsh-client-ui-notes([\\/]|$)/.test(SELF_DIR);

/** 取异常的一句话描述（宿主内多处要用同一套写法）。 */
function messageOfError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 本插件自己的 npm 包名（从自身 package.json 读，别写死）。
 *
 * 「检查更新」要知道去 npm 上查哪个包。读自己的 package.json 而不是硬编码，
 * 这样插件被改名/复刻后依旧查的是它自己。
 *
 * @returns 包名；读不到时返回 null（调用处给出可读错误）。
 */
async function selfPackageName(): Promise<string | null> {
  try {
    const raw = await readFile(join(SELF_DIR, '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === 'string' && parsed.name !== '' ? parsed.name : null;
  } catch {
    return null;
  }
}

/** npm 上「最新版本」的查询结果。 */
interface LatestVersion {
  /** 包名。 */
  name: string;
  /** `latest` dist-tag 指向的版本。 */
  version: string;
  /**
   * 该版本的 tarball 直链（npm 元数据里的 `dist.tarball`）。
   *
   * 「一键更新」必须用它，不能用 `包名@版本`：宿主一旦装了 HMR，`installBundle`
   * 会在跑 pnpm 之前就以 `already-installed` 拒绝「spec 指明已安装包」的请求
   * （0.2.1-rc.2 起）。tarball 规格解析不出包名，那道检查不触发；pnpm 的
   * `minimumReleaseAge` 也只按 registry 版本判定，不作用于 URL 依赖。
   */
  tarball?: string;
}

/**
 * 最近一次查询结果与时间。
 *
 * 插件页每次打开都会自动查一次，加 5 分钟缓存避免反复打 npm；用户手动点
 * 「重新检查」时带 fresh 参数绕过缓存。
 */
let latestCache: { at: number; value: LatestVersion } | null = null;

/** 缓存有效期（毫秒）。 */
const LATEST_CACHE_MS = 5 * 60 * 1000;

/** 查询 npm 的超时（毫秒）。 */
const LATEST_TIMEOUT_MS = 8000;

/**
 * 查本插件在 npm 上的最新版本。
 *
 * 为什么不用插件管理服务的 `inspect`：那个接口是**安装前校验**，一旦这个包已经
 * 装进 profile 就会以 `already-installed` 拒绝（源码里是 `known.has(name)` 判重），
 * 拿它当「检查更新」用必然一进页面就失败。所以检查走这里直接问 npm 的
 * `latest` dist-tag；真正的升级仍交给官方 `installBundle`（它对已安装的包就是升级）。
 *
 * @param logger - 宿主 logger。
 * @param fresh - true 时绕过缓存。
 * @returns 包名与最新版本。
 * @throws HttpError 名称读不到（500）、网络失败（502）、返回体不可解析（502）。
 */
async function latestPublishedVersion(logger: Logger, fresh: boolean): Promise<LatestVersion> {
  const name = await selfPackageName();
  if (name === null) throw new HttpError(500, '无法读出本插件自己的包名');

  if (!fresh && latestCache !== null && Date.now() - latestCache.at < LATEST_CACHE_MS) {
    return latestCache.value;
  }

  let response: Response;
  try {
    response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(LATEST_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn(error);
    throw new HttpError(502, `无法访问 npm 查询最新版本：${messageOfError(error)}`);
  }

  if (!response.ok) {
    throw new HttpError(502, `npm 返回 ${String(response.status)}，查询最新版本失败`);
  }

  let version: unknown;
  let tarball: unknown;
  try {
    const body = (await response.json()) as { version?: unknown; dist?: { tarball?: unknown } };
    version = body.version;
    tarball = body.dist?.tarball;
  } catch {
    throw new HttpError(502, 'npm 返回的内容无法解析');
  }
  if (typeof version !== 'string' || version === '') {
    throw new HttpError(502, 'npm 没有给出该包的版本号');
  }

  const value: LatestVersion = {
    name,
    version,
    // 只接受 https 直链：客户端会把它交给 pnpm 当安装规格，来源必须可信。
    ...(typeof tarball === 'string' && tarball.startsWith('https://') ? { tarball } : {}),
  };
  latestCache = { at: Date.now(), value };
  return value;
}

/**
 * 系统回收站不可用时，在笔记根目录下使用的回退回收站目录名。
 *
 * 刻意不以点开头：文件树隐藏所有点开头的条目，带点的目录用户看不见，
 * 被删的文件就找不回来了。不带点则它在树里可见、可点开、可取回。
 *
 * 注意：这条回退路径只用于 macOS / Linux 上「系统回收站本身写不进去」的
 * 意外情形（如跨分区、权限不足），不是 Windows 的常规路径 —— Windows 上
 * `CAN_DELETE` 为 false，删除入口根本不出现。
 */
const TRASH_DIR_NAME = 'dsh-notes-trash';

// ---------------------------------------------------------------------------
// 技能（skill）目录
// ---------------------------------------------------------------------------

/**
 * 从 DSH 官方 skill 注册表里读出来的一条技能摘要。
 *
 * 字段与官方 `SkillRegistry.list()` 的结果对齐：那份结果已经做过「按 rank 裁决
 * 重名、按 invocation 过滤」的整理，界面拿到的就是真正可用的那批。
 */
export interface SkillSummary {
  /** kebab-case 名称（`/name` 里用的就是它）。 */
  name: string;
  /** 一句话路由描述（列表里的第二行）。 */
  description: string;
  /** 可选的额外使用指引。 */
  whenToUse?: string;
  /** SKILL.md 的绝对路径；插件内置的技能可能没有文件。 */
  path?: string;
  /**
   * 技能目录（`resourceBase` 为目录时才有），插件内置技能靠它找图标。
   *
   * 这类技能只给 `resourceBase: {kind:'directory', path}`，不给 `path` ——
   * 所以「有没有图标」不能只看 `path`。
   */
  resourceDir?: string;
  /** 是否同时暴露给模型。 */
  modelInvocable: boolean;
  /**
   * 来源分组：`bundled` 是随 DSH 或其插件自带的（Office 三件套等），
   * 其余是用户自己的（项目 / 用户目录 / 自定义目录）。
   *
   * 界面据此分成「系统内置」与「我的」两块。
   */
  source?: 'bundled' | 'project' | 'user' | 'custom';
}

/**
 * 官方 skill 注册表的**最小面**。
 *
 * 只声明本插件真正调用的方法，且全部可选：`ctx.skills` 由官方
 * `@deepseek-ai/dsh-skill` 提供，精简 profile 或未来版本可能没挂它 ——
 * 那种情况下「技能」入口只是看不到内容，绝不让插件加载失败。
 *
 * 刻意**不自己扫盘解析 SKILL.md**：注册表已经处理了全部脏活（项目根 /
 * `~/.dsh/skills` / `~/.agents/skills` 的优先级、YAML frontmatter、
 * 重名裁决、`.system` 跳过、热监听）。自己再实现一遍只会与官方结果不一致。
 */
interface SkillRegistryFacade {
  /** 列出某个工作目录可见的技能摘要（官方 `SkillRegistry.list`）。 */
  list?(options: { cwd?: string; scope?: string }): Promise<readonly unknown[]>;
  /** 带发现完整性标记的版本（官方 `SkillRegistry.snapshot`）。 */
  snapshot?(options: { cwd?: string; scope?: string }): Promise<{
    skills?: readonly unknown[];
    complete?: boolean;
  }>;
  /** 按名字加载完整技能（含正文），官方 `SkillRegistry.get`。 */
  get?(name: string, options: { cwd?: string; scope?: string }): Promise<
    { content?: unknown; name?: unknown } | undefined | null
  >;
  /**
   * 注册表的内部层级（诊断用，非公开 API）。
   *
   * 真实环境出现过「只列出内置技能」而本地复现不出来的情况。要知道注册表里
   * **实际登记了哪些提供方**，只能读 `layers` —— 官方没有暴露这个信息。
   * 读不到就返回空数组，绝不因为诊断把功能弄坏。
   */
  layers?: {
    global?: { providers?: { keys?(): Iterable<string> } | Map<string, unknown> };
    scoped?: { size?: number };
  };
}

/**
 * 配置写回通道的最小面（`ctx.configEditor`）。
 *
 * 只需要三个成员：找到本插件这一行、读它当前的原始配置、提交一次变更。
 * 形状取自 `@deepseek-ai/dsh-config-editor` 的 `ConfigEditor`：
 * `entries()` / `edit(entry, change)`；`configuration()` 用来判断这一行是否存在。
 */
interface ConfigEditorFacade {
  entries?: () => readonly unknown[];
  edit?: (entry: unknown, change: (current: unknown, inherited: unknown) => unknown) => Promise<void>;
  /**
   * 读 profile 里各条目的「继承层 / 覆盖层」原始值。
   *
   * 用它而不是 `fiber.config`：后者是**运行中**的值，volatile 字段要等
   * loader 的 `_commitVolatile()` 才跟上，存在几毫秒的窗口。而这里直接读的是
   * 已经落盘的补丁，写盘成功即成立 —— 读配置时以它为准更准。
   */
  configuration?: () => readonly {
    entry?: { options?: { id?: string } };
    override?: Record<string, unknown>;
  }[];
}

/** 会话登记表的最小面：取当前会话的工作目录，供注册表按项目根发现技能。 */
interface SessionRegistryFacade {
  list?(): readonly { header?: { cwd?: unknown } }[];
}

/**
 * 归一化一条技能摘要。
 *
 * 注册表给的是富对象：`{ name, path?, description, whenToUse?, invocation:
 * { modelInvocable, userInvocable }, source, provider, resourceBase? }`。
 * 这里只挑界面要用的字段并做类型收窄，免得把未定义的结构直接透给客户端。
 *
 * 注意 `modelInvocable` 在 `invocation` **里面**，不是顶层（官方 `skills/list`
 * 会把它拍平，但注册表的 `snapshot().skills` 不会）。两种形状都认。
 *
 * @param raw - 注册表返回的原始条目。
 * @returns 归一化后的摘要；name 不合法时返回 null。
 */
function normalizeSkill(raw: unknown): SkillSummary | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const name = item.name;
  if (typeof name !== 'string' || name === '') return null;

  // 顶层优先（官方 skills/list 的拍平形状），否则取嵌套的 invocation。
  const invocation =
    typeof item.invocation === 'object' && item.invocation !== null
      ? (item.invocation as Record<string, unknown>)
      : null;
  const flat = item.modelInvocable;
  const nested = invocation?.modelInvocable;
  const modelInvocable = typeof flat === 'boolean' ? flat : typeof nested === 'boolean' ? nested : true;

  const out: SkillSummary = {
    name,
    description: typeof item.description === 'string' ? item.description : '',
    modelInvocable,
  };
  if (typeof item.whenToUse === 'string' && item.whenToUse !== '') out.whenToUse = item.whenToUse;
  if (typeof item.path === 'string' && item.path !== '') out.path = item.path;

  // 插件内置技能没有 `path`，但常有 `resourceBase: { kind: 'directory', path }`。
  // 记下来，图标与「技能家目录」都以它为准。
  const base = item.resourceBase;
  if (typeof base === 'object' && base !== null) {
    const record = base as Record<string, unknown>;
    if (record.kind === 'directory' && typeof record.path === 'string' && record.path !== '') {
      out.resourceDir = record.path;
    }
  }
  return out;
}

/** 图标文件名 → MIME。只认这几种，其余一律当不是图标。 */
const ICON_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** 单个图标的读取上限：再大就不当图标了，防止把一堆大图塞进响应。 */
const MAX_ICON_BYTES = 64 * 1024;

/** 单个 SKILL.md 的读取上限：技能正文不会这么大，超过就当不是技能文件。 */
const MAX_SKILL_BYTES = 512 * 1024;

/**
 * 盘点技能目录里自带的图标。
 *
 * 社区里常见的约定是把图标放在技能目录的 `assets/` 下（`assets/icon.png` 等），
 * 也有直接放在目录根的。这里两种都看，输出「技能目录相对路径 → data URL」。
 *
 * 由宿主读而不是让浏览器去读：宿主本来就有磁盘权限，浏览器侧不必为一张图标
 * 再开一条路由。任何一步失败都只是这一条没有图标，绝不影响技能列表本身。
 *
 * @param dirs - 技能目录（SKILL.md 所在目录）列表。
 * @returns 相对路径到 data URL 的映射。
 */
async function readSkillIcons(dirs: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};

  for (const dir of dirs) {
    for (const folder of ['assets', '']) {
      let entries;
      try {
        entries = await readdir(join(dir, folder), { withFileTypes: true });
      } catch {
        continue; // 没有这个子目录就跳过。
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const mime = ICON_MIME[extname(entry.name).toLowerCase()];
        if (mime === undefined) continue;
        const full = join(dir, folder, entry.name);
        try {
          const info = await stat(full);
          if (info.size > MAX_ICON_BYTES) continue;
          const data = await readFile(full);
          const rel = folder === '' ? entry.name : `${folder}/${entry.name}`;
          out[`${dir}\u0000${rel}`] = `data:${mime};base64,${data.toString('base64')}`;
        } catch {
          // 单个图标读失败不影响其余。
        }
      }
    }
  }
  return out;
}

/** 技能目录盘点的结果。 */
export interface SkillListing {
  /** 注册表是否存在（false 时入口给出可读提示，而不是空列表）。 */
  available: boolean;
  /** 询问注册表时用的工作目录。 */
  cwd: string;
  /** 发现是否完整（某些提供方出错时为 false，列表仍可用）。 */
  complete: boolean;
  /**
   * 本次列出的技能来自哪些插件（诊断用）。
   *
   * 真实环境里出现过「只列出内置技能、用户技能不见了」的情况，而本地用同一个
   * 注册表能全列出来。把「用的是哪个注册表的哪几个提供方」直接摆到界面上，
   * 比让用户去猜是环境问题还是代码问题快得多。
   */
  providers: string[];
  /** 本次询问注册表的工作目录（项目级技能靠它发现）。 */
  askedCwd: string;
  /**
   * 注册表里**登记在册**的提供方名字（不只是这次供出技能的）。
   *
   * 与 `providers` 的区别：`providers` 是「这次真的给了技能」，这里是「装了哪些」。
   * 两者对不上就说明某个提供方挂了却没产出，是排查的关键。
   */
  registeredProviders: string[];
  skills: SkillSummary[];
  /** 「技能目录 + NUL + 相对路径」→ 图标 data URL。 */
  icons: Record<string, string>;
  /**
   * 内置技能正文的不透明 token → 技能名。
   *
   * 插件内置的技能（如 Office 三件套）**没有 `SKILL.md` 路径**，宿主侧读不到文件；
   * 但注册表的 `get(name)` 能拿到完整正文。这里只发一个随机 token、不发名字，
   * 避免让客户端能按名字任意取任意技能。
   */
  inline: Record<string, string>;
}

// ---------------------------------------------------------------------------
// 技能目录树（宿主平面）
// ---------------------------------------------------------------------------

/** 技能目录里的一条：子目录或文件。 */
export interface SkillTreeNode {
  /** 文件名（含扩展名）。 */
  name: string;
  /** 绝对路径，可直接交给 `read-skill-file`。 */
  path: string;
  /** 相对技能目录的路径（用 `/` 分隔），界面用它判断层级与提示。 */
  rel: string;
  /** 层级：1 表示技能目录的直接子项。 */
  depth: number;
  kind: 'directory' | 'file';
  /** 文件字节数（目录没有）。 */
  size?: number;
  /** 是否还会继续展开（目录；文件恒为 false）。 */
  hasChildren?: boolean;
}

/** 技能目录树接口的返回。 */
export interface SkillTree {
  /** 技能目录绝对路径。 */
  path: string;
  /** 该目录下是否有 SKILL.md（false 说明这条不是目录包技能）。 */
  hasSkillMd: boolean;
  /** 直接子项（已排序；未越界的目录按「浅层优先」继续展开）。 */
  entries: SkillTreeNode[];
  /**
   * 没有展开的目录绝对路径。
   *
   * 界面据此显示「还有更深的内容」——技能里常见 `scripts/lib/` 这种多层结构，
   * 但绝大多数时候用户只看第一层。这里如实列出「没读完的目录」，而不是让界面
   * 去猜截断发生在哪。
   */
  collapsed: string[];
  /** 展开是否被上限截断（为 true 时界面提示「只显示了前 N 项」）。 */
  truncated: boolean;
}

/**
 * 技能文件树的最大深度（技能目录算第 0 层，`rules/a.md` 是深度 2）。
 *
 * 技能包一般两三层就到底了；`skill-creator` 这类带 `scripts/`、`assets/`、
 * `eval-viewer/` 的也就是三四层。留到 6 层足够，同时天然砍掉异常深的目录。
 */
const SKILL_TREE_MAX_DEPTH = 6;

/**
 * 技能文件树最多列多少条。
 *
 * 一次请求的产物要塞进一个 JSON 响应，而 `assets/` 里放几十张图是常态。
 * 300 条既能装下真实技能，又不至于让响应体失控；超过就截断并告诉界面。
 */
const SKILL_TREE_LIMIT = 300;

/**
 * 技能目录里**不展示**的名字。
 *
 * 与笔记文件树（`isHiddenEntry`）的取舍略有不同：那里隐藏一切点开头的条目，
 * 因为笔记目录里 `.git`、`.obsidian` 这类元数据只会干扰阅读。技能目录则常常
 * 有 `.db-check.json` 这种「作者自己核对用的脚本产物」，同样没有阅读价值。
 *
 * 注意只是不展示：真要读（例如从历史 tab 里）仍然读得到。
 */
function isHiddenSkillEntry(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/**
 * 列出一个技能目录下的文件。
 *
 * 为什么要有这条路由：技能常常是**按需加载**的 —— `SKILL.md` 里写着「遇到 X
 * 就读 `rules/x.md`」，正文被拆进 `rules/`、`references/`、`scripts/` 等子目录。
 * 只给 SKILL.md 一个文件时，读者根本不知道还有哪些配套文件，更打不开。
 *
 * 三个安全约束：
 * 1. 围栏复用 `insideAnyRoot`，根是一组技能根目录 —— 与 `read-skill-file` 同源，
 *    两处松紧一致；
 * 2. **不跟随符号链接**（`withFileTypes` 给的是 lstat 语义，`isDirectory()` 对
 *    符号链接为 false），所以链接不会把遍历带出技能目录，也不会成环；
 * 3. 深度与条数都有上限，异常目录不会拖垮请求。
 *
 * @param dir - 技能目录绝对路径。
 * @param roots - 允许的技能根目录（已规范化的绝对路径）。
 * @returns 技能目录树。
 * @throws HttpError 路径非法、越界或不是目录。
 */
export async function listSkillTree(dir: string, roots: readonly string[]): Promise<SkillTree> {
  if (typeof dir !== 'string' || dir.trim() === '') throw new HttpError(400, 'path is required');
  if (!isAbsolute(dir) || dir.includes('\0')) throw new HttpError(400, 'invalid path');

  const root = insideAnyRoot(normalize(resolve(dir)), roots);
  if (root === null) throw new HttpError(403, 'path is outside the skill roots');

  const base = normalize(resolve(dir));
  const info = await stat(base);
  if (!info.isDirectory()) throw new HttpError(400, 'not a directory');

  let hasSkillMd = false;
  try {
    hasSkillMd = (await stat(join(base, 'SKILL.md'))).isFile();
  } catch {
    // 没有 SKILL.md 不是错误：调用方据此决定是否提示「这不是目录包技能」。
  }

  const entries: SkillTreeNode[] = [];
  /** 因深度上限而没有继续展开的目录。 */
  const deepDirs: string[] = [];
  let truncated = false;

  /** 列一层（广度优先的一步），返回下一层要展开的目录。 */
  const walk = async (current: string, depth: number): Promise<string[]> => {
    let children;
    try {
      children = await readdir(current, { withFileTypes: true });
    } catch {
      return []; // 读不到就当空目录，不影响其余。
    }

    const next: string[] = [];
    // 目录在前、同级按自然序忽略大小写，与笔记文件树的排序一致。
    const sorted = children
      .filter((child) => !isHiddenSkillEntry(child.name))
      .sort((a, b) => {
        const da = a.isDirectory() ? 0 : 1;
        const db = b.isDirectory() ? 0 : 1;
        if (da !== db) return da - db;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });

    for (const child of sorted) {
      if (entries.length >= SKILL_TREE_LIMIT) {
        truncated = true;
        return next;
      }
      const full = join(current, child.name);
      const rel = full.slice(base.length + 1).split(sep).join('/');

      if (child.isDirectory()) {
        // 到深度上限的目录仍然列出来（用户要知道它存在），只是不再往里读。
        const expandable = depth < SKILL_TREE_MAX_DEPTH;
        entries.push({
          name: child.name,
          path: full,
          rel,
          depth,
          kind: 'directory',
          hasChildren: expandable,
        });
        if (expandable) next.push(full);
        else deepDirs.push(full);
        continue;
      }
      if (!child.isFile()) continue; // 符号链接等一律不跟随，避免越界与成环。

      let size: number | undefined;
      try {
        const fileInfo = await stat(full);
        size = fileInfo.size;
      } catch {
        // 读不到大小不影响列出。
      }
      entries.push({
        name: child.name,
        path: full,
        rel,
        depth,
        kind: 'file',
        ...(size === undefined ? {} : { size }),
      });
    }
    return next;
  };

  // 广度优先：先铺满第一层，再逐层深入 —— 一旦触到上限，被截掉的是深层而不是
  // 用户最先要看的那几层。
  let frontier = await walk(base, 1);
  let depth = 2;
  while (frontier.length > 0 && !truncated && depth <= SKILL_TREE_MAX_DEPTH) {
    const next: string[] = [];
    for (const dirPath of frontier) {
      if (entries.length >= SKILL_TREE_LIMIT) {
        truncated = true;
        break;
      }
      next.push(...(await walk(dirPath, depth)));
    }
    frontier = next;
    depth += 1;
  }

  return {
    path: base,
    hasSkillMd,
    entries,
    // 只报「存在但没读进去」的目录：深度到顶的，加上因上限被整批跳过的。
    collapsed: [...deepDirs, ...(truncated ? frontier : [])],
    truncated,
  };
}

// ---------------------------------------------------------------------------
// 技能根目录扫描
// ---------------------------------------------------------------------------

/**
 * 一个技能根目录：路径 + 来源分组 + 优先级。
 *
 * `rank` 越小越优先，与 DSH 官方 `dsh-skill-filesystem` 的约定一致：
 * 项目 > 自定义 > 用户 > 内置。
 */
interface SkillRoot {
  path: string;
  /** 来源分组，界面按它分类显示。 */
  source: 'project' | 'custom' | 'user' | 'bundled';
  rank: number;
  /** 是否跳过 `.system` 子目录（DSH 的用户根里有系统技能，不算用户技能）。 */
  skipSystem?: boolean;
}

/**
 * 从路径往上找最近的、含 `.git` 的祖先目录；找不到就用起点本身。
 *
 * 这与 DSH 自己的「项目根」判定一致：`<项目根>/.dsh/skills` 才是项目技能。
 *
 * @param start - 起始目录（通常是会话工作目录）。
 * @returns 项目根绝对路径。
 */
async function findProjectRoot(start: string): Promise<string> {
  let current = resolve(start);
  // 有深度上限，避免在异常路径上无限往上跑。
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const info = await stat(join(current, '.git'));
      if (info.isDirectory() || info.isFile()) return current;
    } catch {
      // 没有 .git，继续往上。
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(start);
}

/**
 * 取当前会话的工作目录（决定项目级技能根在哪）。
 *
 * 先问会话登记表，拿不到再退回进程 cwd。技能列表与技能文件读取都用它，
 * 保证两条路由看到的是同一批根目录。
 *
 * @param sessions - 会话登记表（可能不存在）。
 * @returns 工作目录绝对路径。
 */
async function resolveSessionCwd(sessions: SessionRegistryFacade | null): Promise<string> {
  try {
    const all = sessions?.list?.();
    if (Array.isArray(all)) {
      const first = all.find(
        (item) => typeof item?.header?.cwd === 'string' && item.header.cwd !== '',
      );
      if (first !== undefined && typeof first.header?.cwd === 'string') return first.header.cwd;
    }
  } catch {
    // 会话表不可用就退回进程 cwd，只影响项目级技能能否被发现。
  }
  return process.cwd();
}

/**
 * 列出本次应该扫描的技能根目录。
 *
 * 按 DSH 官方约定排列（rank 越小越优先）：
 * - 100 `<项目根>/.dsh/skills`
 * - 200 `<项目根>/.agents/skills`
 * - 300 自定义目录（插件配置）
 * - 400 `~/.dsh/skills`（跳过 `.system`）
 * - 500 `~/.agents/skills`
 *
 * @param cwd - 会话工作目录（决定项目根）。
 * @param customDirs - 额外的自定义目录。
 * @returns 根目录列表。
 */
async function skillRootsFor(cwd: string, customDirs: readonly string[]): Promise<SkillRoot[]> {
  const home = homedir();
  const projectRoot = await findProjectRoot(cwd);
  const roots: SkillRoot[] = [
    { path: join(projectRoot, '.dsh', 'skills'), source: 'project', rank: 100 },
    { path: join(projectRoot, '.agents', 'skills'), source: 'project', rank: 200 },
  ];
  for (const dir of customDirs) {
    if (typeof dir !== 'string' || dir.trim() === '') continue;
    roots.push({ path: resolve(dir), source: 'custom', rank: 300 });
  }
  // DSH 与 Agents 的用户根：HOME 下的可见目录，不递归，跳过 .system。
  roots.push({ path: join(home, '.dsh', 'skills'), source: 'user', rank: 400, skipSystem: true });
  roots.push({ path: join(home, '.agents', 'skills'), source: 'user', rank: 500 });
  return roots;
}

/**
 * 解析 SKILL.md 开头的 YAML frontmatter。
 *
 * 只认 DSH 实际用到的几个键（`name`、`description`、`whenToUse`、
 * `disable-model-invocation`、`metadata`）；不是通用 YAML 解析器 ——
 * 这里刻意保持小而可预测，遇到不认识的写法就忽略，不影响其余字段。
 *
 * @param text - 文件全文。
 * @returns 解析结果；没有 frontmatter 时返回 null。
 */
function parseFrontmatter(text: string): {
  name?: string;
  description?: string;
  whenToUse?: string;
  modelInvocable: boolean;
} | null {
  // frontmatter 必须在文件最前面：`---` 起、`---` 止。
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match === null) return null;
  const body = match[1] ?? '';

  const out: { name?: string; description?: string; whenToUse?: string; modelInvocable: boolean } = {
    modelInvocable: true,
  };

  // 逐行处理「键: 值」，值可能是单行，也可能是 `|` / `>` 开头的多行块。
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv === null) continue;
    const key = kv[1] ?? '';
    let value = (kv[2] ?? '').trim();

    // 多行标量：收集后续缩进行。
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const collected: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? '';
        if (next.trim() !== '' && !/^\s/.test(next)) break;
        collected.push(next.trim());
        i += 1;
      }
      value = collected.join(' ').trim();
    }

    // 去掉包裹的引号。
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    if (key === 'name') out.name = value;
    else if (key === 'description') out.description = value;
    else if (key === 'whenToUse') out.whenToUse = value;
    else if (key === 'disable-model-invocation') {
      out.modelInvocable = !/^(true|yes|on|1)$/i.test(value);
    }
  }
  return out;
}

/** 扫描得到的一条技能（比注册表的摘要多一个来源字段）。 */
interface ScannedSkill extends SkillSummary {
  /** 来源分组。 */
  source: 'project' | 'custom' | 'user' | 'bundled';
  /** 优先级的数值形式（越小越优先），用于合并时裁决重名。 */
  rank: number;
}

/**
 * 扫描一个技能根目录。
 *
 * DSH 的约定是**不递归**：只认根目录顶层的 `<name>/SKILL.md` 目录包，或
 * `<name>.md` 平铺文件。这里照做，避免扫出一堆目录里碰巧叫 SKILL.md 的东西。
 *
 * @param root - 根目录描述。
 * @param limit - 最多读多少个（防止异常目录拖垮请求）。
 * @returns 扫到的技能列表（不含顺序保证）。
 */
async function scanSkillRoot(root: SkillRoot, limit = 500): Promise<ScannedSkill[]> {
  let entries;
  try {
    entries = await readdir(root.path, { withFileTypes: true });
  } catch {
    return []; // 目录不存在是最常见的情况，静默跳过。
  }

  const out: ScannedSkill[] = [];
  for (const entry of entries) {
    if (out.length >= limit) break;
    if (root.skipSystem === true && entry.name === '.system') continue;
    if (entry.name.startsWith('.')) continue;

    // 形态一：目录包 `<name>/SKILL.md`
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const file = join(root.path, entry.name, 'SKILL.md');
      let raw: string;
      let info;
      try {
        info = await stat(file);
        if (!info.isFile() || info.size > MAX_SKILL_BYTES) continue;
        raw = await readFile(file, 'utf8');
      } catch {
        continue; // 目录里没有 SKILL.md，或读不到。
      }
      const meta = parseFrontmatter(raw);
      if (meta?.name === undefined || meta.name === '' || meta.description === undefined) continue;
      out.push({
        name: meta.name,
        description: meta.description,
        ...(meta.whenToUse === undefined ? {} : { whenToUse: meta.whenToUse }),
        path: file,
        modelInvocable: meta.modelInvocable,
        source: root.source,
        rank: root.rank,
      });
      continue;
    }

    // 形态二：平铺文件 `<name>.md`
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const file = join(root.path, entry.name);
      let raw: string;
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size > MAX_SKILL_BYTES) continue;
        raw = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const meta = parseFrontmatter(raw);
      if (meta?.name === undefined || meta.name === '' || meta.description === undefined) continue;
      out.push({
        name: meta.name,
        description: meta.description,
        ...(meta.whenToUse === undefined ? {} : { whenToUse: meta.whenToUse }),
        path: file,
        modelInvocable: meta.modelInvocable,
        source: root.source,
        rank: root.rank,
      });
    }
  }
  return out;
}

/**
 * 扫描所有技能根，并按名字裁决重名（rank 小的胜出）。
 *
 * 与 DSH 注册表的裁决规则一致：同一个名字出现多次时，优先级高的来源胜出；
 * 这样「项目里覆盖了用户技能」这类常见用法才有预期行为。
 *
 * @param cwd - 会话工作目录。
 * @param customDirs - 额外的自定义目录。
 * @returns 裁决后的技能列表。
 */
async function scanSkills(cwd: string, customDirs: readonly string[]): Promise<ScannedSkill[]> {
  const roots = await skillRootsFor(cwd, customDirs);
  const found = (await Promise.all(roots.map((root) => scanSkillRoot(root)))).flat();

  const byName = new Map<string, ScannedSkill>();
  for (const skill of found) {
    const existing = byName.get(skill.name);
    // 同 rank 时后来的不覆盖先来的，保持确定性。
    if (existing === undefined || skill.rank < existing.rank) byName.set(skill.name, skill);
  }
  return [...byName.values()];
}

/**
 * 读出注册表里登记在册的提供方名字（诊断用）。
 *
 * 官方注册表没有公开这个信息，只能顺着 `layers.global.providers` 读它的键。
 * 这是**内部结构**，随时可能变 —— 所以全程容错：读不到就返回空数组，
 * 绝不让诊断影响功能。
 *
 * @param skills - 注册表（可能不存在或结构不符）。
 * @returns 提供方名字数组。
 */
export function readRegisteredProviders(skills: SkillRegistryFacade | null): string[] {
  try {
    const providers = skills?.layers?.global?.providers;
    if (providers === undefined || providers === null) return [];
    if (providers instanceof Map) return [...providers.keys()];
    if (typeof providers.keys === 'function') return [...providers.keys()];
    return [];
  } catch {
    return [];
  }
}

/**
 * 列出当前可见的技能。
 *
 * 数据全部来自官方注册表；本函数只做两件注册表不管的事：
 * 1. 决定用哪个工作目录去问（先问会话登记表，退到进程 cwd）；
 * 2. 顺手盘一下技能目录里的图标文件。
 *
 * @param skills - 官方 skill 注册表（可能不存在）。
 * @param sessions - 会话登记表（可能不存在）。
 * @returns 技能列表与所用工作目录。
 */
export async function listSkills(
  skills: SkillRegistryFacade | null,
  sessions: SessionRegistryFacade | null,
  customDirs: readonly string[] = [],
): Promise<SkillListing> {
  // 项目级技能（`<项目根>/.dsh/skills`）要靠工作目录才能找到，所以先问会话登记表。
  // 进程 cwd 是安装目录，拿它去问会漏掉项目级技能。
  const cwd = await resolveSessionCwd(sessions);

  // ---- 1) 先扫磁盘（这是用户自己的技能的唯一可靠来源，见上方注释）----
  // 宿主平面读不到 preset 层的 skill-filesystem，所以不能只靠注册表。
  let scanned: ScannedSkill[] = [];
  let scannedComplete = true;
  try {
    scanned = await scanSkills(cwd, customDirs);
  } catch {
    scannedComplete = false;
  }

  if (skills === null || (typeof skills.list !== 'function' && typeof skills.snapshot !== 'function')) {
    // 没有注册表也要能把扫描到的技能给出来：内置技能看不到，但用户技能照常。
    return finishListing(cwd, scanned, [], false, scannedComplete, skills);
  }

  let raw: readonly unknown[] = [];
  let complete = true;
  try {
    if (typeof skills.snapshot === 'function') {
      const snapshot = await skills.snapshot({ cwd });
      raw = Array.isArray(snapshot?.skills) ? snapshot.skills : [];
      complete = snapshot?.complete !== false;
    } else if (typeof skills.list === 'function') {
      const listed = await skills.list({ cwd });
      raw = Array.isArray(listed) ? listed : [];
    }
  } catch {
    // 注册表整体出错时不影响扫描结果，只是少了内置技能。
    return finishListing(cwd, scanned, [], true, false, skills);
  }

  const fromRegistry: SkillSummary[] = [];
  /** 提供方名字集合：注册表的 summary 里带 `provider`（哪些提供方真的供了技能）。 */
  const providers = new Set<string>();
  for (const item of raw) {
    const skill = normalizeSkill(item);
    if (skill === null) continue;
    fromRegistry.push(skill);
    const provider = (item as Record<string, unknown>).provider;
    if (typeof provider === 'string' && provider !== '') providers.add(provider);
  }

  return finishListing(cwd, scanned, fromRegistry, true, scannedComplete && complete, skills);
}

/**
 * 把「扫描结果」与「注册表结果」合并成最终列表。
 *
 * 合并规则：
 * 1. **扫描优先**：扫描出来的带真实 `path`，能直接打开正文；注册表里同名的
 *    （宿主平面通常读不到 preset 层，所以一般没有）让位。
 * 2. 注册表独有的（内置技能，如 Office 三件套）保留，它们没有 path，
 *    界面标「内置」，正文走 token 换。
 *
 * @param cwd - 本次使用的工作目录。
 * @param scanned - 磁盘扫描结果。
 * @param fromRegistry - 注册表结果。
 * @param available - 注册表是否可用。
 * @param complete - 发现是否完整。
 * @param skills - 注册表（只用来读诊断信息）。
 * @returns 最终响应。
 */
async function finishListing(
  cwd: string,
  scanned: readonly ScannedSkill[],
  fromRegistry: readonly SkillSummary[],
  available: boolean,
  complete: boolean,
  skills: SkillRegistryFacade | null,
): Promise<SkillListing> {
  const list: SkillSummary[] = [];
  const seen = new Set<string>();

  for (const skill of scanned) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    list.push({
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      path: skill.path,
      modelInvocable: skill.modelInvocable,
      source: skill.source,
    });
  }
  for (const skill of fromRegistry) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    // 来自注册表、又不在磁盘上的，一定是插件自带的（bundled）。
    list.push({ ...skill, source: 'bundled' });
  }
  list.sort((a, b) => a.name.localeCompare(b.name));

  // 图标既可能出现在 SKILL.md 所在目录，也可能在 resourceBase 指的目录，
  // 两者都扫一遍（插件内置技能只有后者）。
  const dirs: string[] = [];
  for (const skill of list) {
    for (const dir of [skill.path === undefined ? undefined : dirname(skill.path), skill.resourceDir]) {
      if (dir === undefined || dirs.includes(dir)) continue;
      dirs.push(dir);
    }
  }
  const icons = dirs.length === 0 ? {} : await readSkillIcons(dirs);

  // 给「没有文件的内置技能」各发一个不透明 token，客户端拿它换正文。
  // token 每次列表都重发，且与技能名不对应，客户端无法伪造去取未列出的技能。
  const inline: Record<string, string> = {};
  for (const skill of list) {
    if (skill.path !== undefined) continue;
    const token = randomBytes(12).toString('hex');
    inline[token] = skill.name;
  }

  return {
    available,
    cwd,
    complete,
    skills: list,
    icons,
    inline,
    // 合并后的来源：扫描出来的按来源分组记，注册表来的记成 bundled。
    providers: [
      ...new Set([
        ...scanned.map((skill) => String(skill.source)),
        ...(fromRegistry.length > 0 ? ['bundled'] : []),
      ]),
    ],
    askedCwd: cwd,
    registeredProviders: readRegisteredProviders(skills),
  };
}

// ---------------------------------------------------------------------------
// 路径安全
// ---------------------------------------------------------------------------

/** 允许浏览/编辑的文本类扩展名（小写，含点）。 */
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.text',
  '.json',
  '.jsonc',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.conf',
  '.log',
  '.csv',
  '.tsv',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.less',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.php',
  '.sh',
  '.bash',
  '.zsh',
  '.sql',
  '.env',
  '.gitignore',
]);

/** 该文件名是否是可编辑的文本文件。 */
function isTextFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  // 无扩展名的常见文本文件（LICENSE、Makefile 等）允许按纯文本打开。
  const base = basename(filePath).toLowerCase();
  if (ext === '' && base !== '' && !base.startsWith('.')) return true;
  return false;
}

/**
 * 把用户传入的路径解析成绝对路径，并校验它落在某个已授权的根目录内。
 *
 * 每个请求都要求客户端带上 `root`（用户显式选中的文件夹），
 * 目标路径必须等于 root 或位于 root 之下，杜绝 `../` 越权读取。
 *
 * @param rawPath - 客户端给的路径（绝对路径）。
 * @param rawRoot - 用户选中的根目录（绝对路径）。
 * @returns 规范化后的 { target, root }，或抛错。
 */
function resolveInsideRoot(rawPath: string, rawRoot: string): { target: string; root: string } {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new HttpError(400, 'path is required');
  }
  if (typeof rawRoot !== 'string' || rawRoot.trim() === '') {
    throw new HttpError(400, 'root is required');
  }
  if (!isAbsolute(rawPath) || !isAbsolute(rawRoot)) {
    throw new HttpError(400, 'path and root must be absolute');
  }
  // 拒绝 NUL 注入。
  if (rawPath.includes('\0') || rawRoot.includes('\0')) {
    throw new HttpError(400, 'invalid path');
  }

  const root = normalize(resolve(rawRoot));
  const target = normalize(resolve(rawPath));

  if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new HttpError(403, 'path is outside the selected root');
  }
  return { target, root };
}

/**
 * 判断 `target` 是否落在任意一个根之内（路径围栏的唯一实现）。
 *
 * 三处需要「一组根」的地方都走这里，避免各写一遍导致松紧不一：
 * 1. 已打开的文件（`read` / `write` 的 `roots` 参数）；
 * 2. 技能目录树（`skill-tree`，根是一组技能根目录）；
 * 3. 技能文件的直接读取（`read-skill-file`）。
 *
 * @param target - 已规范化的目标绝对路径。
 * @param rawRoots - 允许的根目录（绝对路径，可含空值）。
 * @returns 命中的规范化根目录；都不命中时返回 null。
 */
function insideAnyRoot(target: string, rawRoots: readonly string[]): string | null {
  for (const rawRoot of rawRoots) {
    if (typeof rawRoot !== 'string' || rawRoot.trim() === '') continue;
    if (!isAbsolute(rawRoot) || rawRoot.includes('\0')) continue;
    const root = normalize(resolve(rawRoot));
    if (target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)) {
      return root;
    }
  }
  return null;
}

/**
 * 判断 `target` 是否落在某个允许的根之内。
 *
 * 与 `resolveInsideRoot` 的区别：这里是**一组根**而不是一个。用于「已打开的
 * 文件」——用户的 tab 与置顶可能来自之前选过的其他文件夹，切根之后它们仍然
 * 应当能读能存，否则切一下文件夹，之前打开的标签就全变成打不开了。
 *
 * @param rawPath - 目标绝对路径。
 * @param rawRoots - 允许的根（至少一个）。
 * @returns 规范化后的目标与命中的根（与 `resolveInsideRoot` 同形，便于互换）。
 * @throws HttpError 路径非法或不在任何根之内。
 */
function resolveInsideAnyRoot(
  rawPath: string,
  rawRoots: readonly string[],
): { target: string; root: string } {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new HttpError(400, 'path is required');
  }
  if (!isAbsolute(rawPath) || rawPath.includes('\0')) {
    throw new HttpError(400, 'invalid path');
  }
  const target = normalize(resolve(rawPath));

  const hit = insideAnyRoot(target, rawRoots);
  if (hit === null) throw new HttpError(403, 'path is outside the selected root');
  return { target, root: hit };
}

/** 带 HTTP 状态码的错误。 */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// 文件操作
// ---------------------------------------------------------------------------

/** 目录项。 */
interface DirEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file' | 'other';
  /** 是否是可编辑的文本文件。 */
  editable: boolean;
  /** 文件字节数（目录为 undefined）。 */
  size?: number;
  /** 最后修改时间（毫秒时间戳）。 */
  mtimeMs?: number;
}

/**
 * 是否把该条目从文件树里隐藏。
 *
 * 隐藏两类：
 * 1. 以 `.` 开头的条目（`.git`、`.obsidian`、`.env` 等）—— 笔记面板是拿来看文档的，
 *    这些配置与元数据只会干扰浏览。
 * 2. `node_modules` —— 体量巨大且与笔记无关，展开会拖垮树。
 *
 * 注意：这里只是「不展示」，不是禁止访问。用户若通过置顶直接指定了隐藏目录里的
 * 文件，读取与写入仍然照常工作，避免置顶项突然打不开。
 *
 * @param name - 条目的 basename。
 * @returns 是否从文件树里隐藏。
 */
function isHiddenEntry(name: string): boolean {
  if (name.startsWith('.')) return true;
  return name === 'node_modules';
}

/** 列出目录的直接子项：目录在前，其余按自然序、忽略大小写。 */
async function listDirectory(dirPath: string): Promise<DirEntry[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const out: DirEntry[] = [];

  for (const entry of entries) {
    // 隐藏文件/目录与 node_modules 不进树。
    if (isHiddenEntry(entry.name)) continue;

    const full = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      out.push({ name: entry.name, path: full, kind: 'directory', editable: false });
      continue;
    }
    if (entry.isFile()) {
      let size: number | undefined;
      let mtimeMs: number | undefined;
      try {
        const info = await stat(full);
        size = info.size;
        mtimeMs = info.mtimeMs;
      } catch {
        // 读不到元信息不影响列出，退化成未知大小。
      }
      out.push({
        name: entry.name,
        path: full,
        kind: 'file',
        editable: isTextFile(full),
        ...(size === undefined ? {} : { size }),
        ...(mtimeMs === undefined ? {} : { mtimeMs }),
      });
      continue;
    }
    // 符号链接等一律按 other 灰色展示，不跟随，避免越权与循环。
    out.push({ name: entry.name, path: full, kind: 'other', editable: false });
  }

  out.sort((a, b) => {
    if (a.kind === 'directory' && b.kind !== 'directory') return -1;
    if (a.kind !== 'directory' && b.kind === 'directory') return 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase(), undefined, { numeric: true });
  });

  return out;
}

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖目标。
 * rename 在同一文件系统内是原子的，所以读者要么看到旧内容要么看到新内容。
 */
async function atomicWrite(target: string, content: string): Promise<void> {
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' });
    await rename(tmp, target);
  } catch (error) {
    try {
      await unlink(tmp);
    } catch {
      // 清理失败不掩盖原始错误。
    }
    throw error;
  }
}

/**
 * 把文件移入系统回收站。
 *
 * 按平台依次尝试系统回收站的位置，与系统行为保持一致：
 * - macOS：`~/.Trash`，用户能在「访达 → 废纸篓」里看到并「放回原处」；
 * - Linux：`~/.local/share/Trash/files`（XDG 规范）；
 * - Windows：**没有可移植的用户态回收站路径**。真正的回收站只能通过
 *   `SHFileOperation` / PowerShell 的 `Shell.Application` 等 API 写入，
 *   为避免调用外部命令及其失败面，这里不走那条路，直接落到下面的回退目录。
 *
 * 回退目录刻意**不以点开头**（`<root>/dsh-notes-trash`）：文件树会隐藏所有点开头的
 * 条目，若叫 `.dsh-notes-trash`，被删的文件在界面上就彻底找不到了 —— 虽然它还在
 * 磁盘上，但用户会以为"删没了"。不带点则它在树里可见、可点开、可取回。
 *
 * 同名文件不覆盖：目标已存在时自动加时间戳前缀。
 *
 * @param source - 要删除的文件绝对路径。
 * @param rootDir - 用户选中的根目录，用于回退回收站与结果展示。
 * @returns 文件最终去向，以及是否用了回退方案。
 */
async function moveToTrash(source: string, rootDir: string): Promise<{ moved: string; fallback: boolean }> {
  const home = homedir();
  const candidates = [
    join(home, '.Trash'), // macOS 系统废纸篓
    join(home, '.local', 'share', 'Trash', 'files'), // Linux XDG 废纸篓
  ];

  for (const dir of candidates) {
    try {
      await mkdir(dir, { recursive: true });
      const dest = await uniquePath(dir, basename(source));
      await rename(source, dest);
      return { moved: dest, fallback: false };
    } catch {
      // 换下一个候选位置；全都失败时走下面的回退。
    }
  }

  // 回退目录不带点，理由见上：带点会被文件树隐藏，用户就找不回误删的文件了。
  const fallbackDir = join(rootDir, TRASH_DIR_NAME);
  await mkdir(fallbackDir, { recursive: true });
  const dest = await uniquePath(fallbackDir, basename(source));
  await rename(source, dest);
  return { moved: dest, fallback: true };
}

/**
 * 在目标目录里找一个不冲突的路径。
 *
 * @param dir - 目标目录。
 * @param name - 期望的文件名。
 * @returns 可直接使用的绝对路径（已存在时加 `<时间戳>-` 前缀）。
 */
async function uniquePath(dir: string, name: string): Promise<string> {
  const direct = join(dir, name);
  try {
    await stat(direct);
  } catch {
    return direct; // 不存在，直接用。
  }
  return join(dir, `${Date.now()}-${name}`);
}

/**
 * 移动文件或目录到另一个目录下。
 *
 * 只接受「文件」与「目录」，且目标必须是目录。同目录移动视为无操作，
 * 目标已存在同名项时报 409，避免静默覆盖用户的东西。
 *
 * @param source - 源路径（绝对）。
 * @param destDir - 目标目录（绝对）。
 * @returns 移动后的新路径。
 */
async function movePath(source: string, destDir: string): Promise<string> {
  const destInfo = await stat(destDir);
  if (!destInfo.isDirectory()) throw new HttpError(400, 'destination is not a directory');

  const target = join(destDir, basename(source));

  // 原地不动：直接当成功返回，不打扰用户。
  if (dirname(source) === destDir) return source;

  // 不允许把目录移进它自己的子孙里，否则会形成环或直接把树弄坏。
  if (destDir === source || destDir.startsWith(source.endsWith(sep) ? source : source + sep)) {
    throw new HttpError(400, 'cannot move a directory into itself');
  }

  try {
    await stat(target);
    throw new HttpError(409, `目标位置已有同名文件：${basename(source)}`);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // stat 失败即目标不存在，可以移动。
  }

  await rename(source, target);
  return target;
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
};

/** 写出一个 JSON 响应。 */
function writeJson(
  res: { writeHead(status: number, headers: Record<string, string>): void; end(body: string): void },
  status: number,
  body: unknown,
): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** 读取并解析 JSON 请求体；空体、非法 JSON、超限都返回 null。 */
async function readJsonBody(
  req: AsyncIterable<Buffer | string>,
  maxBytes: number,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > maxBytes) return null;
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 路由路径（客户端 bundle 镜像这些字面量）。 */
/** 本插件在 profile 的 `cordis.patch.yml` 里的行 id（写配置时按它找条目）。 */
const ENTRY_ID = 'ui-notes';

export const ROUTES = {
  list: '/api/dsh-notes/list',
  read: '/api/dsh-notes/read',
  write: '/api/dsh-notes/write',
  create: '/api/dsh-notes/create',
  remove: '/api/dsh-notes/remove',
  move: '/api/dsh-notes/move',
  health: '/api/dsh-notes/health',
  latestVersion: '/api/dsh-notes/latest-version',
  skills: '/api/dsh-notes/skills',
  skillContent: '/api/dsh-notes/skill-content',
  readSkillFile: '/api/dsh-notes/read-skill-file',
  skillTree: '/api/dsh-notes/skill-tree',
  config: '/api/dsh-notes/config',
} as const;

/** 一条路由的形状（与 ctx.webServer.register 兼容）。 */
interface Route {
  kind: 'exact';
  path: string;
  handler: (req: RouteRequest, res: RouteResponse) => Promise<void> | void;
}

/** 路由处理收到的请求（只声明用到的字段）。 */
interface RouteRequest {
  method?: string;
  url?: string;
  headers: Record<string, unknown>;
  socket: { remoteAddress?: string };
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>;
}

/** 路由处理写出的响应。 */
interface RouteResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body: string): void;
}

/** 日志接口（宿主 logger 的最小子集）。 */
interface Logger {
  warn(error: unknown): void;
}

/**
 * 构造全部 /api/dsh-notes 路由。
 * @param logger - 宿主 logger。
 * @param config - 已解析的插件配置。
 * @param optional - 插件存在才用到的官方服务（缺失时对应路由降级，不影响其余功能）。
 * @returns 路由列表。
 */
export function makeRoutes(
  logger: Logger,
  config: Config = {},
  optional: {
    skills?: unknown;
    sessions?: unknown;
    /** 配置写回通道（`ctx.configEditor`），用来把插件页的开关落进 profile。 */
    configEditor?: unknown;
    /** 可选服务读取器：传了就在每次用到时现取，避免 apply 时序把能力定死。 */
    resolveOptional?: (name: string) => unknown;
  } = {},
): Route[] {
  /**
   * 取当前配置。
   *
   * 配置对象是**活的**：`.volatile()` 字段改动不会重启插件（见 `ConfigSchema`
   * 上面的说明），cordis 只把新值写回运行中 fiber 的 `config`。所以每次用到
   * 都得现读，不能在 apply 阶段做一份快照 —— 那样用户在插件页关掉技能阅读，
   * 服务端还在按「开」放行，两边对不上。
   */
  /**
   * 读一个配置项并**拆掉 volatile 包装**。
   *
   * schemastery 的 `.volatile()` 不只是打个标记：解析结果里该字段是一个
   * `{ get(), [volatile.write]() }` 访问器对象，不是原始值。直接写
   * `config.skillsReading !== false` 永远为真 —— 关掉开关也关不掉。
   * DSH 自己也是先 `isVolatile(value)` 再 `value.get()`（见 dsh-settings 的
   * `plainConfig`），这里照做。
   *
   * @param key - 配置字段名。
   * @returns 原始值；没有该字段时为 undefined。
   */
  const readConfig = <K extends keyof Config>(key: K): Config[K] => {
    const raw = config?.[key] as unknown;
    if (isVolatile(raw as never)) {
      try {
        return (raw as { get: () => Config[K] }).get();
      } catch {
        return undefined;
      }
    }
    return raw as Config[K];
  };

  /**
   * 读 profile 里**已经落盘**的配置值（本插件这一行）。
   *
   * 为什么需要它：`readConfig()` 读的是运行中 fiber 的值，而 volatile 字段要等
   * `loader._commitVolatile()` 才跟上，存在一个短窗口 —— 刚保存完立刻读，
   * 可能还是旧值（表现为「第一次保存被还原，第二次才生效」）。
   * `configEditor.configuration()` 读的是补丁文件本身，写盘成功即成立。
   *
   * @returns 落盘值；没有该服务或没有这一行时返回 null。
   */
  const storedConfig = (): Record<string, unknown> | null => {
    const editor = configEditorNow();
    if (typeof editor?.configuration !== 'function') return null;
    try {
      const rows = editor.configuration();
      const row = rows.find((item) => item.entry?.options?.id === ENTRY_ID);
      if (row === undefined) return null;
      // 覆盖层优先；它不存在时退回继承层（profile bundle 的默认值）。
      const override = row.override;
      return typeof override === 'object' && override !== null ? override : null;
    } catch {
      return null;
    }
  };

  /**
   * 取一个配置项：**落盘值优先，其次运行中值，最后默认值**。
   *
   * @param key - 字段名。
   * @returns 生效值。
   */
  const effective = <K extends keyof Config>(key: K): Config[K] => {
    const stored = storedConfig();
    if (stored !== null && Object.hasOwn(stored, key as string)) {
      return stored[key as string] as Config[K];
    }
    return readConfig(key);
  };

  const maxRead = () => effective('maxReadBytes') ?? 8 * 1024 * 1024;
  const maxWrite = () => effective('maxWriteBytes') ?? 8 * 1024 * 1024;

  // 技能路由要用的两个官方服务。都按「最小面」收窄并允许缺失：
  // 精简 profile 没挂 skill 注册表时，「技能」入口只显示一句可读提示，
  // 笔记本身的读写不受任何影响。
  //
  // 同样「现取」：apply 可能比 skill 插件先执行，那时 `ctx.get('skills')` 还是空的，
  // 一次取值定终身会让技能列表永远报「没有注册表」。
  const optionalNow = (name: 'skills' | 'sessions'): unknown =>
    optional.resolveOptional === undefined ? optional[name] : optional.resolveOptional(name);
  const skillRegistryNow = (): SkillRegistryFacade | null =>
    (optionalNow('skills') ?? null) as SkillRegistryFacade | null;
  const sessionRegistryNow = (): SessionRegistryFacade | null =>
    (optionalNow('sessions') ?? null) as SessionRegistryFacade | null;

  /**
   * 取配置写回通道。
   *
   * DSH 的插件配置**没有**「插件自己写配置」的公开接口；唯一正规路径是
   * `ctx.configEditor.edit(entry, change)` —— 它把新值合并进 profile 的
   * cordis.patch.yml，再由 Loader 走 `internal/config` 重新解析。这样写进去的
   * 值重启后仍在，也仍然受「只能改 volatile 字段」的校验约束。
   *
   * @returns 通道；精简部署没有该服务时为 null。
   */
  const configEditorNow = (): ConfigEditorFacade | null =>
    ((optional.resolveOptional === undefined ? optional.configEditor : optional.resolveOptional('configEditor')) ??
      null) as ConfigEditorFacade | null;

  /** 技能阅读总开关：关掉后两条技能路由都返回 404（入口本身也不会出现）。 */
  const skillsReading = (): boolean => effective('skillsReading') !== false;
  /** 额外的技能根目录。 */
  const skillRoots = (): string[] => {
    const roots = effective('skillRoots');
    return Array.isArray(roots) ? roots : [];
  };

  /**
   * 内置技能正文的 token 表：token → { name, cwd, at }。
   *
   * 每次列技能都重发一遍，只保留最近一次列出的那批（换掉 token 表而不是往里
   * 追加，避免无限增长）；30 分钟还会整体过期，重启后自然清空。
   */
  let skillTokens = new Map<string, { name: string; cwd: string; at: number }>();
  const SKILL_TOKEN_TTL_MS = 30 * 60 * 1000;

  /** 围栏 + 方法校验。 */
  const guard = (req: RouteRequest, res: RouteResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' });
      return false;
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method ?? ''}` });
      return false;
    }
    return true;
  };

  /** 统一的错误出口：HttpError 用自带状态码，其余一律 500。 */
  const fail = (res: RouteResponse, error: unknown): void => {
    if (error instanceof HttpError) {
      writeJson(res, error.status, { error: error.message });
      return;
    }
    logger.warn(error);
    writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  };

  /** 取查询参数。 */
  const query = (req: RouteRequest, key: string): string | undefined => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const value = url.searchParams.get(key);
      return value === null ? undefined : value;
    } catch {
      return undefined;
    }
  };

  /**
   * 取一个可重复的查询参数（`?roots=a&roots=b`，也接受逗号分隔）。
   *
   * 用于把「已打开文件所属的根」随请求带上来。空值与空串一律忽略。
   */
  const queryList = (req: RouteRequest, key: string): string[] => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      return url.searchParams
        .getAll(key)
        .flatMap((value) => value.split(','))
        .map((value) => value.trim())
        .filter((value) => value !== '');
    } catch {
      return [];
    }
  };

  return [
    // ---- 列出目录：文件树的一次展开 ----
    {
      kind: 'exact',
      path: ROUTES.list,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        try {
          const path = query(req, 'path');
          const root = query(req, 'root');
          if (path === undefined || root === undefined) {
            throw new HttpError(400, 'expected ?path=<abs>&root=<abs>');
          }
          const { target } = resolveInsideRoot(path, root);

          const info = await stat(target);
          if (!info.isDirectory()) throw new HttpError(400, 'not a directory');

          const entries = await listDirectory(target);
          writeJson(res, 200, { path: target, root, entries });
        } catch (error) {
          fail(res, error);
        }
      },
    },

    // ---- 读取文件 ----
    {
      kind: 'exact',
      path: ROUTES.read,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        try {
          const path = query(req, 'path');
          const root = query(req, 'root');
          if (path === undefined || root === undefined) {
            throw new HttpError(400, 'expected ?path=<abs>&root=<abs>');
          }
          // `roots` 是「已被打开过的文件所属的根」：切过文件夹之后，旧 tab 与
          // 置顶仍然要能读。客户端把它的根一起报上来，这里只把它们当成**额外的
          // 允许范围**，不会扩大成「任意路径可读」。
          const extraRoots = queryList(req, 'roots');
          const { target } = resolveInsideAnyRoot(path, [root, ...extraRoots]);

          const info = await stat(target);
          if (!info.isFile()) throw new HttpError(400, 'not a regular file');
          const limit = maxRead();
          if (info.size > limit) {
            throw new HttpError(413, `file exceeds ${limit} bytes`);
          }

          const content = await readFile(target, 'utf8');
          writeJson(res, 200, {
            path: target,
            content,
            size: info.size,
            mtimeMs: info.mtimeMs,
          });
        } catch (error) {
          fail(res, error);
        }
      },
    },

    // ---- 写入文件（覆盖保存）----
    {
      kind: 'exact',
      path: ROUTES.write,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        try {
          const limit = maxWrite();
          const body = await readJsonBody(req, limit + 64 * 1024);
          if (body === null) throw new HttpError(400, 'invalid JSON body');

          const { path, root, content, roots } = body as {
            path?: unknown;
            root?: unknown;
            content?: unknown;
            /** 额外的允许根（已打开文件所属的文件夹）。 */
            roots?: unknown;
          };
          if (typeof content !== 'string') throw new HttpError(400, 'content must be a string');
          if (Buffer.byteLength(content, 'utf8') > limit) {
            throw new HttpError(413, `content exceeds ${limit} bytes`);
          }

          // 与 read 同一套规则：额外根只来自「已打开的文件」，用于切根后仍能保存。
          const extraRoots = Array.isArray(roots) ? roots.filter((r): r is string => typeof r === 'string') : [];
          const { target } = resolveInsideAnyRoot(String(path ?? ''), [String(root ?? ''), ...extraRoots]);

          const info = await stat(target);
          if (!info.isFile()) throw new HttpError(400, 'not a regular file');
          if (!isTextFile(target)) throw new HttpError(415, 'not a text file');

          await atomicWrite(target, content);
          const after = await stat(target);
          writeJson(res, 200, { ok: true, path: target, size: after.size, mtimeMs: after.mtimeMs });
        } catch (error) {
          fail(res, error);
        }
      },
    },

    // ---- 新建文件 ----
    {
      kind: 'exact',
      path: ROUTES.create,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        try {
          const limit = maxWrite();
          const body = await readJsonBody(req, limit + 64 * 1024);
          if (body === null) throw new HttpError(400, 'invalid JSON body');

          const { root, name, content } = body as {
            root?: unknown;
            name?: unknown;
            content?: unknown;
          };
          if (typeof name !== 'string' || name.trim() === '') {
            throw new HttpError(400, 'name is required');
          }
          // 只允许单层文件名，杜绝用 name 里塞路径。
          if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
            throw new HttpError(400, 'name must not contain path separators');
          }

          const rootDir = normalize(resolve(String(root ?? '')));
          const target = join(rootDir, name.trim());

          // 目标必须仍在 root 内（防止 name 是 '..' 之类）。
          resolveInsideRoot(target, rootDir);

          const ext = extname(target).toLowerCase();
          if (ext !== '.md' && ext !== '.markdown' && ext !== '.txt') {
            throw new HttpError(400, 'only .md and .txt may be created');
          }

          // 已存在则不覆盖，返回 409 让客户端换名字。
          try {
            await stat(target);
            throw new HttpError(409, `file already exists: ${name.trim()}`);
          } catch (error) {
            if (error instanceof HttpError) throw error;
            // stat 失败即不存在，继续创建。
          }

          const text = typeof content === 'string' ? content : '';
          if (Buffer.byteLength(text, 'utf8') > limit) {
            throw new HttpError(413, `content exceeds ${limit} bytes`);
          }

          await mkdir(rootDir, { recursive: true });
          await writeFile(target, text, { encoding: 'utf8', flag: 'wx' });

          writeJson(res, 200, { ok: true, path: target, name: name.trim() });
        } catch (error) {
          fail(res, error);
        }
      },
    },

    // ---- 删除文件（移入同目录 .trash，可恢复）----
    {
      kind: 'exact',
      path: ROUTES.remove,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        try {
          // 平台不支持可还原的删除时直接拒绝：客户端已隐藏入口，这里再挡一道，
          // 避免直接调接口在 Windows 上删出无法恢复的文件。
          if (!CAN_DELETE) throw new HttpError(403, 'deleting files is not supported on this platform');

          const body = await readJsonBody(req, 64 * 1024);
          if (body === null) throw new HttpError(400, 'invalid JSON body');

          const { path, root } = body as { path?: unknown; root?: unknown };
          const { target, root: rootDir } = resolveInsideRoot(
            String(path ?? ''),
            String(root ?? ''),
          );

          // 只允许删普通文件：目录删除涉及递归与大量误删风险，暂不开放。
          const info = await stat(target);
          if (!info.isFile()) throw new HttpError(400, 'not a regular file');

          const result = await moveToTrash(target, rootDir);
          writeJson(res, 200, { ok: true, moved: result.moved, fallback: result.fallback });
        } catch (error) {
          fail(res, error);
        }
      },
    },

    // ---- 移动文件/目录到另一个目录（拖拽）----
    {
      kind: 'exact',
      path: ROUTES.move,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        try {
          const body = await readJsonBody(req, 64 * 1024);
          if (body === null) throw new HttpError(400, 'invalid JSON body');

          const { path, to, root } = body as { path?: unknown; to?: unknown; root?: unknown };
          const rootDir = String(root ?? '');

          // 源和目标都必须落在同一个根目录内，避免把文件拖到浏览范围之外。
          const { target: source } = resolveInsideRoot(String(path ?? ''), rootDir);
          const { target: destDir } = resolveInsideRoot(String(to ?? ''), rootDir);

          const moved = await movePath(source, destDir);
          writeJson(res, 200, { ok: true, from: source, to: moved });
        } catch (error) {
          fail(res, error);
        }
      },
    },

    // ---- 健康检查 ----
    {
      kind: 'exact',
      path: ROUTES.health,
      handler: (req, res) => {
        if (!guard(req, res, 'GET')) return;
        // canDelete 让客户端据此隐藏删除入口；服务端在删除路由里另有一道校验。
        // platform 供客户端选择跟随平台的文案（如「在访达中打开」/「打开文件所在位置」）。
        // localInstall 告诉插件页的更新控件：当前是本地链接安装（更新会替换链接）。
        writeJson(res, 200, {
          ok: true,
          plugin: 'notes',
          home: homedir(),
          canDelete: CAN_DELETE,
          platform: process.platform,
          localInstall: LOCAL_INSTALL,
          // 技能阅读开关：客户端据此决定是否显示入口（服务端另有一道 404 校验）。
          // 现读而不是快照 —— 用户在插件页一关，这个值立刻反映出来。
          skillsReading: skillsReading(),
        });
      },
    },

    // ---- 查 npm 上的最新版本（插件页「检查更新」用）----
    {
      kind: 'exact',
      path: ROUTES.latestVersion,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        try {
          const fresh = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('fresh') === '1';
          const result = await latestPublishedVersion(logger, fresh);
          writeJson(res, 200, { ok: true, ...result });
        } catch (error) {
          fail(res, error);
        }
      },
    },

    // ---- 读 / 写本插件的配置（插件页的「笔记设置」用）----
    //
    // 为什么不走 DSH 的 settings 表单：那套要求插件在客户端持有 `configForms`
    // 服务，并且依赖 `SettingsFormModel` 的内部约定；官方 `dsh-workbuddy-connect`
    // 的做法更稳 —— 配置页自己画，值走插件自己的 HTTP 路由。我们本来就有
    // 一套路由体系（含 loopback 围栏），复用它是改动最小、耦合最低的路。
    {
      kind: 'exact',
      path: ROUTES.config,
      handler: async (req, res) => {
        if (!guard(req, res, req.method === 'POST' ? 'POST' : 'GET')) return;

        // GET：把当前生效值读给界面。全部是布尔/数字/字符串数组，可安全外发。
        if (req.method !== 'POST') {
          writeJson(res, 200, {
            ok: true,
            values: {
              skillsReading: skillsReading(),
              skillRoots: skillRoots(),
              maxReadBytes: maxRead(),
              maxWriteBytes: maxWrite(),
            },
            // 能不能写：没有 configEditor 就只能读（精简部署/未来版本变化）。
            writable: configEditorNow() !== null,
          });
          return;
        }

        // POST：改一个字段，写进 profile 的 cordis.patch.yml。
        try {
          const body = await readJsonBody(req, 64 * 1024);
          if (body === null) throw new HttpError(400, 'invalid JSON body');
          const patch = body as { values?: unknown };
          const values = patch.values;
          if (typeof values !== 'object' || values === null) {
            throw new HttpError(400, 'expected { values: { ... } }');
          }

          // 逐项校验：只认本插件 schema 里的四个字段，类型不对就整单拒绝。
          const next: Record<string, unknown> = {};
          for (const [key, raw] of Object.entries(values as Record<string, unknown>)) {
            if (key === 'skillsReading') {
              if (typeof raw !== 'boolean') throw new HttpError(400, 'skillsReading must be a boolean');
              next.skillsReading = raw;
            } else if (key === 'skillRoots') {
              if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
                throw new HttpError(400, 'skillRoots must be an array of strings');
              }
              next.skillRoots = raw;
            } else if (key === 'maxReadBytes' || key === 'maxWriteBytes') {
              if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
                throw new HttpError(400, `${key} must be a positive number`);
              }
              next[key] = raw;
            } else {
              throw new HttpError(400, `unknown config field: ${key}`);
            }
          }
          if (Object.keys(next).length === 0) throw new HttpError(400, 'no values to write');

          const editor = configEditorNow();
          if (editor === null || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
            throw new HttpError(501, '当前部署不支持从界面修改插件配置');
          }

          // 找到本插件这一行：DSH 的 profile 行 id 就是 cordis.patch.yml 里的 id。
          const entry = (editor.entries() as { options?: { id?: string } }[]).find(
            (row) => row.options?.id === ENTRY_ID,
          );
          if (entry === undefined) throw new HttpError(409, `没有找到插件条目 ${ENTRY_ID}`);

          /** 本次写进去的完整配置（在 change 回调里算出来，用于回给客户端）。 */
          let written: Record<string, unknown> = {};
          await editor.edit(entry, (current) => {
            const base =
              typeof current === 'object' && current !== null ? { ...(current as Record<string, unknown>) } : {};
            written = { ...base, ...next };
            return written;
          });

          /*
           * 回给客户端的必须是**刚写进去的值**，不是「现读一次」。
           *
           * 原因：`.volatile()` 字段的生效路径是
           *   edit() → 写 profile 补丁 → reconcile → loader._commitVolatile()
           *   把新值 updateVolatile 进运行中 fiber 的 ref
           * 这条链是异步的，`edit()` 返回不代表 ref 已经换新。此时去读
           * `skillsReading()` 拿到的还是旧值，客户端拿它刷新界面，就表现为
           * 「第一次保存被还原成保存前的状态，第二次才生效」。
           *
           * 写盘成功 = 值已经成立（重启后读到的就是它），所以直接回写进去的
           * 值；volatile ref 会在随后几毫秒内自己跟上。
           */
          writeJson(res, 200, {
            ok: true,
            values: {
              skillsReading: written.skillsReading !== false,
              skillRoots: Array.isArray(written.skillRoots) ? written.skillRoots : [],
              maxReadBytes: typeof written.maxReadBytes === 'number' ? written.maxReadBytes : maxRead(),
              maxWriteBytes: typeof written.maxWriteBytes === 'number' ? written.maxWriteBytes : maxWrite(),
            },
          });
        } catch (error) {
          fail(res, error);
        }
      },
    },

    // ---- 列出技能（只读；数据来自 DSH 官方 skill 注册表）----
    {
      kind: 'exact',
      path: ROUTES.skills,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        if (!skillsReading()) {
          writeJson(res, 404, { error: '技能阅读已在插件配置中关闭' });
          return;
        }
        try {
          // 只读接口、不碰任何磁盘路径参数，因此不需要 root 围栏：
          // 它不读用户指定的文件，只回报注册表已经裁决好的那份目录。
          const result = await listSkills(skillRegistryNow(), sessionRegistryNow(), skillRoots());
          // 重新发一批 token：**整表替换**（不是追加），所以刷新列表后旧 token 立即作废。
          // 追加看起来「更宽容」，但会让 token 表随刷新无限增长，也失去了
          // 「token 只代表我最近看到的那份清单」这个语义。
          const now = Date.now();
          const next = new Map<string, { name: string; cwd: string; at: number }>();
          for (const [token, name] of Object.entries(result.inline)) {
            next.set(token, { name, cwd: result.cwd, at: now });
          }
          skillTokens = next;
          writeJson(res, 200, { ok: true, ...result });
        } catch (error) {
          fail(res, error);
        }
      },
    },

    // ---- 读一个技能文件（不改文件夹、不依赖用户选中的根）----
    {
      kind: 'exact',
      path: ROUTES.readSkillFile,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        if (!skillsReading()) {
          writeJson(res, 404, { error: '技能阅读已在插件配置中关闭' });
          return;
        }
        try {
          const raw = query(req, 'path');
          if (raw === undefined || raw === '') throw new HttpError(400, 'expected ?path=<abs>');

          // 这里**没有**用户选的根目录可用 —— 技能不在笔记目录里。
          // 所以围栏换成「必须在技能根目录之内」：只允许读 DSH 约定的那几个
          // 技能位置（以及配置里追加的），其余一律 403。
          const cwd = await resolveSessionCwd(sessionRegistryNow());
          const roots = await skillRootsFor(cwd, skillRoots());
          const rootPaths = roots.map((root) => resolve(root.path));
          const target = resolve(raw);
          // 围栏与技能目录树共用一份实现，两处松紧必然一致。
          if (insideAnyRoot(normalize(target), rootPaths) === null) {
            throw new HttpError(403, 'path is outside the skill roots');
          }

          const info = await stat(target);
          if (!info.isFile()) throw new HttpError(400, 'not a regular file');
          const limit = maxRead();
          if (info.size > limit) throw new HttpError(413, `file exceeds ${limit} bytes`);

          writeJson(res, 200, {
            path: target,
            content: await readFile(target, 'utf8'),
            size: info.size,
            mtimeMs: info.mtimeMs,
          });
        } catch (error) {
          fail(res, error);
        }
      },
    },

    // ---- 列一个技能目录下的文件（技能常把正文拆进 rules/、references/ 等子目录）----
    {
      kind: 'exact',
      path: ROUTES.skillTree,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        if (!skillsReading()) {
          writeJson(res, 404, { error: '技能阅读已在插件配置中关闭' });
          return;
        }
        try {
          const raw = query(req, 'path');
          if (raw === undefined || raw === '') throw new HttpError(400, 'expected ?path=<abs>');

          // 同 read-skill-file：没有用户选的根可用，围栏是「必须在技能根之内」。
          const cwd = await resolveSessionCwd(sessionRegistryNow());
          const roots = await skillRootsFor(cwd, skillRoots());
          const tree = await listSkillTree(
            raw,
            roots.map((root) => resolve(root.path)),
          );
          writeJson(res, 200, tree);
        } catch (error) {
          fail(res, error);
        }
      },
    },

    // ---- 读一条「没有文件」的内置技能的正文 ----
    {
      kind: 'exact',
      path: ROUTES.skillContent,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        if (!skillsReading()) {
          writeJson(res, 404, { error: '技能阅读已在插件配置中关闭' });
          return;
        }
        try {
          const token = query(req, 'token');
          if (token === undefined || token === '') {
            throw new HttpError(400, 'expected ?token=<opaque>');
          }
          const entry = skillTokens.get(token);
          if (entry === undefined || Date.now() - entry.at > SKILL_TOKEN_TTL_MS) {
            // 过期或没发过：让客户端重新列一次技能（那里会发新 token）。
            throw new HttpError(410, '技能清单已过期，请重新打开技能页');
          }
          const registry = skillRegistryNow();
          if (registry === null || typeof registry.get !== 'function') {
            throw new HttpError(501, '当前环境不支持读取内置技能正文');
          }

          // 名字只从 token 表里取，不接受客户端直接给技能名 —— 否则这个接口就成了
          // 「按名字读任意技能」的通用入口。cwd 也沿用列表时那次的，保证看到的
          // 与列表里的同一条技能。
          const skill = await registry.get(entry.name, { cwd: entry.cwd });
          if (skill === undefined || skill === null) {
            throw new HttpError(404, `技能 ${entry.name} 已经不存在了`);
          }
          writeJson(res, 200, {
            ok: true,
            name: entry.name,
            content: typeof skill.content === 'string' ? skill.content : '',
          });
        } catch (error) {
          fail(res, error);
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/** 插件运行期用到的宿主上下文（只声明本插件真正调用的成员）。 */
export interface PluginContext {
  /** 浏览器 HTTP 载体：注册命名路由。 */
  webServer: { register(route: Route): () => void };
  /** 宿主日志。 */
  logger: Logger;
  /**
   * cordis 副作用注册：回调立即执行，其返回值作为释放函数在插件卸载时调用。
   * @param callback - 返回释放函数的副作用体。
   * @param label - 便于排查的标签。
   */
  effect(callback: () => () => void, label?: string): void;
  /**
   * 可选服务读取（cordis 的 `ctx.get`，**不经过 inject 服务门控**）。
   *
   * 「技能」入口要用官方的 skill 注册表与会话表，但它们刻意**没写进 `inject`**：
   * inject 是加载期硬依赖，声明了就会等那个服务出现才开始加载本插件 —— 万一某个
   * DSH 版本或精简 profile 没有 skill 插件，整个笔记功能都会跟着加载不了。
   * 改用可选读取：拿不到就只有技能入口显示一句提示，笔记读写完全照常。
   */
  get?(name: string): unknown;
}

/**
 * 挂载笔记插件的文件路由。
 * @param ctx - 宿主插件上下文，携带 webServer。
 * @param config - 已解析的插件配置。
 */
export function apply(ctx: PluginContext, config?: Config): void {
  // 不再看 config.enabled：启停统一由 DSH 插件页的「启用 / 禁用」负责
  // （它会把整个插件卸载，比我们的开关更彻底）。

  /** 可选服务读取：拿不到（或查找本身抛错）就当作没有。 */
  const optionalService = (name: string): unknown => {
    if (typeof ctx.get !== 'function') return undefined;
    try {
      return ctx.get(name);
    } catch {
      return undefined;
    }
  };

  const routes = makeRoutes(ctx.logger, config ?? {}, {
    // 每次用到时现取：这些服务可能比本插件晚就绪，也不该被 apply 时序定死。
    // 配置写回通道 `configEditor` 也走这条路 —— 它由 dsh-config-editor 提供。
    resolveOptional: optionalService,
  });
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'notes: routes');
}

/**
 * 把配置 schema 挂到 `apply` 上。
 *
 * DSH 的设置框架从 `entry.fiber.runtime.Config` 读 schema 来生成插件页表单
 * （`dsh-settings` 的 `schema(entry)`：`'toJSON' in schema` 才算数）。
 * cordis 认为「带 `.Config` 的函数就是一个可配置插件」，所以这样挂上去之后
 * 插件详情页会自动出现这些选项，无需任何额外注册。
 */
apply.Config = ConfigSchema;

