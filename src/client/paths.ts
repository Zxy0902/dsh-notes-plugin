/**
 * 路径与错误文案的纯函数工具。
 *
 * 为什么单独成文件：外壳（`NotesPanel`）、左栏（`SkillTreePane`）、编辑器
 * 都要用这几个函数，而它们彼此不能互相 import —— 放在任何一个组件文件里都会
 * 造成循环依赖。这里只依赖 `api.ts` 的错误类型，不碰 React、不碰 DOM。
 *
 * 全部不依赖 `node:path`：浏览器里没有它。
 */
import { NotesApiError } from './api';

/**
 * 取路径的目录部分。
 *
 * 同时识别 `/` 与 `\`：Windows 上宿主返回的是反斜杠路径，只认 `/` 会把整个
 * 路径当成文件名。无分隔符时返回空串（相对路径没有目录部分）。
 *
 * @param path - 绝对路径。
 * @returns 目录部分。
 */
export function dirnameOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i <= 0 ? '' : path.slice(0, i);
}

/**
 * 取路径的文件名部分。
 *
 * @param path - 绝对路径。
 * @returns 文件名（含扩展名）。
 */
export function basenameOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i < 0 ? path : path.slice(i + 1);
}

/**
 * 这个路径是不是「技能文件」（技能目录里的任何文件）。
 *
 * 判据刻意用**路径**而不是「是不是从技能页打开的」：
 * 同一个文件也可能从文件树直接点开、或本来就在置顶里，
 * 按来源判断会漏掉那些情况。技能目录里的文件一律不给置顶/删除入口。
 *
 * 【这里踩过坑】一开始只认文件名 `SKILL.md`，于是技能子目录里的
 * `rules/dict.md`、`scripts/x.sh` 掉进了普通文件的读取通道（`api.read`）——
 * 那条路要求路径落在用户选中的笔记文件夹之内，而技能目录在 `~/.dsh/skills`
 * 下，必然 403，表现为「子文件夹里的文件点了打不开」。技能目录下的**所有**
 * 文件都要走只读的 `readSkillFile`。
 *
 * @param path - 文件绝对路径。
 * @returns 是技能文件则为 true。
 */
export function isSkillFile(path: string): boolean {
  // 目录里带 `.dsh/skills` 或 `.agents/skills` 段，就认定是技能目录。
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/.dsh/skills/') || normalized.includes('/.agents/skills/');
}

/**
 * 把一个文件名拆成「主干」与「扩展名」。
 *
 * 重命名时要用：用户改的通常只是主干（`周会纪要`），扩展名（`.md`）要留着。
 * 点号开头的文件名（`.gitignore`）整段算主干，没有扩展名。
 *
 * @param name - 文件名。
 * @returns `{ stem, ext }`：`ext` 含前导点；没有扩展名时是空串。
 */
export function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  // 点在开头 = 隐藏文件（`.gitignore`），整段都是名字。
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * 「在系统文件管理器里定位到文件」这项菜单的文案。
 *
 * 各平台对这个动作的叫法不同（macOS 的访达、Windows 的资源管理器、Linux 各家
 * 文件管理器），用系统自己的说法，用户一眼就知道文件会出现在哪里。宿主没报
 * 平台时用通用说法兜底。
 *
 * @param platform - `process.platform`（`darwin`/`win32`/`linux`）或 null。
 * @returns 菜单文案。
 */
export function revealLabelOf(platform: string | null): string {
  if (platform === 'darwin') return '在访达中打开';
  if (platform === 'win32') return '打开文件所在位置';
  return '在文件管理器中显示';
}

/**
 * 把任意异常转成可展示的中文文案。
 *
 * @param error - 捕获到的异常。
 * @returns 面向用户的提示。
 */
export function messageOf(error: unknown): string {
  if (error instanceof NotesApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 明确不是文本的扩展名：命中就走「打开方式」提示页。
 *
 * 只在**拿不到宿主判定**时兜底用（比如从置顶区打开，那里只有路径）。
 * 有 `editable` 时一律以宿主为准 —— 那是唯一真相，客户端不重复维护白名单。
 */
const NON_TEXT_EXTENSIONS = new Set([
  // 文档与办公：容器是二进制或富文本，读进文本框只会是乱码
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.pages', '.numbers', '.key', '.odt', '.ods', '.odp', '.rtf',
  // 图片
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
  '.tif', '.tiff', '.heic', '.heif', '.psd', '.ai', '.sketch', '.fig',
  // 音视频
  '.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.opus',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.m4v',
  // 压缩包与镜像
  '.zip', '.rar', '.7z', '.gz', '.tgz', '.bz2', '.xz', '.tar', '.dmg', '.iso',
  // 可执行与库
  '.exe', '.msi', '.dll', '.so', '.dylib', '.bin', '.class', '.jar', '.war',
  '.pyc', '.o', '.a', '.lib', '.wasm',
  // 数据库与字体
  '.db', '.sqlite', '.sqlite3', '.mdb',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
]);

/**
 * 打开一个文件时该用哪种视图。
 *
 * 三种去向：
 * - `md`：Markdown，左编右渲；
 * - `txt`：文本，单栏编辑；
 * - `external`：阅读器打不开，显示「此格式无法在阅读器中打开」+「打开方式」控件，
 *   **绝不把二进制内容塞进文本框**。
 *
 * 所有「打开文件」的入口都必须经过这里，否则迟早出现某个入口（右键菜单、置顶区）
 * 把 `.xlsx` 当纯文本打开 —— 这正是 issue #1 报的问题。
 *
 * @param name - 文件名（含扩展名）。
 * @param readable - 宿主的 `editable` 判定。文件树条目一定带；只有路径、拿不到
 *   条目时（如从置顶区打开）传 undefined，此时按扩展名兜底。
 * @returns 应当使用的 tab kind。
 */
export function openKindFor(name: string, readable?: boolean): 'md' | 'txt' | 'external' {
  const lower = name.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  // 有宿主判定就以它为准：白名单在宿主那边，客户端不复制一份。
  if (readable !== undefined) return readable ? 'txt' : 'external';
  return NON_TEXT_EXTENSIONS.has(splitName(name).ext.toLowerCase()) ? 'external' : 'txt';
}
