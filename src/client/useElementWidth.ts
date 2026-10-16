/**
 * 观察面板自身的宽度，用于窄容器下自动收起左侧文件夹栏。
 *
 * 为什么需要它：DSH 折叠左侧会话栏后，中间主面板会变宽（正常）；
 * 但反过来，当窗口本身很窄、或用户把右侧栏拉宽时，中间面板会被压得很窄。
 * 此时固定 232px 的文件夹栏会吃掉一半以上宽度，把编辑/预览挤到没法看。
 *
 * 用 ResizeObserver 而不是 window.resize：面板宽度变化不只由窗口决定
 * （右侧栏拖拽、会话栏折叠/展开都会改变它），只听 window 会漏掉这些情况。
 */
import { useEffect, useRef, useState } from 'react';

/** 宽度断点。 */
export const BREAKPOINTS = {
  /** 低于此宽度：整个左侧文件夹栏收起，只留一个展开按钮。 */
  hideSidebar: 560,
  /** 低于此宽度：左右分栏改为上下/单栏，避免两栏都窄到不可读。 */
  singleColumn: 720,
} as const;

/** useElementWidth 的返回值。 */
export interface ElementWidth {
  /** 绑定到被观察元素的 ref。 */
  ref: React.RefObject<HTMLDivElement>;
  /** 当前宽度（px）；尚未测量时为 0。 */
  width: number;
}

/**
 * 观察一个元素的宽度。
 *
 * @param fallback - SSR / 未测量时报告的宽度；给一个偏大的值可避免首帧闪成窄布局。
 * @returns 元素 ref 与当前宽度。
 */
export function useElementWidth(fallback = 1024): ElementWidth {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const node = ref.current;
    if (node === null) return undefined;

    // 同步测一次，避免首帧用 fallback 渲染出错误布局再跳变。
    setWidth(node.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      // 用 contentRect 而不是 offsetWidth：包含 padding 的更精确宽度对这里没意义。
      const next = entry.contentRect.width;
      setWidth((current) => (Math.abs(current - next) < 1 ? current : next));
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}
