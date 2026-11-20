/**
 * 量出**每一处**匹配在编辑框里的位置（文档坐标，不含滚动偏移）。
 *
 * textarea 内部不是 DOM，没法给某几个字上色，只能在它上面叠色块。
 * 编辑框是 `wrap="off"`（不折行），所以坐标是确定的：纵向 = 行号 × 行高，
 * 横向 = 该行前缀的文字宽度（canvas 量，CJK 与西文不同宽也能量准）。
 *
 * 返回**文档坐标**，滚动偏移交给渲染层整体平移 —— 那样滚动一次不必把
 * 几十上百处位置全部重算。
 */
function measureEditorHits(
  editor: HTMLTextAreaElement,
  text: string,
  matches: MatchRange[],
): HitBox[] {
  const style = getComputedStyle(editor);
  const lineHeight = Number.parseFloat(style.lineHeight) || 21.875;
  const padTop = Number.parseFloat(style.paddingTop) || 0;
  const padLeft = Number.parseFloat(style.paddingLeft) || 0;

  // 行首偏移表：一次 O(n) 扫完，之后每处二分定位行号，避免 O(n × 匹配数)。
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const lineOf = (position: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lineStarts[mid] <= position) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  const ctx = document.createElement('canvas').getContext('2d');
  if (ctx !== null) {
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  }

  return matches.map((match) => {
    const line = lineOf(match.start);
    const lineStart = lineStarts[line];
    // canvas 量不出制表符的宽度（会当成 0），而编辑框的 tab-size 是 2 ——
    // 按两个空格折算，缩进用 tab 的文件才不会整行左移。
    const expandTabs = (raw: string): string => raw.replace(/\t/g, '  ');
    const offsetX = ctx === null ? 0 : ctx.measureText(expandTabs(text.slice(lineStart, match.start))).width;
    const wordWidth = ctx === null ? 0 : ctx.measureText(expandTabs(text.slice(match.start, match.end))).width;
    return {
      top: padTop + line * lineHeight,
      left: padLeft + offsetX,
      // 至少 4px，避免零宽匹配（如 ^）时看不见。
      width: Math.max(4, wordWidth),
      height: lineHeight,
    };
  });
}


/**
 * 文档内查找：编辑栏与 Markdown 预览共用一套状态。
 *
 * **刻意不注册任何全局快捷键**。DSH 允许插件各自绑定按键，本插件再去抢
 * ⌘F 就会和快捷键类插件打架 —— 谁先注册谁生效，用户完全看不出来是被谁截走了。
 * 所以入口是阅读器底部状态栏的一个按钮，键盘只在查找框内部响应
 * （Enter / Shift+Enter / Esc），离开那个输入框就完全不监听按键。
 *
 * 为什么单独成模块：它要同时应付两种渲染方式 —— textarea 里靠选区定位，
 * 预览区里靠文本节点 + Range。这部分逻辑与「文档怎么显示」无关，混进
 * EditorPane 只会把那个文件推到八九百行。
 *
 * 两种模式的搜索对象**不是同一段文本**：编辑时搜的是 Markdown 源码，
 * 预览时搜的是渲染后的纯文字。所以同一关键字在两种模式下匹配数可能不同
 * （例如搜 `**` 只可能在源码里命中）—— 这是真实的语义差异，切换模式时
 * 会重新计算，不假装两者一致。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/** 单次最多返回多少处匹配：超长文件里逐个找会把主线程拖住。 */
const MAX_MATCHES = 500;

/** 预览区最多扫描多少字符，防御性地给一个上限。 */
const MAX_PREVIEW_CHARS = 2_000_000;

/** CSS Highlight API 的两组名字：全部匹配、当前匹配。 */
const HL_ALL = 'dsh-notes-find';
const HL_ACTIVE = 'dsh-notes-find-active';

/** 查找条需要对外暴露的接口。 */
export interface FindController {
  /** 查找条是否展开。 */
  open: boolean;
  /** 当前关键字。 */
  query: string;
  /** 当前是第几处（从 1 起）；没有匹配时为 0。 */
  current: number;
  /** 匹配总数。 */
  /** 编辑框里当前匹配的像素位置（textarea 无法内部着色，靠它叠色块）。 */
  hits: HitBox[];
  /** 当前是第几处（0 起），渲染层用它把这一处画得更重。 */
  active: number;
  total: number;
  /** 输入框 ref：展开时自动聚焦并全选。 */
  inputRef: RefObject<HTMLInputElement>;
  /** 更新关键字（从第 1 处重新开始）。 */
  setQuery: (next: string) => void;
  /** 打开查找条。 */
  openFind: () => void;
  /** 按钮用：展开 / 收起来回切。 */
  toggle: () => void;
  /** 关闭查找条并清掉高亮。 */
  close: () => void;
  /** 跳到下一处（循环）。 */
  next: () => void;
  /** 跳到上一处（循环）。 */
  prev: () => void;
}

