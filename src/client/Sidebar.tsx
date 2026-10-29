/**
 * 左侧栏：切换文件夹、置顶区、文件树、文件名搜索。
 *
 * 为什么单独成文件：这一块约 1200 行（含文件树递归节点、搜索、文件夹下拉），
 * 与「右侧看什么」「技能怎么浏览」互不相干。混在 `NotesPanel` 里时，任何一侧
 * 的小改动都要在一千多行里翻找。
 *
 * 它只关心「你自己的笔记目录」。浏览技能时，外壳会整块换成 `SkillTreePane`。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives';
import type { DirEntry, NotesApi } from './api';
import {
  IconCaret, IconCheck, IconClose, IconFolder, IconLocate, IconPin,
  IconRefresh, IconSearch, IconSkill, IconUnfoldLess, IconUnfoldMore,
} from './icons';
import { basenameOf, messageOf } from './paths';
import type { FileVisibility, NotesStore, PinLayout } from './store';
import { ancestorsOf, filterFiles, listAllDirectories, listAllFiles, type FileHit } from './treeOps';
import { useElementWidth } from './useElementWidth';

/** 与外壳保持一致的常量（只在左侧栏内部用，故就放在这里）。 */
const MAX_PINNED = 6;
const PIN_TWO_COLUMN_MIN_WIDTH = 240;
const PIN_DRAG_THRESHOLD = 4;
const EXPAND_ALL_LIMIT = 500;
const LOCATE_HIGHLIGHT_MS = 1600;
const LOCATE_MAX_FRAMES = 40;
const SLOW_LISTING_MS = 150;
const DRAG_EXPAND_DELAY_MS = 600;
const SEARCH_LIMIT = 30;
const SEARCH_SCAN_LIMIT = 5000;

/** 左侧栏属性。 */
export interface SidebarProps {
  api: NotesApi;
  store: NotesStore;
  /** 文件树刷新令牌；变化即重新列目录。 */
  treeRevision: number;
  /** 手动重新读取整棵文件树（外部改动后使用）。 */
  onRefreshTree: () => void;
  /** 刚点过刷新、旋转反馈未结束。 */
  refreshing: boolean;
  root: string;
  pinned: string[];
  expanded: string[];
  activePath: string | null;
  onChooseFolder: () => void;
  /** 直接切到某个历史文件夹。 */
  onPickRoot: (path: string) => void;
  /** 从历史里忘掉某个文件夹。 */
  onForgetRoot: (path: string) => void;
  /** 历史文件夹（不含当前的）。 */
  recentRoots: string[];
  /** 是否显示「浏览技能…」入口。 */
  showSkillsEntry: boolean;
  onOpenFile: (entry: DirEntry) => void;
  onOpenPinned: (path: string) => void;
  onTogglePin: (path: string) => void;
  draggingPath: string | null;
  onDragStart: (path: string) => void;
  onDragEnd: () => void;
  onDropInto: (destDir: string) => void;
  onContextMenu: (entry: DirEntry, x: number, y: number) => void;
  /** 文件树可见范围。 */
  fileVisibility: FileVisibility;
  onSetFileVisibility: (mode: FileVisibility) => void;
  /** 置顶区排版（单栏 / 双栏）。 */
  pinLayout: PinLayout;
  onSetPinLayout: (layout: PinLayout) => void;
  /** 用系统默认程序打开一个不可在阅读器内阅读的文件。 */
  onOpenExternal: (entry: DirEntry) => void;
  /** 在树上做一次性提示（定位失败、展开被截断等）。 */
  onNotice: (message: string) => void;
  /** 打开技能目录页；未提供表示技能阅读被关掉（按钮不渲染）。 */
  onOpenSkills?: (() => void) | undefined;
}

/** 文件名搜索框的属性。 */
interface FileSearchProps {
  api: NotesApi;
  root: string;
  /** 文件树刷新令牌：变化时让缓存失效（新建/删除/外部改动后都要重新收集）。 */
  treeRevision: number;
  /** 选中一个文件：调用处负责展开祖先、定位并打开。 */
  onPick: (path: string) => void;
}


/**
 * 置顶区下方的文件名搜索。
 *
 * 交互：输入即在下拉里列出**当前根目录下**文件名匹配的文件，上下键移动、回车或
 * 点击选中 —— 选中后由调用处展开树并打开阅读区。
 *
 * 性能取舍：文件树本身是懒加载的（只列已展开的目录），搜索需要全量清单，
 * 所以在**首次聚焦时**整棵遍历一次并缓存在内存里，之后每次输入只在本地过滤，
 * 不再打宿主；`treeRevision` 变化（文件增删、外部改动）时缓存失效，下次聚焦重拉。
 */
