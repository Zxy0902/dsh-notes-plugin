/**
 * Markdown 文档的大纲（TOC）导航。
 *
 * **标题从哪来**：不从 markdown 文本里解析，而是**读渲染后的 DOM**。
 * 原因：DSH 的 `MarkdownText` 渲染标题时是
 * `createElement('h1'..'h6', { key }, ...)` —— **不加 id**，所以拿不到锚点，
 * 但标题元素就在预览容器里，`querySelectorAll` 能直接取到。
 * 读 DOM 还有个好处：代码块里的 `#` 注释、frontmatter 都不会被误判成标题，
 * 大纲与用户真正看到的渲染结果一一对应。
 *
 * **跳转**：因为元素引用就在手上，不需要 `#anchor`，直接改容器 scrollTop。
 * 不用 `scrollIntoView`：那是滚动「最近的可滚动祖先」，在嵌套布局里可能连带
 * 滚动外层页面；自己算差值是可控的。
 */

/** 一条大纲项。 */
export interface OutlineItem {
  /** 标题层级：1..6。 */
  level: number;
  /** 标题纯文本。 */
  text: string;
  /** 对应的 DOM 元素引用，用于跳转与位置判定。 */
  element: HTMLElement;
}

/** 预览区里所有可能的标题标签。 */
const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6';

/**
 * 标题进入容器顶部这个距离内，就算「正在读它」。
 *
 * 取 72px 而不是 0：读者视线通常落在屏幕上部而不是紧贴顶边，
 * 留一点余量能让高亮更贴近「我看到的这一段属于哪个标题」。
 */
const ACTIVATION_OFFSET = 72;

/** 跳转后标题距离容器顶部留出的空隙，避免正好贴边。 */
const JUMP_PADDING = 12;

/**
 * 从预览容器里提取全部标题。
 *
 * @param container - 预览滚动容器（`dsh-notes__preview`）。
 * @returns 按文档顺序排列的大纲项；没有标题时为空数组。
 */
export function extractOutline(container: HTMLElement | null): OutlineItem[] {
  if (container === null) return [];
  const items: OutlineItem[] = [];
  const nodes = container.querySelectorAll<HTMLElement>(HEADING_SELECTOR);
  nodes.forEach((element) => {
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    // 空标题（`#` 后面什么都没有）不进大纲：点了也看不出跳到了哪。
    if (text === '') return;
    const level = Number(element.tagName.slice(1));
    if (!Number.isFinite(level) || level < 1 || level > 6) return;
    items.push({ level, text, element });
  });
  return items;
}

/**
 * 算出「当前正在阅读」的大纲项下标。
 *
 * 规则：取最后一个「已经滚到容器顶部 ACTIVATION_OFFSET 以内」的标题。
 * 另外补一个特判：滚到最底部时直接高亮最后一项 —— 否则文档末尾那几段
 * 永远等不到自己的标题贴顶，大纲会一直停在中间某一项。
 *
 * @param items - 大纲项。
 * @param container - 预览滚动容器。
 * @returns 下标；没有标题时 -1。
 */
export function pickActiveIndex(
  items: readonly OutlineItem[],
  container: HTMLElement | null,
): number {
  if (items.length === 0 || container === null) return -1;

  // 到底了：最后一项就是「正在读」的。
  const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
  if (atBottom) return items.length - 1;

  const containerTop = container.getBoundingClientRect().top;
  let active = 0;
  for (let index = 0; index < items.length; index += 1) {
    const offset = items[index].element.getBoundingClientRect().top - containerTop;
    if (offset <= ACTIVATION_OFFSET) active = index;
    else break;
  }
  return active;
}

/**
 * 把某个标题滚到容器顶部。
 *
 * @param container - 预览滚动容器。
 * @param item - 目标标题。
 * @param smooth - 是否平滑滚动（用户点击时平滑，程序对齐时不要）。
 */
export function scrollToItem(
  container: HTMLElement | null,
  item: OutlineItem,
  smooth = true,
): void {
  if (container === null || !item.element.isConnected) return;
  const delta = item.element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const top = Math.max(0, container.scrollTop + delta - JUMP_PADDING);
  container.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
}
