/**
 * 编辑栏与预览栏的按比例同步滚动。
 *
 * 两侧各自是独立滚动容器（textarea 与预览 div），互不知情，所以默认滚一边
 * 另一边不动。这里按「滚动条比例」互相同步：谁在滚动，谁就是主控，驱动另一方。
 *
 * 防回环的做法很关键，且不能用「记住上一次谁在驱动」这种持久标记 ——
 * 那样会把下一次真实的用户滚动也一起吞掉，表现为只有一个方向能同步。
 * 正确做法是：给「被程序写入的那一方」打一个一次性标记，写入后立刻消费掉，
 * 于是它随后派发的那个 scroll 事件被忽略，而之后所有真实滚动都照常工作。
 */
import { useCallback, useEffect, useRef } from 'react';

/** 同步钩子的返回值。 */
export interface ScrollSync {
  /** 绑定到编辑栏（textarea）的 ref。 */
  editorRef: React.RefObject<HTMLTextAreaElement>;
  /** 绑定到预览栏（可滚动 div）的 ref。 */
  previewRef: React.RefObject<HTMLDivElement>;
  /** 编辑栏的 onScroll 处理。 */
  onEditorScroll: () => void;
  /** 预览栏的 onScroll 处理。 */
  onPreviewScroll: () => void;
}

/** 元素可滚动的最大距离（0 表示不可滚动）。 */
function maxScroll(el: HTMLElement | null): number {
  if (el === null) return 0;
  return Math.max(0, el.scrollHeight - el.clientHeight);
}

/**
 * 建立两个滚动容器的按比例同步。
 *
 * @param enabled - 是否开启同步；关闭时两侧完全独立。
 * @param onEditorScrollTop - 编辑栏滚动时的回调，用于记录滚动位置做「记忆」。
 * @returns 两侧的 ref 与 scroll 处理函数。
 */
export function useScrollSync(
  enabled: boolean,
  onEditorScrollTop?: (top: number) => void,
): ScrollSync {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  /**
   * 一次性「这是程序写入」标记。下一个来自该元素的 scroll 事件将被忽略，
   * 忽略后立即清空，所以不会影响后续的真实滚动。
   */
  const echoRef = useRef<'editor' | 'preview' | null>(null);

  /** 已排队的动画帧，避免一次滚动排多帧。 */
  const rafRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    },
    [],
  );

  /**
   * 把 from 的滚动比例套到 to 上，并给 to 打上一次性回声标记。
   * @param from - 主控元素。
   * @param to - 被驱动元素。
   * @param toSide - 被驱动元素所属的一侧。
   */
  const apply = useCallback(
    (from: HTMLElement | null, to: HTMLElement | null, toSide: 'editor' | 'preview') => {
      if (from === null || to === null) return;

      const fromMax = maxScroll(from);
      const toMax = maxScroll(to);
      // 任一侧不可滚动（内容没超出）时无事可做。
      if (fromMax <= 0 || toMax <= 0) return;

      const ratio = from.scrollTop / fromMax;
      const next = ratio * toMax;

      // 差异小于 1px 就不动，避免亚像素抖动。
      if (Math.abs(to.scrollTop - next) < 1) return;

      echoRef.current = toSide;
      to.scrollTop = next;
    },
    [],
  );

  /**
   * 排一帧同步。
   * @param driver - 本次的主控方。
   */
  const schedule = useCallback(
    (driver: 'editor' | 'preview') => {
      if (!enabled) return;
      if (rafRef.current !== null) return;

      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (driver === 'editor') apply(editorRef.current, previewRef.current, 'preview');
        else apply(previewRef.current, editorRef.current, 'editor');
      });
    },
    [enabled, apply],
  );

  const onEditorScroll = useCallback(() => {
    const top = editorRef.current?.scrollTop;
    if (top !== undefined) onEditorScrollTop?.(top);

    // 这次滚动是同步程序写进去的，忽略并消费掉标记。
    if (echoRef.current === 'editor') {
      echoRef.current = null;
      return;
    }
    schedule('editor');
  }, [onEditorScrollTop, schedule]);

  const onPreviewScroll = useCallback(() => {
    if (echoRef.current === 'preview') {
      echoRef.current = null;
      return;
    }
    schedule('preview');
  }, [schedule]);

  return { editorRef, previewRef, onEditorScroll, onPreviewScroll };
}
