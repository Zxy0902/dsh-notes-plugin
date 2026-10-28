/**
 * 大纲栏的 React 外壳：提取、滚动高亮、跳转。
 *
 * 纯逻辑（提取 / 高亮判定 / 跳转）在 `Outline.ts`，这里只负责把它们接到
 * React 生命周期上。分开的好处是那三条规则可以脱开 DOM 环境单独测。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  extractOutline,
  pickActiveIndex,
  scrollToItem,
  type OutlineItem,
} from './Outline';

/** `useOutline` 的返回值。 */
export interface OutlineState {
  /** 提取到的标题。 */
  items: OutlineItem[];
  /** 当前正在阅读的那一项下标（-1 表示未认定）。 */
  activeIndex: number;
  /** 跳到某一项。 */
  jumpTo: (item: OutlineItem) => void;
}

/**
 * 跟踪预览区的大纲与阅读位置。
 *
 * @param previewRef - 预览滚动容器。
 * @param revision - 内容版本（通常是文档文本）：变化即重新提取标题。
 * @param enabled - 是否启用（非 markdown、编辑模式、大纲收起时都传 false）。
 * @returns 大纲项、当前高亮下标与跳转函数。
 */
export function useOutline(
  previewRef: React.RefObject<HTMLDivElement>,
  revision: unknown,
  enabled: boolean,
): OutlineState {
  const [items, setItems] = useState<OutlineItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);

  /**
   * 重新提取标题。
   *
   * 等一帧再取：`MarkdownText` 是 memo 组件，React 提交之后 DOM 才是新的；
   * 在 effect 里同步 query 有可能拿到上一次渲染的节点。
   */
  useEffect(() => {
    if (!enabled) {
      setItems([]);
      setActiveIndex(-1);
      return undefined;
    }
    const container = previewRef.current;
    if (container === null) {
      setItems([]);
      return undefined;
    }
    const frame = requestAnimationFrame(() => {
      const next = extractOutline(container);
      setItems(next);
      setActiveIndex(pickActiveIndex(next, container));
    });
    return () => cancelAnimationFrame(frame);
  }, [previewRef, revision, enabled]);

  /** 滚动时更新高亮。与分栏同步滚动共存：各挂各的监听，互不干扰。 */
  useEffect(() => {
    if (!enabled || items.length === 0) return undefined;
    const container = previewRef.current;
    if (container === null) return undefined;

    let frame = 0;
    const sync = (): void => {
      // 滚动事件很密，合并到一帧里算，避免每像素都碰一次布局。
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setActiveIndex(pickActiveIndex(items, container));
      });
    };
    container.addEventListener('scroll', sync, { passive: true });
    // 也跟随尺寸变化（窗口变高、切换模式）重新判定一次。
    const observer = new ResizeObserver(sync);
    observer.observe(container);

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      container.removeEventListener('scroll', sync);
      observer.disconnect();
    };
  }, [items, enabled, previewRef]);

  const jumpTo = useCallback(
    (item: OutlineItem) => {
      scrollToItem(previewRef.current, item, true);
    },
    [previewRef],
  );

  return { items, activeIndex, jumpTo };
}

/** 大纲栏属性。 */
export interface OutlinePaneProps {
  items: readonly OutlineItem[];
  activeIndex: number;
  onJump: (item: OutlineItem) => void;
}

/**
 * 右侧大纲栏。
 *
 * 缩进按层级递进，但**每级只给 8px**：Markdown 常见到 h4/h5，按 16px 累加
 * 时深层标题会被推到很右边、文字只剩几个字。栏宽本身只有 216px，缩进上
 * 每省一个像素都能多放半个汉字。
 *
 * @param props - 大纲项、当前高亮与跳转回调。
 * @returns 大纲栏。
 */
export function OutlinePane({ items, activeIndex, onJump }: OutlinePaneProps): JSX.Element {
  return (
    <nav className="dsh-notes__outline" aria-label="文档大纲">
      <div className="dsh-notes__outline-head">大纲</div>
      <ul className="dsh-notes__outline-list">
        {items.map((item, index) => (
          <li key={`${item.level}-${index}-${item.text}`}>
            <button
              type="button"
              className={`dsh-notes__outline-item${index === activeIndex ? ' dsh-notes__outline-item--active' : ''}`}
              style={{ paddingLeft: 8 + (item.level - 1) * 8 }}
              // 深层标题字号略小，视觉上一眼能分出层级
              data-level={item.level}
              title={item.text}
              aria-current={index === activeIndex ? 'true' : undefined}
              onClick={() => onJump(item)}
            >
              <span className="dsh-notes__outline-text">{item.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