/** 一处匹配在源文本中的区间。 */
interface MatchRange {
  start: number;
  end: number;
}

/** 一处命中块在编辑框里的像素位置（文档坐标）。 */
interface HitBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * 在文本里找出全部匹配位置。
 *
 * 大小写策略是「智能忽略」：关键字全小写就忽略大小写（最常见），只要用户
 * 敲了任何大写就按原样精确匹配 —— 与多数编辑器的默认行为一致，也省掉一个
 * 开关。注意这里用 toLowerCase 后的文本算下标，仅在少数语言（如土耳其语 İ）
 * 会因长度变化而错位，中文与英文不受影响。
 */
function findAll(text: string, query: string): MatchRange[] {
  if (query === '') return [];
  const ignoreCase = query === query.toLowerCase();
  const needle = ignoreCase ? query.toLowerCase() : query;
  const haystack = ignoreCase ? text.toLowerCase() : text;
  const out: MatchRange[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1 && out.length < MAX_MATCHES) {
    out.push({ start: at, end: at + needle.length });
    at = haystack.indexOf(needle, at + needle.length);
  }
  return out;
}

/**
 * 把编辑框滚到匹配处并选中。
 *
 * textarea 设置选区后浏览器**不会**自动滚动，所以位置得手算：行号靠数换行
 * （一行内容再长也只占一行），行高乘行号就是偏移。
 *
 * **绝对不要在这里 `editor.focus()`。** 查找框才是当前交互目标，一旦把焦点
 * 交给编辑器，用户敲的第二个字就会进正文 —— 表现为「第一个字进了搜索框，
 * 后面的字在改文件」。手动设选区不需要焦点，滚动也照常生效，所以这里只动
 * 选区与 scrollTop。
 *
 * 不用 focus 还有个副作用要防：`focus()` 会把「当时的光标」滚进视野并覆盖
 * scrollTop，所以顺序必须是**先选区、后设 scrollTop**，否则滚动会被重置。
 */
function revealInEditor(editor: HTMLTextAreaElement, text: string, range: MatchRange): void {
  const lineIndex = text.slice(0, range.start).split('\n').length - 1;
  const style = getComputedStyle(editor);
  const lineHeight = Number.parseFloat(style.lineHeight) || 21.875;
  const padTop = Number.parseFloat(style.paddingTop) || 0;
  editor.setSelectionRange(range.start, range.end);
  editor.scrollTop = Math.max(0, padTop + lineIndex * lineHeight - editor.clientHeight / 3);
}

/** 预览区里的一个文本节点，以及它在「拼接全文」中的区间。 */
interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

/**
 * 收集预览区所有文本节点，拼成一份可搜索的连续文本。
 *
 * 必须拼接而不是逐节点搜：Markdown 渲染后一个词可能被 `<strong>` 之类的
 * 标签切成多个文本节点（`**粗**体` → 两个节点），逐节点找会漏掉跨节点的匹配。
 */
