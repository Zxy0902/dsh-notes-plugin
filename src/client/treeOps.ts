/**
 * 文件树的纯逻辑：路径祖先推导与「全部展开」的目录遍历。
 *
 * 刻意与 React / DOM 分开：这些是可以独立验证的规则（尤其跨平台路径），
 * 放在这里就能用真实实现直接跑用例，不必渲染界面。
 */

/** 目录条目（只用到树逻辑关心的字段）。 */
export interface TreeEntryLike {
  kind: string;
  path: string;
}

/** 树逻辑需要的 API 面。 */
export interface TreeApiLike {
  list(root: string, path: string): Promise<{ entries: readonly TreeEntryLike[] }>;
}

/**
 * 列出一个文件路径的所有祖先目录（从靠近根的一层往下，不含文件本身）。
 *
 * 用于「定位到当前文件」：把祖先目录逐个展开，那一层才会渲染出来。
 * 同时识别 `/` 与 `\`（Windows 宿主返回反斜杠路径），并且用**原路径自己的
 * 分隔符**拼接结果 —— 拼成另一种分隔符的话，展开集合里的路径就和树节点
 * 手里的路径对不上了，树不会展开。
 *
 * @param path - 目标文件绝对路径。
 * @param root - 当前笔记根目录。
 * @returns 祖先目录路径（root 本身不含在内）；不在 root 下时返回空数组。
 */
export function ancestorsOf(path: string, root: string): string[] {
  if (path === root || !path.startsWith(root)) return [];

  const rest = path.slice(root.length);
  /**
   * 分隔符取谁：优先看 root 之后那一个字符；若 root 本身以分隔符结尾
   * （Windows 盘根 `C:\`、POSIX 根 `/`），root 后面就直接是名字了，
   * 这时要看 root 的尾字符。两者都不是时按路径里出现过反斜杠来定。
   * 拼错分隔符的后果是展开集合里的路径与树节点手里的不一致 —— 树不会展开。
   */
  const first = rest.charAt(0);
  const rootTail = root.charAt(root.length - 1);
  const separator =
    first === '\\' || first === '/'
      ? first
      : rootTail === '\\' || rootTail === '/'
        ? rootTail
        : path.includes('\\')
          ? '\\'
          : '/';

  const parts = rest.split(/[\\/]+/).filter((part) => part !== '');
  // 最后一段是文件名本身，不是目录。
  parts.pop();

  const out: string[] = [];
  let current = root;
  for (const part of parts) {
    current = current.endsWith(separator) ? current + part : current + separator + part;
    out.push(current);
  }
  return out;
}

/**
 * 广度优先列出 root 下所有子目录（「全部展开」用）。
 *
 * 逐层调用宿主列目录，读不到的目录直接跳过（不让一个坏目录中断整次展开）。
 * 树很大时遍历会很久，因此设 `limit` 上限：达到上限即停止并标记 `truncated`，
 * 由调用处提示用户，而不是让界面长时间无响应。
 *
 * @param api - 笔记 API（只需要 list）。
 * @param root - 笔记根目录。
 * @param limit - 最多收集多少个目录。
 * @returns 目录路径列表（不含 root）与被截断标记。
 */
export async function listAllDirectories(
  api: TreeApiLike,
  root: string,
  limit: number,
): Promise<{ dirs: string[]; truncated: boolean }> {
  const dirs: string[] = [];
  const queue: string[] = [root];
  let truncated = false;

  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let listing: { entries: readonly TreeEntryLike[] };
    try {
      listing = await api.list(root, dir);
    } catch {
      // 读不到就跳过这一层，继续其它分支。
      continue;
    }

    for (const entry of listing.entries) {
      if (entry.kind !== 'directory') continue;
      if (dirs.length >= limit) {
        truncated = true;
        break;
      }
      dirs.push(entry.path);
      queue.push(entry.path);
    }

    if (truncated) break;
  }

  return { dirs, truncated };
}
