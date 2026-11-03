/**
 * 编辑栏的 Tab 键处理（缩进 / 反缩进）。
 *
 * 【为什么要单独做】textarea 里的 Tab 默认是「把焦点移到下一个控件」，
 * 在笔记面板里表现为：按一下 Tab，编辑光标不见了，DSH 整个界面的焦点被
 * 挪到别的按钮上 —— 想继续写，得再点一次编辑框。对写 Markdown 的人来说，
 * Tab 应该是**缩进**（列表嵌套、代码块缩进），焦点不该乱跑。
 *
 * 这里的规则：
 * - Tab：在光标处插入一个制表符（有多行选中时改为给每行行首加缩进）；
 * - Shift+Tab：给当前行 / 选中行去掉一级缩进。
 *
 * 纯函数，不依赖 React：输入原文与选区，输出新文本与新的选区。
 */

/** 一次编辑的结果。 */
export interface EditResult {
  /** 编辑后的完整文本。 */
  text: string;
  /** 编辑后光标起点。 */
  start: number;
  /** 编辑后选区终点（等于 start 表示没有选中任何文本）。 */
  end: number;
}

/** 缩进一个字符：制表符。 */
const INDENT = '\t';

/**
 * 找到某个位置所在行的行首偏移。
 *
 * @param text - 全文。
 * @param pos - 位置。
 * @returns 该行行首的下标。
 */
function lineStartAt(text: string, pos: number): number {
  const index = text.lastIndexOf('\n', pos - 1);
  return index === -1 ? 0 : index + 1;
}

/**
 * 找出选区覆盖到的所有行（按行首偏移升序）。
 *
 * 两个边界约定：
 * - 选区恰好结束在某行行首时，那一行**不算**（用户没有选中它的内容）；
 * - 文本以换行符结尾时，末尾那个「多出来的空行」不算真实的一行。
 *
 * @param text - 全文。
 * @param from - 选区起点。
 * @param to - 选区终点。
 * @returns 每行的行首偏移。
 */
function affectedLines(text: string, from: number, to: number): number[] {
  const first = lineStartAt(text, from);
  // 选区尾巴正好落在换行符之后（= 下一行的行首）时，不把那一行算进来。
  const last = to > from && text[to - 1] === '\n' ? to : lineStartAt(text, to);
  if (last < first) return [];

  const lines: number[] = [];
  let cursor = first;
  while (cursor <= last) {
    // 末尾的「幻影空行」：文本以换行符结尾时，最后一个行首等于文本长度。
    if (cursor === text.length && text.endsWith('\n')) break;
    lines.push(cursor);
    const next = text.indexOf('\n', cursor);
    if (next === -1) break;
    cursor = next + 1;
  }
  return lines;
}

/**
 * 计算一行开头有多少个可被反缩进掉的字符。
 *
 * 一个制表符算一级；没有制表符时，最多去掉 4 个空格（Markdown 的列表缩进
 * 通常是 4 空格；用空格缩进的文件不该被一次 Tab 全抹平）。
 *
 * @param line - 该行内容（不含换行符）。
 * @returns 可去掉的字符数。
 */
function removableIndent(line: string): number {
  if (line.startsWith(INDENT)) return 1;
  let count = 0;
  while (count < 4 && line[count] === ' ') count += 1;
  return count;
}

/**
 * 在光标处插入缩进（有多行选中时改为逐行缩进）。
 *
 * @param text - 全文。
 * @param from - 选区起点。
 * @param to - 选区终点。
 * @returns 编辑结果。
 */
export function indent(text: string, from: number, to: number): EditResult {
  // 单行、无选中：直接在光标处插入制表符。多数编辑器都是这个行为。
  if (from === to) {
    const next = text.slice(0, from) + INDENT + text.slice(from);
    return { text: next, start: from + 1, end: from + 1 };
  }

  const lines = affectedLines(text, from, to);
  if (lines.length === 0) {
    const next = text.slice(0, from) + INDENT + text.slice(from);
    return { text: next, start: from + 1, end: from + 1 };
  }

  // 逐行在行首加一个制表符。
  const blocks = lines.map((start) => {
    const end = text.indexOf('\n', start);
    return text.slice(start, end === -1 ? text.length : end);
  });
  const indented = blocks.map((line) => INDENT + line).join('\n');
  const first = lines[0];
  const last = lines[lines.length - 1];
  const lastEnd = (() => {
    const end = text.indexOf('\n', last);
    return end === -1 ? text.length : end;
  })();
  const next = text.slice(0, first) + indented + text.slice(lastEnd);

  // 选区两侧各按「受影响行数」平移：
  // - 起点是闭区间，落在某行行首时该行的制表符插在它前面，要算上；
  // - 终点是开区间，插在终点位置上的制表符不算（它落在选区之外）。
  const shiftStart = lines.filter((start) => start <= from).length;
  const shiftEnd = lines.filter((start) => start < to).length;
  return {
    text: next,
    start: from + shiftStart,
    end: to + shiftEnd,
  };
}

/**
 * 去掉当前行 / 选中行的缩进（反缩进）。
 *
 * @param text - 全文。
 * @param from - 选区起点。
 * @param to - 选区终点。
 * @returns 编辑结果。
 */
export function outdent(text: string, from: number, to: number): EditResult {
  const lines = affectedLines(text, from, to);
  if (lines.length === 0) {
    return { text, start: from, end: to };
  }

  const first = lines[0];
  const last = lines[lines.length - 1];
  const lastEnd = (() => {
    const end = text.indexOf('\n', last);
    return end === -1 ? text.length : end;
  })();

  // 逐行去掉行首缩进，同时记下每行去掉了几个字符。
  const removed: number[] = [];
  const kept: string[] = [];
  for (const start of lines) {
    const end = text.indexOf('\n', start);
    const line = text.slice(start, end === -1 ? text.length : end);
    const count = removableIndent(line);
    removed.push(count);
    kept.push(line.slice(count));
  }

  const next = text.slice(0, first) + kept.join('\n') + text.slice(lastEnd);

  /**
   * 计算某个位置在去掉缩进后的新位置。
   *
   * 第 i 行去掉的字符占据原文的 `[lines[i], lines[i] + removed[i])` 这一段。
   * 一个边界位置 p 只有在**整段都在它前面**时（`lines[i] + removed[i] <= p`）
   * 才需要让开 —— 因为边界落在被删掉的字符中间是不该发生的。
   */
  const shift = (position: number): number => {
    let total = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i] + removed[i] > position) break;
      total += removed[i];
    }
    return position - total;
  };

  return { text: next, start: shift(from), end: shift(to) };
}
