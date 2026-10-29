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