function collectSegments(root: HTMLElement): { segments: TextSegment[]; text: string } {
  const segments: TextSegment[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let parts: string[] = [];
  let acc = 0;
  let node = walker.nextNode();
  while (node !== null && acc < MAX_PREVIEW_CHARS) {
    const data = (node as Text).data;
    segments.push({ node: node as Text, start: acc, end: acc + data.length });
    parts.push(data);
    acc += data.length;
    node = walker.nextNode();
  }
  return { segments, text: parts.join('') };
}

/** 把「拼接文本」上的一个区间映射回真实 DOM Range，可能跨多个节点。 */
function rangesFor(segments: TextSegment[], match: MatchRange): Range[] {
  const out: Range[] = [];
  for (const seg of segments) {
    const from = Math.max(match.start, seg.start);
    const to = Math.min(match.end, seg.end);
    if (from >= to) continue;
    const range = document.createRange();
    range.setStart(seg.node, from - seg.start);
    range.setEnd(seg.node, to - seg.start);
    out.push(range);
  }
  return out;
}

/** 把预览区滚到第一个 Range 附近（偏上三分之一，留出上下文）。 */
function revealInPreview(preview: HTMLElement, ranges: Range[]): void {
  const first = ranges[0];
  if (first === undefined) return;
  const rect = first.getBoundingClientRect();
  const box = preview.getBoundingClientRect();
  preview.scrollTop += rect.top - box.top - preview.clientHeight / 3;
}

/**
 * 用 CSS Custom Highlight API 上色。
 *
 * 好处是完全不改 DOM —— 预览内容是 MarkdownText 渲染出来的，往里插标记
 * 会破坏 React 的节点所有权，随手下一次渲染就会崩。
 * 不支持的环境（旧内核）静默跳过：查找仍然能跳转，只是看不到底色。
 */
function paintHighlights(all: Range[], active: Range[]): void {
  const host = globalThis as {
    CSS?: { highlights?: Map<string, unknown> };
    Highlight?: new (...ranges: Range[]) => unknown;
  };
  const map = host.CSS?.highlights;
  const Ctor = host.Highlight;
  if (map === undefined || typeof Ctor !== 'function') return;
  map.set(HL_ALL, new Ctor(...all));
  map.set(HL_ACTIVE, new Ctor(...active));
}

/** 清掉两组高亮（关闭查找条时）。 */
function clearHighlights(): void {
  const host = globalThis as { CSS?: { highlights?: Map<string, unknown> } };
  const map = host.CSS?.highlights;
  if (map === undefined) return;
  map.delete(HL_ALL);
  map.delete(HL_ACTIVE);
}

/** useFind 的入参。 */
export interface UseFindOptions {
  /** 编辑栏里的源码全文。 */
  text: string;
  /** 编辑框；预览模式下为 null（此时没有 textarea）。 */
  editorRef: RefObject<HTMLTextAreaElement | null>;
  /** 预览区容器；编辑模式下也要传，切到预览时才用得到。 */
  previewRef: RefObject<HTMLDivElement | null>;
  /** 当前显示的是否是源码栏。 */
  sourceVisible: boolean;
  /**
   * 当前是否显示预览区。
   *
   * 分栏时两个都为真 —— 此时**两边都要处理**：编辑框给选区与滚动，
   * 预览区给高亮。只按「sourceVisible」二分会漏掉预览那边的高亮。
   */
  previewVisible: boolean;
}

/**
 * 文档内查找。
 *
 * 快捷键只在 EditorPane 挂载期间生效 —— 面板切走时组件卸载，所以不会
 * 干扰 DSH 其他区域的 ⌘F。
 */
export function useFind(options: UseFindOptions): FindController {
  const { text, editorRef, previewRef, sourceVisible, previewVisible } = options;

  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState('');
  const [index, setIndex] = useState(0);
  /** 源码口径的匹配（编辑框用）。 */
  const [matches, setMatches] = useState<MatchRange[]>([]);
  /** 预览口径的匹配（渲染后的纯文字，与源码不是同一段文本）。 */
  const [previewMatches, setPreviewMatches] = useState<MatchRange[]>([]);
  /** 编辑框里全部命中的位置（文档坐标）；不在编辑模式或没有匹配时为空。 */
  const [hits, setHits] = useState<HitBox[]>([]);
  /** 预览模式下本次扫描到的文本节点，跳转时用来把下标还原成 Range。 */
  /** 查找输入框；展开时用来聚焦。 */
  const inputRef = useRef<HTMLInputElement>(null);
  const segmentsRef = useRef<TextSegment[]>([]);

  /** 源码口径：只在源码栏可见时算（纯预览模式没有编辑框，算了也用不上）。 */
  useEffect(() => {
    if (!open || query === '' || !sourceVisible) {
      setMatches([]);
      return;
    }
    setMatches(findAll(text, query));
  }, [open, query, text, sourceVisible]);

  /**
   * 预览口径：只要预览区可见就算 —— **分栏模式也算**。
   *
   * 预览搜的是渲染后的纯文字，与源码不是同一段文本（`**` 在预览里根本不存在），
   * 所以下标不能共用一份，必须各算各的。
   *
   * 还要盯住 DOM 变化：预览里的代码块正文、语法高亮是**异步**填进来的，只算
   * 一次就会漏掉后插入的部分（表现为「编辑栏有、预览区少一处」）。
   */
  useEffect(() => {
    if (!open || query === '' || !previewVisible || previewRef.current === null) {
      setPreviewMatches([]);
      segmentsRef.current = [];
      clearHighlights();
      return undefined;
    }
    const preview = previewRef.current;
    const recompute = (): void => {
      const collected = collectSegments(preview);
      segmentsRef.current = collected.segments;
      setPreviewMatches(findAll(collected.text, query));
    };
    recompute();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
      // 节流：语法高亮会逐块插入，没必要每块都重算。
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        recompute();
      }, 150);
    });
    observer.observe(preview, { childList: true, subtree: true, characterData: true });

    return () => {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  }, [open, query, text, previewVisible, previewRef]);

  /** 两边集合变了都夹一次下标，避免停在越界位置。 */
  useEffect(() => {
    setIndex((current) => {
      const longest = Math.max(matches.length, previewMatches.length);
      return longest === 0 ? 0 : Math.min(current, longest - 1);
    });
  }, [matches, previewMatches]);

  /**
   * 源码栏：选中 + 滚到匹配处 + 量出高亮色块。
   *
   * 不抢焦点（见 revealInEditor 的说明）。色块是绝对定位在编辑框上方的，
   * 编辑框自己滚动不会带着它走 —— 但滚动偏移不在这里逐块重算，
   * 而是由渲染层把整层平移（见 EditorPane 的 findLayer）。
   */
  useEffect(() => {
    if (!open || !sourceVisible) {
      setHits([]);
      return;
    }
    const match = matches[Math.min(index, matches.length - 1)];
    const editor = editorRef.current;
    if (match === undefined || editor === null) {
      setHits([]);
      return;
    }
    revealInEditor(editor, text, match);
    // 一次算完全部命中；滚动偏移由渲染层整体平移，这里不再监听 scroll。
    setHits(measureEditorHits(editor, text, matches));
  }, [open, index, matches, sourceVisible, text, editorRef]);

  /**
   * 预览区：全部匹配上浅色、当前那处上深色，并滚过去。
   *
   * 这一支在**分栏模式下也要跑** —— 之前只按 sourceVisible 二分，导致分栏时
   * 预览区完全没有高亮。
   */
  useEffect(() => {
    if (!open || !previewVisible) return;
    const preview = previewRef.current;
    const segments = segmentsRef.current;
    if (preview === null || segments.length === 0 || previewMatches.length === 0) {
      clearHighlights();
      return;
    }
    const all: Range[] = [];
    for (const each of previewMatches) all.push(...rangesFor(segments, each));
    const activeMatch = previewMatches[Math.min(index, previewMatches.length - 1)];
    const active = activeMatch === undefined ? [] : rangesFor(segments, activeMatch);
    paintHighlights(all, active);
    revealInPreview(preview, active);
  }, [open, index, previewMatches, previewVisible, previewRef]);

  /** 关闭时清掉预览高亮与编辑框色块。 */
  useEffect(() => {
    if (open) return;
    clearHighlights();
    setHits([]);
  }, [open]);

  /**
   * 刚展开时聚焦输入框并全选，方便直接改关键字。
   *
   * 只在 open 从 false 变 true 时执行一次；依赖里放 open 而不是 query，
   * 否则每敲一个字都会重新聚焦、把光标位置重置（中文输入法尤其明显）。
   */
  useEffect(() => {
    if (!open) return;
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, [open]);

  const openFind = useCallback(() => setOpen(true), []);

  /** 底栏按钮用：已展开时再点一次就收起。 */
  const toggle = useCallback(() => {
    setOpen((was) => {
      if (was) {
        setQueryState('');
        setMatches([]);
        setIndex(0);
        segmentsRef.current = [];
        clearHighlights();
      }
      return !was;
    });
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setQueryState('');
    setMatches([]);
    setIndex(0);
    segmentsRef.current = [];
    clearHighlights();
  }, []);

  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    setIndex(0);
  }, []);

  // 计数与上下跳转都跟着「当前主视角」：有源码栏时按源码口径（分栏也是），
  // 否则按预览口径 —— 两套的下标含义不同，不能混用。
  const activeMatches = sourceVisible ? matches : previewMatches;

  const step = useCallback(
    (delta: number) => {
      const total = activeMatches.length;
      setIndex((current) => {
        if (total === 0) return 0;
        return (Math.min(current, total - 1) + delta + total) % total;
      });
    },
    [activeMatches.length],
  );

  const next = useCallback(() => step(1), [step]);
  const prev = useCallback(() => step(-1), [step]);

  return {
    open,
    query,
    current: activeMatches.length === 0 ? 0 : Math.min(index, activeMatches.length - 1) + 1,
    total: activeMatches.length,
    hits,
    active: activeMatches.length === 0 ? 0 : Math.min(index, activeMatches.length - 1),
    inputRef,
    setQuery,
    openFind,
    toggle,
    close,
    next,
    prev,
  };
}
