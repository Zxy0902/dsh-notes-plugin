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

/** cordis 插件名（稳定标识）。 */
export const name = 'notes';

/** 路由挂载前需要就绪的服务。 */
export const inject = ['webServer'];

/** 插件配置。 */
export interface Config {
  /** 关掉后插件完全不注册路由。 */
  enabled?: boolean;
  /** 单文件读取上限（字节），默认 8 MiB。 */
  maxReadBytes?: number;
  /** 单文件写入上限（字节），默认 8 MiB。 */
  maxWriteBytes?: number;
}

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
export const ROUTES = {
  list: '/api/dsh-notes/list',
  read: '/api/dsh-notes/read',
  write: '/api/dsh-notes/write',
  create: '/api/dsh-notes/create',
  remove: '/api/dsh-notes/remove',
  move: '/api/dsh-notes/move',
  health: '/api/dsh-notes/health',
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
 * @returns 路由列表。
 */
export function makeRoutes(logger: Logger, config: Config = {}): Route[] {
  const maxReadBytes = config.maxReadBytes ?? 8 * 1024 * 1024;
  const maxWriteBytes = config.maxWriteBytes ?? 8 * 1024 * 1024;

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
          const { target } = resolveInsideRoot(path, root);

          const info = await stat(target);
          if (!info.isFile()) throw new HttpError(400, 'not a regular file');
          if (info.size > maxReadBytes) {
            throw new HttpError(413, `file exceeds ${maxReadBytes} bytes`);
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
          const body = await readJsonBody(req, maxWriteBytes + 64 * 1024);
          if (body === null) throw new HttpError(400, 'invalid JSON body');

          const { path, root, content } = body as {
            path?: unknown;
            root?: unknown;
            content?: unknown;
          };
          if (typeof content !== 'string') throw new HttpError(400, 'content must be a string');
          if (Buffer.byteLength(content, 'utf8') > maxWriteBytes) {
            throw new HttpError(413, `content exceeds ${maxWriteBytes} bytes`);
          }

          const { target } = resolveInsideRoot(String(path ?? ''), String(root ?? ''));

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
          const body = await readJsonBody(req, maxWriteBytes + 64 * 1024);
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
          if (Buffer.byteLength(text, 'utf8') > maxWriteBytes) {
            throw new HttpError(413, `content exceeds ${maxWriteBytes} bytes`);
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
        });
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
}

/**
 * 挂载笔记插件的文件路由。
 * @param ctx - 宿主插件上下文，携带 webServer。
 * @param config - 已解析的插件配置。
 */
export function apply(ctx: PluginContext, config?: Config): void {
  if (config?.enabled === false) return;

  const routes = makeRoutes(ctx.logger, config ?? {});
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'notes: routes');
}
