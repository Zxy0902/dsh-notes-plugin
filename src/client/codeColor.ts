/**
 * 代码染色（语法高亮）的判定逻辑。
 *
 * 【为什么单独成文件】它要回答两个问题，且都是纯判断、不碰 React：
 * 1. **这个文件该不该染色** —— 只有「整份文件就是一段代码」的文件才染
 *    （`.sql`、`.java`、`.py`…）；Markdown 里的代码块由 `MarkdownText`
 *    自己处理，不归这里管。
 * 2. **当前该用哪种显示方式** —— 染色的打开与关闭是用户偏好，但「染了色的
 *    文件只能用预览显示」是硬约束（染色是把文本渲染成带样式的行，
 *    编辑框里没法染）。两者合成一个结果，避免界面各处各判一次。
 *
 * 依赖 `languageForPath`：那张扩展名表是 DSH 各处代码界面**共用**的同一份，
 * 用它就不会出现「这里认 .sql、那里不认」。
 *
 * 【从 primitives 取，不从 util-code-language 直接取】客户端的 bundle 只能
 * require 宿主冻结清单里的平台模块，`@deepseek-ai/dsh-util-code-language`
 * 不在清单里，直接 import 会让 bundle 加载失败。而 primitives 已经把它
 * **重导出**了（见其 code-highlighting.d.ts 的 `export { ... languageForPath }
 * from '@deepseek-ai/dsh-util-code-language'`），走这条路不新增任何依赖。
 */
import { languageForPath } from '@deepseek-ai/dsh-client-ui-primitives';

/**
 * 一个文件是否属于「整份都是代码」的类型（可以染色）。
 *
 * 判据是 DSH 的共享扩展名表收不收它。表里没有的（`.md`、`.txt`、无扩展名
 * 的 `LICENSE`）一律不染色 —— 它们要么不是代码，要么染色没有意义。
 *
 * 注意 `.md` 也在这张表之外（Markdown 不是被当作代码渲染的表面），
 * 所以 Markdown 文件永远返回 false，符合预期。
 *
 * @param path - 文件名或路径（扩展名不区分大小写）。
 * @returns 可以染色则为 true。
 */
export function isCodeFile(path: string | null): boolean {
  if (path === null || path === '') return false;
  return languageForPath(path) !== undefined;
}

/**
 * 自带色板的变量名前缀。
 *
 * shiki 的 css-variables 主题不写死颜色，它给每个 token 挂
 * `var(--shiki-token-keyword)` 这样的**引用**，真正的色值由 DSH 主题插件
 * 注入的 shiki.css 提供。问题在于：只要那个变量在运行环境里不存在，
 * CSS 的 `var()` 就会解析失败并**静默回落成继承色**（也就是正文黑），
 * 不报错、不崩溃 —— 结果就是「只有个别 token 有颜色，其余全黑」。
 *
 * 这不是理论风险：实测某环境里主题表只提供了一个变量，于是 SQL 里
 * 只有反引号标识符显绿，`SELECT`/`WHERE`/字符串/数字全是黑的。
 *
 * 所以这里给每个引用补一层兜底：`var(<主题变量>, var(<自带色板>, inherit))`。
 * 主题提供了就用主题色（明暗主题照常跟随、主题改版也自动跟随），
 * 主题没提供就用自带色板。自带色板只作用于本插件自己的根类 `.dsh-notes__codecolor`，
 * 不覆盖任何全局变量，因此对 DSH 自身零影响。
 */
export const FALLBACK_VAR_PREFIX = '--dsh-notes-color-';

/** 匹配 shiki 内联出来的纯变量引用，如 `var(--shiki-token-keyword)`。 */
const SHIKI_VAR_REF = /^var\(\s*(--shiki-[a-z0-9-]+)\s*\)$/;

/**
 * 给一个 token 颜色补上兜底变量。
 *
 * - shiki 给的是 `var(--shiki-x)` → 变成
 *   `var(--shiki-x, var(--dsh-notes-color-x, inherit))`，三级回落；
 * - 已经是字面色（主题没用变量，或 shiki 换了输出方式）→ 原样返回，
 *   不插手别人的决定；
 * - 不是字符串 → 返回 undefined，让调用方忽略该属性。
 *
 * @param color - shiki 给出的 token 颜色值。
 * @returns 带兜底的 CSS 颜色值；无法处理时为 undefined。
 */
export function colorWithFallback(color: unknown): string | undefined {
  if (typeof color !== 'string') return undefined;
  const match = SHIKI_VAR_REF.exec(color.trim());
  // 不是纯变量引用：字面色照用，其余（inherit/currentColor 等）也照用。
  if (match === null) return color;
  const themeVar = match[1];
  // `--shiki-token-keyword` → `--dsh-notes-color-token-keyword`
  const ownVar = FALLBACK_VAR_PREFIX + themeVar.slice('--shiki-'.length);
  return `var(${themeVar}, var(${ownVar}, inherit))`;
}

/**
 * 取一个文件的染色语言 id。
 *
 * @param path - 文件名或路径。
 * @returns 语言 id（如 `sql`、`java`）；不可染色时为 undefined。
 */
export function languageOf(path: string | null): string | undefined {
  if (path === null || path === '') return undefined;
  return languageForPath(path);
}

/**
 * 打开一个文件时应该用哪种显示方式。
 *
 * - 染色的代码文件：只能用「预览」（渲染结果才带颜色），
 *   所以返回 `preview`；
 * - `.md`：沿用用户记住的偏好（`mdViewMode`）；
 * - 其余（`.txt` 等）：单栏编辑。
 *
 * 【为什么染色时强制 preview】染色是把文本按 token 拆成带颜色的行，
 * 那是「渲染」而不是「编辑」。编辑框里只能有纯文本，所以一旦开了染色，
 * 就没有「边改边看」这个选项 —— 必须切到预览。这不是偷懒，是染色本身的
 * 形状决定的。
 *
 * @param kind - tab 类型。
 * @param path - 文件路径。
 * @param highlightOn - 用户是否开启了代码染色。
 * @param mdViewMode - 用户记住的 Markdown 默认显示方式。
 * @returns 初始显示方式。
 */
export function defaultViewMode(
  kind: 'md' | 'txt' | 'external' | 'skills' | 'global',
  _path: string | null,
  mdViewMode: 'split' | 'edit' | 'preview',
): 'split' | 'edit' | 'preview' {
  if (kind === 'global') return 'split';
  if (kind === 'md') return mdViewMode;
  // 非 md 的代码文件（.sql/.java/...）永远用「编辑」这一种显示方式：
  // 染色不再是另一种显示方式，而是叠在编辑框上的一层着色（见 EditorPane），
  // 所以开不开染色都能继续编辑，显示方式不需要跟着变。
  return 'edit';
}