function FileSearch(props: FileSearchProps): JSX.Element {
  const { api, root, treeRevision, onPick } = props;

  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<readonly FileHit[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);

  const boxRef = useRef<HTMLDivElement | null>(null);
  /** 已缓存清单对应的 treeRevision；不一致就说明缓存过期了。 */
  const cachedFor = useRef<number | null>(null);

  // 换了根或树变了，缓存作废。
  useEffect(() => {
    cachedFor.current = null;
    setFiles(null);
  }, [root, treeRevision]);

  /** 需要时把全量清单拉回来（只拉一次）。 */
  const ensureFiles = useCallback(async (): Promise<void> => {
    if (files !== null && cachedFor.current === treeRevision) return;
    if (scanning) return;
    setScanning(true);
    try {
      const result = await listAllFiles(api, root, SEARCH_SCAN_LIMIT);
      setFiles(result.files);
      setTruncated(result.truncated);
      cachedFor.current = treeRevision;
    } catch {
      setFiles([]);
    } finally {
      setScanning(false);
    }
  }, [api, root, treeRevision, files, scanning]);

  const hits = useMemo(
    () => (files === null ? [] : filterFiles(files, query, SEARCH_LIMIT)),
    [files, query],
  );

  // 命中变化后把光标拉回首行，避免停在已不存在的下标上。
  useEffect(() => {
    setCursor(0);
  }, [query]);

  // 点外部收起下拉。
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      const box = boxRef.current;
      if (box !== null && !box.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  /** 选中一条命中。 */
  const pick = useCallback(
    (hit: FileHit) => {
      setOpen(false);
      setQuery('');
      onPick(hit.path);
    },
    [onPick],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
      setQuery('');
      return;
    }
    if (hits.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((n) => (n + 1) % hits.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((n) => (n - 1 + hits.length) % hits.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const hit = hits[cursor];
      if (hit !== undefined) pick(hit);
    }
  };

  const showList = open && query.trim() !== '';

  return (
    <div className="dsh-notes__search" ref={boxRef}>
      <div className="dsh-notes__search-field">
        <IconSearch size={13} />
        <input
          type="text"
          className="dsh-notes__search-input"
          placeholder="搜索文件名"
          aria-label="搜索文件名"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            void ensureFiles();
          }}
          onFocus={() => {
            setOpen(true);
            void ensureFiles();
          }}
          onKeyDown={onKeyDown}
        />
        {query !== '' && (
          <button
            type="button"
            className="dsh-notes__search-clear"
            title="清空"
            aria-label="清空搜索"
            onClick={() => {
              setQuery('');
              setOpen(false);
            }}
          >
            <IconClose size={10} />
          </button>
        )}
      </div>

      {showList && (
        <div className="dsh-notes__search-list" role="listbox" aria-label="搜索结果">
          {scanning && hits.length === 0 && (
            <div className="dsh-notes__search-tip">读取文件清单…</div>
          )}
          {!scanning && hits.length === 0 && (
            <div className="dsh-notes__search-tip">没有匹配的文件</div>
          )}
          {hits.map((hit, index) => (
            <button
              key={hit.path}
              type="button"
              role="option"
              aria-selected={index === cursor}
              className={`dsh-notes__search-item${index === cursor ? ' dsh-notes__search-item--on' : ''}`}
              title={hit.path}
              // 用 mousedown 而不是 click：避免输入框先失焦导致候选被收起。
              onMouseDown={(event) => {
                event.preventDefault();
                pick(hit);
              }}
              onMouseEnter={() => setCursor(index)}
            >
              <span className="dsh-notes__search-ic">
                <FileTypeIcon path={hit.name} size={13} />
              </span>
              <span className="dsh-notes__search-name">{hit.name}</span>
              {hit.dir !== '' && <span className="dsh-notes__search-dir">{hit.dir}</span>}
            </button>
          ))}
          {truncated && (
            <div className="dsh-notes__search-tip">
              文件太多，只索引了前 {SEARCH_SCAN_LIMIT} 个
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 文件夹下拉
// ---------------------------------------------------------------------------

/** 文件夹下拉的属性。 */
interface FolderMenuProps {
  /** 当前文件夹。 */
  root: string;
  /** 历史文件夹（不含当前的）。 */
  recent: string[];
  /** 切到某个文件夹。 */
  onPick: (path: string) => void;
  /** 忘掉某个历史文件夹（只删记录）。 */
  onForget: (path: string) => void;
  /** 打开系统选择框挑一个新文件夹。 */
  onBrowse: () => void;
  /** 是否显示「浏览技能…」（插件配置 skillsReading）。 */
  showSkills: boolean;
  /** 打开技能列表。 */
  onOpenSkills: () => void;
  onClose: () => void;
}

/**
 * 把路径截成「前两级 + … + 末两级」，让长路径在窄栏里也认得出是哪个目录。
 *
 * 只做展示，点击仍用完整路径。
 *
 * @param path - 绝对路径。
 * @returns 适合放进下拉的短形式。
 */
function shortenPath(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '');
  if (parts.length <= 3) return path;
  const tail = parts.slice(-2).join('/');
  const head = parts.length > 4 ? `…/${tail}` : parts.join('/');
  return head;
}

/**
 * 文件夹下拉：当前目录 + 历史目录 + 「浏览技能…」+「选择其他文件夹…」。
 *
 * 为什么做成下拉而不是直接弹系统框：有多个工作区的人每次切换都要面对同一个
 * 系统对话框、重新点进几层目录，成本很高。历史留在下拉里，一次点击就能回去；
 * 每项右侧的 × 只删记录，不碰磁盘。
 *
 * 下拉是**页面内浮层**（不是系统菜单），因为系统菜单没法在单项里放删除按钮。
 */
function FolderMenu(props: FolderMenuProps): JSX.Element {
  const { root, recent, onPick, onForget, onBrowse, showSkills, onOpenSkills, onClose } = props;
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current !== null && event.target instanceof Node && ref.current.contains(event.target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return (
    <div className="dsh-notes__foldermenu" ref={ref} role="menu" aria-label="切换文件夹">
      <div className="dsh-notes__foldermenu-label">当前</div>
      <div className="dsh-notes__foldermenu-row dsh-notes__foldermenu-row--current" title={root}>
        <IconCheck size={11} />
        <span className="dsh-notes__foldermenu-name">{shortenPath(root)}</span>
      </div>

      {recent.length > 0 && (
        <>
          <div className="dsh-notes__foldermenu-label">最近</div>
          {recent.map((path) => (
            <div key={path} className="dsh-notes__foldermenu-row" title={path}>
              <button
                type="button"
                className="dsh-notes__foldermenu-pick"
                role="menuitem"
                onClick={() => onPick(path)}
              >
                {shortenPath(path)}
              </button>
              {/* 删除只作用于「历史记录」，所以放在行内单独的可点区域，
                  点了不会顺带切换目录。 */}
              <button
                type="button"
                className="dsh-notes__foldermenu-x"
                title="从历史中移除（不会删除文件夹）"
                aria-label={`从历史中移除 ${path}`}
                onClick={() => onForget(path)}
              >
                <IconClose size={9} />
              </button>
            </div>
          ))}
        </>
      )}

      <div className="dsh-notes__foldermenu-sep" />

      {/* 技能与文件夹是同一类导航（选一个地方看内容），所以放在同一个下拉里，
          避免左侧栏出现两个并列的下拉。 */}
      {showSkills && (
        <button type="button" className="dsh-notes__foldermenu-action" role="menuitem" onClick={onOpenSkills}>
          <IconSkill size={12} />
          浏览技能…
        </button>
      )}
      <button type="button" className="dsh-notes__foldermenu-action" role="menuitem" onClick={onBrowse}>
        <IconFolder size={12} />
        选择其他文件夹…
      </button>
    </div>
  );
}

/** 左侧：切换文件夹按钮、置顶区、文件树。 */
export function NotesSidebar(props: SidebarProps): JSX.Element {
  const { root, pinned, expanded, activePath } = props;
  /** 文件夹下拉是否展开。 */
  const [folderOpen, setFolderOpen] = useState(false);

  /** 文件树滚动容器：定位时用它把目标节点滚进视野。 */
  const treeRef = useRef<HTMLDivElement | null>(null);

  /**
   * 把某个路径的节点滚到视野中央，并短暂高亮。
   *
   * 子目录是懒加载的：展开祖先之后节点要过几帧才渲染出来，所以按帧重试。
   * 高亮直接改 DOM class（一次性视觉反馈），不往树里层层透传状态 —— 节点被
   * React 重建时高亮自然消失，无副作用。
   *
   * @param target - 目标文件路径。
   * @returns 是否已找到并定位（找不到由调用处提示）。
   */
  const scrollToPath = useCallback((target: string): Promise<boolean> => {
    return new Promise((resolve) => {
      let frames = 0;
      const tick = (): void => {
        const container = treeRef.current;
        const node =
          container === null
            ? null
            : Array.from(container.querySelectorAll<HTMLElement>('[data-path]')).find(
                (item) => item.getAttribute('data-path') === target,
              ) ?? null;

        if (container !== null && node !== null) {
          const box = container.getBoundingClientRect();
          const rect = node.getBoundingClientRect();
          // 只在不在视野内时滚动，并把目标放到中间，避免上下贴边看不见上下文。
          if (rect.top < box.top || rect.bottom > box.bottom) {
            container.scrollTop += rect.top - box.top - (box.height - rect.height) / 2;
          }
          node.classList.add('dsh-notes__node--located');
          setTimeout(() => node.classList.remove('dsh-notes__node--located'), LOCATE_HIGHLIGHT_MS);
          resolve(true);
          return;
        }

        frames += 1;
        if (frames >= LOCATE_MAX_FRAMES) {
          resolve(false);
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, []);

  /**
   * 定位到当前打开的文件：把它的祖先目录逐个展开，再滚过去高亮一下。
   */
  const locateActive = useCallback(async (): Promise<void> => {
    if (props.root === null || activePath === null) {
      props.onNotice('还没有打开的文件，先打开一个文件再定位');
      return;
    }
    const ancestors = ancestorsOf(activePath, props.root);
    if (ancestors.length > 0) {
      props.store.setExpanded([...expanded, ...ancestors]);
    }
    const found = await scrollToPath(activePath);
    if (!found) {
      props.onNotice('当前树里找不到这个文件：可能被「可编辑」范围的过滤隐藏了');
    }
  }, [props, activePath, expanded, scrollToPath]);

  /**
   * 展开所有祖先目录并打开文件（搜索结果点选用）。
   *
   * 路径来自搜索的扁平清单，没有 DirEntry 对象，所以这里按路径推导文件名。
   */
  const openFromSearch = useCallback(
    (path: string): void => {
      if (props.root === null) return;
      const ancestors = ancestorsOf(path, props.root);
      if (ancestors.length > 0) {
        props.store.setExpanded([...props.expanded, ...ancestors]);
      }
      const name = basenameOf(path);
      props.onOpenFile({ name, path, kind: 'file', editable: true });
      // 树里滚过去高亮一下：让用户知道文件在哪一层。
      void scrollToPath(path);
    },
    [props, scrollToPath],
  );

  /**
   * 全部展开：逐层列出所有目录后整体展开。
   *
   * 只发一次状态写（setExpanded），避免边遍历边渲染导致树反复重排。
   */
  const expandAllDirs = useCallback(async (): Promise<void> => {
    if (props.root === null) return;
    const { dirs, truncated } = await listAllDirectories(props.api, props.root, EXPAND_ALL_LIMIT);
    props.store.setExpanded(dirs);
    if (truncated) {
      props.onNotice(`目录太多，只展开了前 ${dirs.length} 个文件夹`);
    }
  }, [props]);

  /** 全部收起：清空展开集合即可。 */
  const collapseAllDirs = useCallback((): void => {
    props.store.collapseAll();
  }, [props.store]);

  // 置顶并排需要每个胶囊放得下文件名。左栏固定 232px 时两列每列约 100px，
  // 中文名会被截成两三个字，所以按左栏实际宽度决定，而不是按面板断点。
  // 用户也可以手动切换单栏/双栏：单栏牺牲纵向空间换完整文件名。
  const sidebarWidth = useElementWidth(0);
  const twoColumnPins = props.pinLayout === 'two' && sidebarWidth.width >= PIN_TWO_COLUMN_MIN_WIDTH;

  // 置顶排序用「指针事件」自己实现，刻意不用 HTML5 拖拽（draggable +
  // dragstart/dragover/drop）。
  //
  // 原因：在 DSH 桌面端（Electron）里这套原生拖拽对置顶区不可靠 —— 实测只有
  // 列表最后一项能拖起来，前面的项一律无反应；而同一套代码在真实浏览器里用
  // 相同事件序列又能通过，说明问题出在原生拖拽与宿主环境的交互上，不适合
  // 继续猜。指针事件完全由自己控制：不涉及 dataTransfer、不需要 drop 目标、
  // 不受「拖拽源元素被移动」影响，行为在任何环境下都一致。
  // （文件树的拖拽仍用原生拖拽，那条路径在真实环境里是正常的。）
  const [pinDragging, setPinDragging] = useState<string | null>(null);
  const [pinSlot, setPinSlot] = useState<number | null>(null);
  /** 正在拖拽的置顶项（同步 ref，事件管线的事实来源，不依赖 React 刷新时机）。 */
  const pinDraggingRef = useRef<string | null>(null);
  /** 当前落点格子（同步 ref，松手提交用）。 */
  const pinSlotRef = useRef<number | null>(null);
  /** 按下时的起点：移动超过阈值才算拖拽，否则保持为一次普通点击。 */
  const pressRef = useRef<{ path: string; x: number; y: number } | null>(null);
  /** 拖拽结束后吞掉随之而来的那一次 click，避免误开文件。 */
  const suppressClickRef = useRef(false);
  /** 拖拽期间挂在 document 上的监听器（结束时必须摘掉）。 */
  const moveRef = useRef<((event: MouseEvent) => void) | null>(null);
  const upRef = useRef<((event: MouseEvent) => void) | null>(null);
  const pinsRef = useRef<HTMLDivElement | null>(null);

  /**
   * 拖动期间的实时预览顺序：被拖项即时插入到 pinSlot 位置。
   * 与 store.reorderPinned 完全一致（先摘除、再按摘除后的数组插），
   * 松手时 store 写下的就是用户刚刚看到的样子。
   */
  const previewPinned = useMemo(() => {
    if (pinDragging === null) return pinned;
    const rest = pinned.filter((item) => item !== pinDragging);
    const fallback = Math.max(pinned.indexOf(pinDragging), 0);
    const index = Math.max(0, Math.min(pinSlot ?? fallback, rest.length));
    return [...rest.slice(0, index), pinDragging, ...rest.slice(index)];
  }, [pinned, pinDragging, pinSlot]);

  /**
   * 把指针位置换算成落点格子：网格按 count 个格子（含被拖项自己）均分，
   * 指针在第几格，被拖项就放到第几格。
   *
   * 用格子坐标而不是「某张卡的矩形」做锚点，是因为预览重排会让卡片位置变化，
   * 以卡片为锚点会自激振荡（列表闪烁、前几项拖不动）。格子只由容器几何决定，
   * 预览前后指向同一处，稳定且每个位置都可达。
   *
   * @param clientX/clientY - 指针位置。
   * @param count - 网格中的格子总数（= 置顶项总数）。
   */
  const slotFromPointer = (clientX: number, clientY: number, count: number): number => {
    const box = pinsRef.current?.getBoundingClientRect();
    if (box === undefined || box.width === 0 || box.height === 0 || count <= 1) return 0;
    const columns = twoColumnPins ? 2 : 1;
    const rows = Math.max(1, Math.ceil(count / columns));
    // 指针落在容器内按比例折算行列；容器外（贴边）时夹到范围内。
    const relX = Math.min(Math.max(clientX - box.left, 0), box.width - 0.001);
    const relY = Math.min(Math.max(clientY - box.top, 0), box.height - 0.001);
    const col = Math.min(columns - 1, Math.floor((relX / box.width) * columns));
    const row = Math.min(rows - 1, Math.floor((relY / box.height) * rows));
    return Math.min(Math.max(row * columns + col, 0), count - 1);
  };

  /**
   * 结束一次指针拖拽：摘掉全局监听，必要时提交新顺序。
   *
   * @param commit - true 表示拖拽结束（提交顺序）；false 表示取消（如组件卸载）。
   */
  const endPinDrag = useCallback(
    (commit: boolean) => {
      if (moveRef.current !== null) document.removeEventListener('mousemove', moveRef.current);
      if (upRef.current !== null) document.removeEventListener('mouseup', upRef.current);
      moveRef.current = null;
      upRef.current = null;

      const dragging = pinDraggingRef.current;
      if (commit && dragging !== null) {
        const slot = pinSlotRef.current;
        props.store.reorderPinned(dragging, slot ?? pinned.length - 1);
        // 拖完紧跟着会来一次 click（按下与松开可能落在同一元素上），吞掉它，
        // 否则排序后顺手把文件打开了。click 与 mouseup 在同一轮任务里派发，
        // 所以这里用 0ms 定时器清标记就足够，不会误伤之后的正常点击。
        suppressClickRef.current = true;
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }

      pinDraggingRef.current = null;
      pinSlotRef.current = null;
      setPinDragging(null);
      setPinSlot(null);
    },
    [props.store, pinned.length],
  );

  // 组件卸载时收尾，避免 document 上残留监听器。
  useEffect(() => () => endPinDrag(false), [endPinDrag]);

  /**
   * 在某个置顶项上按下：进入「预备拖拽」状态，移动超过阈值才真正开始拖。
   * 这样普通点击（打开文件 / 点 × 取消置顶）完全不受影响。
   */
  const onPinMouseDown = (event: React.MouseEvent<HTMLButtonElement>, path: string): void => {
    if (event.button !== 0) return;
    if (pinned.length < 2) return;
    // 点 × 时不参与拖拽，交给它的点击逻辑。
    if (event.target instanceof HTMLElement && event.target.closest('.dsh-notes__pin-x') !== null) {
      return;
    }
    // 兜底：上一次拖拽若因鼠标在窗口外松开而没收到 mouseup，这里先收尾。
    if (pinDraggingRef.current !== null) endPinDrag(false);
    pressRef.current = { path, x: event.clientX, y: event.clientY };

    const onMove = (moveEvent: MouseEvent): void => {
      const press = pressRef.current;
      if (press === null) return;

      if (pinDraggingRef.current === null) {
        // 阈值内视为点击，不进入拖拽状态。
        if (
          Math.hypot(moveEvent.clientX - press.x, moveEvent.clientY - press.y) <
          PIN_DRAG_THRESHOLD
        ) {
          return;
        }
        // 起点落在自己当前所在格：预览从「原地」开始，不会先跳一下。
        const startIndex = Math.max(pinned.indexOf(press.path), 0);
        pinDraggingRef.current = press.path;
        pinSlotRef.current = startIndex;
        setPinDragging(press.path);
        setPinSlot(startIndex);
      }

      const slot = slotFromPointer(moveEvent.clientX, moveEvent.clientY, pinned.length);
      pinSlotRef.current = slot;
      setPinSlot((prev) => (prev === slot ? prev : slot));
    };

    const onUp = (): void => {
      pressRef.current = null;
      endPinDrag(pinDraggingRef.current !== null);
    };

    moveRef.current = onMove;
    upRef.current = onUp;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <div className="dsh-notes__left" ref={sidebarWidth.ref}>
      {/* 最上方：文件夹下拉。点开是「当前 + 历史 + 浏览技能 + 选择其他文件夹」，
          比每次都弹系统选择框省事得多（多工作区场景尤其明显）。 */}
      <div className="dsh-notes__folderwrap">
        <button
          type="button"
          className="dsh-notes__folder"
          title={`${root}\n点击切换文件夹`}
          aria-haspopup="menu"
          aria-expanded={folderOpen}
          onClick={() => setFolderOpen((value) => !value)}
        >
          <IconFolder size={13} />
          <span className="dsh-notes__folder-name">{root}</span>
          <IconCaret />
        </button>
        {folderOpen && (
          <FolderMenu
            root={root}
            recent={props.recentRoots}
            onPick={(path) => {
              setFolderOpen(false);
              props.onPickRoot(path);
            }}
            onForget={props.onForgetRoot}
            onBrowse={() => {
              // 先关菜单，**等菜单真正卸载**再弹系统面板。
              //
              // 为什么不能像以前那样直接调：`setFolderOpen(false)` 只是排一个
              // 重渲染，紧接着就 `pickDirectory()` 的话，系统面板会在「下拉菜单
              // 还挂在页面上、焦点还在菜单项上」的瞬间弹出来。DSH 自己的工作区
              // 入口不会这样，它是「点 + → 渲染菜单 → effect 里再打开目录流程」，
              // 中间隔了完整的 React 提交，因此面板出现时窗口状态是干净的。
              //
              // 这里用 requestAnimationFrame 等一帧：此时 React 的提交已经完成、
              // 菜单已卸载、样式也已应用。相比固定毫秒数，它跟着实际渲染节奏走。
              setFolderOpen(false);
              requestAnimationFrame(() => {
                props.onChooseFolder();
              });
            }}
            showSkills={props.showSkillsEntry}
            onOpenSkills={() => {
              setFolderOpen(false);
              props.onOpenSkills?.();
            }}
            onClose={() => setFolderOpen(false)}
          />
        )}
      </div>

      {/* 置顶区：数量自适应；标题右侧是单/双栏排版切换 */}
      <div className="dsh-notes__pinned">
        <div className="dsh-notes__pinned-head">
          <IconPin size={11} />
          置顶
          <span className="dsh-notes__pinned-count">
            {pinned.length}/{MAX_PINNED}
          </span>
          {/* 排版切换：双栏省纵向空间、单栏文件名看得全。只在一个以上置顶时出现。 */}
          {pinned.length >= 2 && (
            <button
              type="button"
              className="dsh-notes__vis"
              aria-label="置顶排版"
              title={
                props.pinLayout === 'two'
                  ? '当前双栏（省空间）；点此切换为单栏，文件名更完整'
                  : '当前单栏（文件名完整）；点此切换为双栏，省纵向空间'
              }
              onClick={() => props.onSetPinLayout(props.pinLayout === 'two' ? 'one' : 'two')}
            >
              {props.pinLayout === 'two' ? '双栏' : '单栏'}
            </button>
          )}
        </div>

        {pinned.length === 0 ? (
          <div className="dsh-notes__hint" style={{ padding: '2px 2px 4px' }}>
            暂无置顶。hover 文件行点右侧图钉即可置顶。
          </div>
        ) : (
          <div
            ref={pinsRef}
            className={`dsh-notes__pins${pinned.length >= 2 && twoColumnPins ? ' dsh-notes__pins--two' : ''}${pinDragging !== null ? ' dsh-notes__pins--dragging' : ''}`}
          >
            {/* 拖动期间的实时预览：用 CSS order 做视觉重排 —— DOM 顺序保持
                pinned 不变，被拖元素在 DOM 里纹丝不动，拖拽绝不会被「源元素
                被移动」打断（之前用预览数组直接重排 DOM,前两项一动就触发
                dragend,表现为往后拖不动）。视觉上其他标签照样实时让位。 */}
            {pinned.map((path) => {
              // 同样要跨平台取名字：Windows 上路径用反斜杠，只按斜杠切分会得到整串。
              const name = basenameOf(path);
              // 拖动中按预览顺序给 order,其余时候保持 DOM 顺序。
              const order = pinDragging !== null ? previewPinned.indexOf(path) : undefined;
              const isFirst =
                pinDragging !== null && previewPinned[0] === path && previewPinned[0] !== pinned[0];
              const isLast =
                pinDragging !== null &&
                previewPinned[previewPinned.length - 1] === path &&
                previewPinned[previewPinned.length - 1] !== pinned[pinned.length - 1];
              return (
                <button
                  key={path}
                  type="button"
                  data-pin-path={path}
                  className={`dsh-notes__pin${path === activePath ? ' dsh-notes__pin--active' : ''}${path === pinDragging ? ' dsh-notes__pin--ghost' : ''}`}
                  title={path}
                  style={order !== undefined ? { order } : undefined}
                  // 排序走指针事件（见 onPinMouseDown 上方说明），不用原生拖拽。
                  onMouseDown={(event) => onPinMouseDown(event, path)}
                  onClick={(event) => {
                    // 刚拖完的那一次 click 丢掉。
                    if (suppressClickRef.current) return;
                    // 点 × 取消置顶，点其余部分打开。
                    if ((event.target as HTMLElement).closest('.dsh-notes__pin-x') !== null) {
                      props.onTogglePin(path);
                      return;
                    }
                    props.onOpenPinned(path);
                  }}
                >
                  <span className="dsh-notes__pin-ic">
                    <FileTypeIcon path={name} size={13} />
                  </span>
                  <span className="dsh-notes__pin-name">{name}</span>
                  <span className="dsh-notes__pin-x" title="取消置顶">
                    <IconClose size={9} />
                  </span>
                  {/* 缝隙指示线：预览里排到最前的卡左缘 = 插到最前；
                      排到最后一张的右缘 = 插到最后 */}
                  {isFirst && <span className="dsh-notes__pin-gap" aria-hidden />}
                  {isLast && <span className="dsh-notes__pin-gap dsh-notes__pin-gap--after" aria-hidden />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 文件名搜索：夹在置顶区与文件树之间。放在这里是因为它服务的是「找到那个文件」，
          和树是同一件事的两种入口（树靠翻层级，搜索靠直接打名字）。 */}
      <FileSearch
        api={props.api}
        root={props.root ?? ''}
        treeRevision={props.treeRevision}
        onPick={openFromSearch}
      />

      {/* 文件树：根目录按「文件夹 / 根目录文件」分组。
          可见范围开关放在这一行（置顶区下方、文件树标题旁）：
          它是「这棵树显示什么」的开关，贴着树更符合心智。 */}
      <div className="dsh-notes__treehead">
        <span className="dsh-notes__treehead-label">文件</span>

        {/* 树操作：刷新 / 定位当前文件 / 全部展开 / 全部收起。放在可见范围开关左侧，
            这些都是「对树本身的动作」，与「树显示什么」的开关分开。 */}
        <button
          type="button"
          className={
            props.refreshing
              ? 'dsh-notes__treebtn dsh-notes__treebtn--spin'
              : 'dsh-notes__treebtn'
          }
          title="重新读取文件树（在外部改了文件后点这里）"
          aria-label="刷新文件树"
          onClick={props.onRefreshTree}
        >
          <IconRefresh />
        </button>
        <button
          type="button"
          className="dsh-notes__treebtn"
          title={
            activePath === null
              ? '定位到当前文件（还没有打开的文件）'
              : '定位到当前文件：展开它所在的文件夹并滚到它'
          }
          aria-label="定位到当前文件"
          disabled={activePath === null}
          onClick={() => void locateActive()}
        >
          <IconLocate />
        </button>
        <button
          type="button"
          className="dsh-notes__treebtn"
          title="打开所有文件夹"
          aria-label="打开所有文件夹"
          onClick={() => void expandAllDirs()}
        >
          <IconUnfoldMore />
        </button>
        <button
          type="button"
          className="dsh-notes__treebtn"
          title="收起所有文件夹"
          aria-label="收起所有文件夹"
          disabled={expanded.length === 0}
          onClick={collapseAllDirs}
        >
          <IconUnfoldLess />
        </button>

        <button
          type="button"
          className="dsh-notes__vis"
          title={
            props.fileVisibility === 'all'
              ? '当前显示全部文件；点此只显示可阅读的文件'
              : '当前只显示可阅读的文件；点此显示全部（不可阅读的用系统程序打开）'
          }
          aria-label="文件可见类型"
          onClick={() =>
            props.onSetFileVisibility(props.fileVisibility === 'all' ? 'editable' : 'all')
          }
        >
          {props.fileVisibility === 'all' ? '全部' : '可编辑'}
        </button>

      </div>

      {/* 树容器本身也是放置目标：拖到树的空白处 = 移回根目录。
          文件夹节点上的 drop 会 stopPropagation，优先命中更具体的目标。 */}
      <div
        ref={treeRef}
        className="dsh-notes__tree"
        onDragOver={(event) => {
          if (props.draggingPath === null) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(event) => {
          if (props.draggingPath === null) return;
          event.preventDefault();
          props.onDropInto(root);
        }}
      >
        <TreeNode
          api={props.api}
          store={props.store}
          treeRevision={props.treeRevision}
          root={root}
          path={root}
          depth={0}
          isRoot
          fileVisibility={props.fileVisibility}
          onOpenExternal={props.onOpenExternal}
          pinned={pinned}
          expanded={expanded}
          activePath={activePath}
          onOpenFile={props.onOpenFile}
          onTogglePin={props.onTogglePin}
          draggingPath={props.draggingPath}
          onDragStart={props.onDragStart}
          onDragEnd={props.onDragEnd}
          onDropInto={props.onDropInto}
          onContextMenu={props.onContextMenu}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 树节点（递归）
// ---------------------------------------------------------------------------

/** 树节点属性。 */
interface TreeNodeProps {
  /** Host 路由客户端；显式透传，不用模块级单例（单例在两个面板实例下会串）。 */
  api: NotesApi;
  store: NotesStore;
  /** 文件树刷新令牌；变化即重新列目录。 */
  treeRevision: number;
  root: string;
  path: string;
  depth: number;
  isRoot?: boolean;
  pinned: string[];
  expanded: string[];
  activePath: string | null;
  onOpenFile: (entry: DirEntry) => void;
  onTogglePin: (path: string) => void;
  /** 正在被拖拽的路径（null 表示当前没有拖拽）。 */
  draggingPath: string | null;
  /** 开始拖拽一个条目。 */
  onDragStart: (path: string) => void;
  /** 拖拽结束（无论成功与否）。 */
  onDragEnd: () => void;
  /** 把拖拽中的条目放进某个目录。 */
  onDropInto: (destDir: string) => void;
  /** 在条目上右键。 */
  onContextMenu: (entry: DirEntry, x: number, y: number) => void;
  /** 文件树可见范围；`editable` 时隐藏不可阅读的文件。 */
  fileVisibility: FileVisibility;
  /** 用系统默认程序打开一个不可在阅读器内阅读的文件。 */
  onOpenExternal: (entry: DirEntry) => void;
}

/** 一个目录节点：自己 + （展开时）子节点。 */
function TreeNode(props: TreeNodeProps): JSX.Element | null {
  const { path, isRoot, expanded } = props;
  const open = isRoot === true || expanded.includes(path);

  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * 是否已经久到值得显示「载入中…」。
   *
   * 本地列一个目录通常只要几毫秒，立刻显示「载入中…」再换成「空的文件夹」，
   * 视觉上就是**闪一下**（空文件夹尤其明显，因为两个提示文案都短、位置相同）。
   * 所以先等一小会儿：够快就什么都不显示，直接出结果；慢才给反馈。
   */
  const [slow, setSlow] = useState(false);
  /** 拖拽悬停在本目录上（用于高亮 + 自动展开计时）。 */
  const [dropActive, setDropActive] = useState(false);

  /** 悬停自动展开的计时器。 */
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 清理悬停计时器（卸载或离开时）。 */
  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  useEffect(() => clearHoverTimer, [clearHoverTimer]);

  // 展开时才去列目录（懒加载）。
  useEffect(() => {
    if (!open) return undefined;

    let alive = true;
    // 先当作「快」，150ms 内没回来才显示「载入中…」。
    setSlow(false);
    const timer = setTimeout(() => {
      if (alive) setSlow(true);
    }, SLOW_LISTING_MS);

    props.api
      .list(props.root, path)
      .then((listing) => {
        if (!alive) return;
        setEntries(listing.entries);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setError(messageOf(cause));
      });

    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // treeRevision 变化（新建/删除文件后）会强制重新列这一层。
  }, [open, path, props.root, props.api, props.treeRevision]);

  return (
    <>
      {isRoot !== true && (
        <div
          className={`dsh-notes__node${dropActive ? ' dsh-notes__node--drop' : ''}`}
          // data-path 供「定位到当前文件」按路径找节点（类名查询无法安全转义路径）。
          data-path={path}
          onClick={() => props.store.toggleExpanded(path)}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') props.store.toggleExpanded(path);
          }}
          // 拖拽经过时高亮；悬停一会儿自动展开，这样能拖进更深的一层。
          onDragOver={(event) => {
            if (props.draggingPath === null) return;
            // 不能拖到自己身上。
            if (props.draggingPath === path) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            if (!dropActive) setDropActive(true);

            if (!open && hoverTimer.current === null) {
              hoverTimer.current = setTimeout(() => {
                hoverTimer.current = null;
                props.store.toggleExpanded(path);
              }, DRAG_EXPAND_DELAY_MS);
            }
          }}
          onDragLeave={() => {
            setDropActive(false);
            clearHoverTimer();
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setDropActive(false);
            clearHoverTimer();
            if (props.draggingPath === null || props.draggingPath === path) return;
            props.onDropInto(path);
          }}
        >
          <span className={`dsh-notes__caret${open ? ' dsh-notes__caret--open' : ''}`}>
            <IconCaret />
          </span>
          <span style={{ display: 'grid', placeItems: 'center', color: 'var(--dsw-alias-state-warn-primary, #f5a524)' }}>
            <IconFolder />
          </span>
          <span className="dsh-notes__label">{basenameOf(path)}</span>
        </div>
      )}

      {open && (
        <div className={isRoot === true ? undefined : 'dsh-notes__children'}>
          {error !== null && <div className="dsh-notes__tree-msg">无法读取：{error}</div>}

          {error === null && entries === null && slow && (
            <div className="dsh-notes__tree-msg">载入中…</div>
          )}

          {error === null && entries !== null && entries.length === 0 && (
            <div className="dsh-notes__tree-msg">空的文件夹</div>
          )}

          {error === null && entries !== null && entries.length > 0 && renderEntries()}
        </div>
      )}
    </>
  );

  /**
   * 渲染一层内容。
   *
   * 根目录分成「文件夹」和「根目录文件」两组分别加标题 —— 这样一进面板就能
   * 先看到有哪些文件夹，再看到散落的文件，比混在一起清楚得多。
   * 子目录内部不分组（本来就短，再加标题反而啰嗦）。
   */
  function renderEntries(): JSX.Element {
    const raw = entries ?? [];
    /**
     * 「可编辑」模式下隐藏不可阅读的文件（.doc/.pdf/符号链接等）。
     * 目录永远保留：否则用户就再也进不去那个文件夹了。
     */
    const all =
      props.fileVisibility === 'all'
        ? raw
        : raw.filter((e) => e.kind === 'directory' || e.editable);
    const dirs = all.filter((e) => e.kind === 'directory');
    const files = all.filter((e) => e.kind !== 'directory');

    if (isRoot !== true) {
      return <>{all.map(renderOne)}</>;
    }

    return (
      <>
        {dirs.length > 0 && (
          <>
            <div className="dsh-notes__group">文件夹</div>
            {dirs.map(renderOne)}
          </>
        )}
        {files.length > 0 && (
          <>
            <div className="dsh-notes__group">根目录文件</div>
            {files.map(renderOne)}
          </>
        )}
      </>
    );
  }

  /** 渲染一个条目：目录递归，文件是可点击行。 */
  function renderOne(entry: DirEntry): JSX.Element {
    if (entry.kind === 'directory') {
      return (
        <TreeNode
          key={entry.path}
          api={props.api}
          store={props.store}
          treeRevision={props.treeRevision}
          root={props.root}
          path={entry.path}
          depth={props.depth + 1}
          pinned={props.pinned}
          expanded={props.expanded}
          activePath={props.activePath}
          onOpenFile={props.onOpenFile}
          onTogglePin={props.onTogglePin}
          draggingPath={props.draggingPath}
          onDragStart={props.onDragStart}
          onDragEnd={props.onDragEnd}
          onDropInto={props.onDropInto}
          onContextMenu={props.onContextMenu}
          fileVisibility={props.fileVisibility}
          onOpenExternal={props.onOpenExternal}
        />
      );
    }

    const pinnedOn = props.pinned.includes(entry.path);
    const active = entry.path === props.activePath;
    /** 能在阅读器里打开的文件（文本类）。 */
    const readable = entry.kind === 'file' && entry.editable;
    /**
     * 不能在阅读器里阅读的条目：.doc/.pdf 这类文件，以及符号链接等 other。
     * 它们在「全部」模式下可见，点一下交给系统默认程序打开。
     */
    const external = !readable;
    /** 是不是一个真实文件（可移动、可删除）；符号链接等 other 不算。 */
    const realFile = entry.kind === 'file';

    return (
      <div
        key={entry.path}
        className={`dsh-notes__node${active ? ' dsh-notes__node--active' : ''}${external ? ' dsh-notes__node--muted' : ''}`}
        // data-path 供「定位到当前文件」按路径找节点。
        data-path={entry.path}
        title={external ? `${entry.path}（用系统默认程序打开）` : entry.path}
        role="button"
        tabIndex={0}
        // 可拖拽：拖到文件夹上即移动进去。不可阅读的文件也是真实文件，同样可移动。
        draggable={realFile}
        onDragStart={(event) => {
          if (!realFile) return;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', entry.path);
          props.onDragStart(entry.path);
        }}
        onDragEnd={() => props.onDragEnd()}
        onClick={() => {
          // 可阅读的在面板内打开；其余交给系统默认程序，而不是死掉没反应。
          if (readable) props.onOpenFile(entry);
          else if (realFile) props.onOpenExternal(entry);
        }}
        onContextMenu={(event) => {
          if (!realFile) return;
          event.preventDefault();
          props.onContextMenu(entry, event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          if (readable) props.onOpenFile(entry);
          else if (realFile) props.onOpenExternal(entry);
        }}
      >
        <span className="dsh-notes__caret" />
        <span style={{ display: 'grid', placeItems: 'center' }}>
          <FileTypeIcon path={entry.name} size={14} />
        </span>
        <span className="dsh-notes__label">{entry.name}</span>

        {/* 置顶只对可阅读文件有意义（置顶项点开是进阅读器） */}
        {readable && (
          <span
            className={`dsh-notes__pinmark${pinnedOn ? ' dsh-notes__pinmark--on' : ''}`}
            title={pinnedOn ? '取消置顶' : '置顶'}
            role="button"
            tabIndex={-1}
            onClick={(event) => {
              // 阻止冒泡，避免点图钉同时把文件打开。
              event.stopPropagation();
              props.onTogglePin(entry.path);
            }}
          >
            <IconPin />
          </span>
        )}
      </div>
    );
  }
}

