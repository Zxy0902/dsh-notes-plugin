/**
 * 笔记面板主体：文件夹树 + 置顶区 + tab 栏 + 编辑器/预览。
 *
 * 这是 B 方案（插件接管中间主面板）的界面实现，交互对齐 Typora：
 * - 左侧：切换文件夹按钮、置顶区（最多 6 个，数量自适应）、文件树
 * - 右侧：浏览器式 tab 栏（切换 / × 关闭 / + 新建）、md 左编右渲、txt 单栏
 * - 手动保存：Cmd/Ctrl+S 或保存按钮；未保存时 tab 上显示小圆点
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { FileTypeIcon, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives';
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives';
import { NotesApi, NotesApiError, type DirEntry } from './api';
import { MAX_PINNED, NotesStore, type FileVisibility, type NoteTab, type PinLayout } from './store';
import { useScrollSync } from './useScrollSync';
import { BREAKPOINTS, useElementWidth } from './useElementWidth';

// ---------------------------------------------------------------------------
// 小图标（内联 SVG，避免外部资源）
// ---------------------------------------------------------------------------

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** 文件夹图标。 */
function IconFolder({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
      <path d="M2 4.4a1 1 0 0 1 1-1h2.6l1.3 1.6H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.4Z" />
    </svg>
  );
}

/** 折叠箭头。 */
function IconCaret(): JSX.Element {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" {...stroke} strokeWidth={2} aria-hidden="true">
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

/** 图钉图标。 */
function IconPin({ size = 11 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
      <path d="M9.6 2.4 13.6 6.4M11 4.9 7.6 8.3c-.5.5-1.3.6-1.9.3L4 9.8 2.4 8.2 3.6 6.6c-.3-.6-.2-1.4.3-1.9l3.4-3.4" />
    </svg>
  );
}

/** 关闭叉。 */
function IconClose({ size = 10 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} strokeWidth={1.9} aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

/** 加号。 */
function IconPlus(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" {...stroke} aria-hidden="true">
      <path d="M8 3.6v8.8M3.6 8h8.8" />
    </svg>
  );
}

/** 向下的小尖头：tab 栏放不下时，点它下拉列出被遮挡的标签页。 */
function IconChevronDown({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
      <path d="M4.2 6.4 8 10.2l3.8-3.8" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Markdown 渲染标签
// ---------------------------------------------------------------------------

/** MarkdownText 要求的本地化标签（稳定引用，避免打断解析缓存）。 */
const MARKDOWN_LABELS: MarkdownLabels = {
  code: { copyLabel: '复制', copiedLabel: '已复制' },
  footnotes: '脚注',
};

/**
 * Markdown 的显示方式。
 * - `split`：左编辑 + 右预览
 * - `edit`：只编辑
 * - `preview`：只阅读（不渲染编辑框，纯看文档时最干净）
 */
type ViewMode = 'split' | 'edit' | 'preview';

/** 拖拽悬停在文件夹上多久后自动展开（毫秒）。太短会误展开，太长又觉得迟钝。 */
const DRAG_EXPAND_DELAY_MS = 600;

/** 置顶并排所需的最小左栏宽度（px）：低于此值单列，保证文件名可读。 */
const PIN_TWO_COLUMN_MIN_WIDTH = 240;

/**
 * 置顶排序：按下后移动多少像素才算「拖拽」（px）。
 *
 * 小于该距离视为普通点击（打开文件 / 点 × 取消置顶），这样排序不会把点击吃掉。
 */
const PIN_DRAG_THRESHOLD = 4;

/** 显示方式的可选项（供 SegmentedControl 使用）。 */
const VIEW_MODE_OPTIONS = [
  { value: 'edit' as const, label: '编辑' },
  { value: 'split' as const, label: '分栏' },
  { value: 'preview' as const, label: '预览' },
];

// ---------------------------------------------------------------------------
// 面板组件
// ---------------------------------------------------------------------------

/** 面板组件的注入面。 */
export interface NotesPanelProps {
  /** 状态仓库。 */
  store: NotesStore;
  /** Host 路由客户端。 */
  api: NotesApi;
  /** 调起目录选择器；返回选中的绝对路径，取消则为 null。 */
  pickDirectory: () => Promise<string | null>;
  /**
   * 用系统程序打开文件，或只显示它在系统中的位置。
   *
   * 由入口层注入（那里才拿得到 ctx.remote），面板本身不直接依赖 DSH 服务，
   * 便于单独测试。返回失败原因文本，成功返回 null。
   */
  openExternal: (
    path: string,
    options?: { application?: string; reveal?: boolean },
  ) => Promise<string | null>;
  /** 这台机器的宿主是否支持交给桌面程序打开。 */
  canOpenExternal: () => Promise<boolean>;
  /**
   * 列出系统里能打开该文件的应用。
   * @returns 应用列表；查询失败返回 null（界面显示「无法获取应用列表」）。
   */
  listApplications: (path: string) => Promise<
    readonly { id: string; name?: string; default?: boolean }[] | null
  >;
}

/**
 * 笔记面板。
 * @param props - 注入的仓库、API 与目录选择器。
 */
export function NotesPanel({
  store,
  api,
  pickDirectory,
  openExternal,
  canOpenExternal,
  listApplications,
}: NotesPanelProps): JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  /** 正在被拖拽的路径；null 表示没有进行中的拖拽。 */
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  /** 右键菜单：目标条目与屏幕坐标。 */
  const [menu, setMenu] = useState<{ entry: DirEntry; x: number; y: number } | null>(null);
  /** 待确认删除的条目；非 null 时显示确认弹层。 */
  const [pendingDelete, setPendingDelete] = useState<DirEntry | null>(null);

  /**
   * 本平台是否支持删除（能否移入系统回收站）。
   *
   * 初值 false：**先当作不能用**，等宿主确认后再放开。宁可在极短的首帧里
   * 少一个菜单项，也不要让 Windows 用户看到一个点了会被 403 拒绝的「删除」。
   */
  const [canDelete, setCanDelete] = useState(false);

  // 面板自身宽度：会话栏折叠/展开、右侧栏拖拽、窗口缩放都会改变它。
  const panelWidth = useElementWidth(1024);
  /** 窄容器：收起左侧文件夹栏，把宽度让给编辑/预览。 */
  const narrow = panelWidth.width < BREAKPOINTS.hideSidebar;

  const activeTab = useMemo(
    () => state.tabs.find((tab) => tab.id === state.activeTabId) ?? null,
    [state.tabs, state.activeTabId],
  );

  /** 短暂提示。 */
  const flash = useCallback((message: string) => {
    setNotice(message);
    setTimeout(() => setNotice((current) => (current === message ? null : current)), 2400);
  }, []);

  // 问一次宿主本平台能不能删除，据此决定右键菜单里是否出现「删除」。
  // 探测失败就保持不支持：宁可不给入口，也不给一个点了会报错的入口。
  useEffect(() => {
    let alive = true;
    api
      .health()
      .then((info) => {
        if (alive) setCanDelete(info.canDelete === true);
      })
      .catch(() => {
        // 读不到能力信息时按「不支持」处理，界面少一项总好过点了失败。
      });
    return () => {
      alive = false;
    };
  }, [api]);

  /** 切换浏览文件夹。 */
  const chooseFolder = useCallback(async () => {
    try {
      const picked = await pickDirectory();
      if (picked === null) return;
      store.setRoot(picked);
    } catch (error) {
      flash(`选择文件夹失败：${messageOf(error)}`);
    }
  }, [pickDirectory, store, flash]);

  /** 打开一个文件（点树或点置顶都会走这里）。 */
  const openFile = useCallback(
    (entry: DirEntry) => {
      const kind: 'md' | 'txt' =
        entry.name.toLowerCase().endsWith('.md') || entry.name.toLowerCase().endsWith('.markdown')
          ? 'md'
          : 'txt';
      store.openTab({ id: entry.path, name: entry.name, path: entry.path, kind });
    },
    [store],
  );

  /**
   * 打开一个阅读器打不开的文件（.doc/.pdf/.sql 等）。
   *
   * 不再直接调系统程序，而是在阅读区开一个 `external` tab：里面显示
   * 「此格式无法在阅读器中打开」+ 原生风格的「打开方式」控件（列可用的应用、
   * 或用默认程序打开、或显示文件位置）。这样点错文件不会突然弹出别的程序。
   */
  const openExternally = useCallback(
    (entry: DirEntry) => {
      store.openTab({ id: entry.path, name: entry.name, path: entry.path, kind: 'external' });
    },
    [store],
  );

  /** 置顶开关。 */
  const togglePin = useCallback(
    (path: string) => {
      const result = store.togglePin(path);
      if (!result.ok && result.reason === 'limit') {
        flash(`最多置顶 ${MAX_PINNED} 个文件`);
      }
    },
    [store, flash],
  );

  /**
   * 把拖拽中的文件移动进某个目录。
   *
   * 成功后刷新整棵树（源目录要少一项、目标目录要多一项），并顺手更新已打开
   * 的 tab 与置顶项里的旧路径 —— 否则那个 tab 之后再保存就会写回一个不存在的位置。
   */
  const dropInto = useCallback(
    async (destDir: string) => {
      const from = draggingPath;
      setDraggingPath(null);
      if (from === null) return;
      if (dirnameOf(from) === destDir) return; // 原地不动，没必要发请求

      try {
        const result = await api.move(state.root ?? '', from, destDir);
        store.remapPath(from, result.to);
        store.refreshTree();
        // destDir 就是根目录本身时不再显示文件夹名，直接说「根目录」。
        flash(
          destDir === state.root
            ? '已移动到根目录'
            : `已移动到「${basenameOf(destDir)}」`,
        );
      } catch (error) {
        flash(`移动失败：${messageOf(error)}`);
      }
    },
    [api, draggingPath, state.root, store, flash],
  );

  /**
   * 确认删除：把文件移入回收站，然后关掉它的 tab 并刷新树。
   */
  const confirmDelete = useCallback(async () => {
    const entry = pendingDelete;
    setPendingDelete(null);
    if (entry === null) return;

    try {
      const result = await api.remove(state.root ?? '', entry.path);
      // 关掉对应的 tab（含草稿），并取消置顶，避免留下指向已删文件的残留。
      store.closeTab(entry.path);
      store.unpin(entry.path);
      store.refreshTree();
      // 文案不写死平台：系统回收站的位置与叫法各平台不同（macOS 叫「废纸篓」、
      // Linux 叫「回收站」），回退时则直接报出实际目录，用户照着就能找到。
      // （Windows 上删除入口不出现，见 canDelete。）
      flash(
        result.fallback
          ? `已移入 ${basenameOf(dirnameOf(result.moved))}/，可从那里取回`
          : '已移入系统回收站，可从回收站取回',
      );
    } catch (error) {
      flash(`删除失败：${messageOf(error)}`);
    }
  }, [api, pendingDelete, state.root, store, flash]);

  /** 从置顶区打开文件。 */
  const openPinned = useCallback(
    (path: string) => {
      const name = path.split('/').pop() ?? path;
      const lower = name.toLowerCase();
      const kind: 'md' | 'txt' = lower.endsWith('.md') || lower.endsWith('.markdown') ? 'md' : 'txt';
      store.openTab({ id: path, name, path, kind });
    },
    [store],
  );

  // 没有选中根目录时给一个引导态。
  if (state.root === null) {
    return (
      <div className="dsh-notes">
        <div className="dsh-notes__empty">
          <IconFolder size={30} />
          <h3>还没有选择文件夹</h3>
          <p>选择一个文件夹作为笔记的存放与浏览位置。文件会平铺保存其中，随时可以用外部编辑器打开。</p>
          <button type="button" className="dsh-notes__btn dsh-notes__btn--primary" onClick={() => void chooseFolder()}>
            选择文件夹
          </button>
        </div>
        {notice !== null && <div className="dsh-notes__hint">{notice}</div>}
      </div>
    );
  }

  return (
    <div
      className={`dsh-notes${narrow ? ' dsh-notes--narrow' : ''}`}
      ref={panelWidth.ref}
      /* 声明本面板不参与「拖动整窗」：DSH 桌面端带着 data-window-drag 的行会被
         设为窗口拖拽区（-webkit-app-region: drag），那块区域里的鼠标事件由系统
         接管，页面收不到。本插件占满主面板，若被叠上拖拽区，面板内的点击/拖拽
         就会失灵。data-window-drag-recall 是 DSH 自己提供的「退出拖拽区」标记
         （ui-web base.css 里对应 -webkit-app-region: no-drag），只对本面板生效，
         不影响 DSH 其他区域。 */
      data-window-drag-recall=""
    >
      {/* 窄容器下收起文件夹栏，避免左侧固定宽度把编辑区挤没 */}
      {!narrow && (
        <NotesSidebar
          api={api}
          store={store}
          treeRevision={state.treeRevision}
          root={state.root}
          pinned={state.pinned}
          expanded={state.expanded}
          activePath={activeTab?.path ?? null}
          onChooseFolder={() => void chooseFolder()}
          onOpenFile={openFile}
          onOpenPinned={openPinned}
          onTogglePin={togglePin}
          draggingPath={draggingPath}
          onDragStart={setDraggingPath}
          onDragEnd={() => setDraggingPath(null)}
          onDropInto={(destDir) => void dropInto(destDir)}
          onContextMenu={(entry, x, y) => setMenu({ entry, x, y })}
          fileVisibility={state.fileVisibility}
          onSetFileVisibility={(mode) => store.setFileVisibility(mode)}
          pinLayout={state.pinLayout}
          onSetPinLayout={(layout) => store.setPinLayout(layout)}
          onOpenExternal={openExternally}
        />
      )}

      <div className="dsh-notes__right">
        <TabStrip
          tabs={state.tabs}
          activeId={state.activeTabId}
          drafts={state.drafts}
          onActivate={(id) => store.activateTab(id)}
          onClose={(id) => store.closeTab(id)}
          onCloseOthers={(id) => store.closeOthers(id)}
          onCloseToRight={(id) => store.closeToRight(id)}
          onCloseAll={() => store.closeAll()}
          onCreate={() => setCreating(true)}
          showFolderToggle={narrow}
          onToggleFolder={() => void chooseFolder()}
          root={state.root}
        />

        {activeTab === null ? (
          <div className="dsh-notes__empty">
            <h3>没有打开的标签页</h3>
            <p>从左侧文件树选择一个文件，或点右上角的 + 新建笔记。</p>
          </div>
        ) : activeTab.kind === 'external' ? (
          <ExternalPane
            key={activeTab.id}
            tab={activeTab}
            openExternal={openExternal}
            canOpenExternal={canOpenExternal}
            listApplications={listApplications}
            onNotice={flash}
          />
        ) : (
          <EditorPane
            key={activeTab.id}
            tab={activeTab}
            root={state.root}
            api={api}
            store={store}
            initialScroll={state.scroll[activeTab.id] ?? 0}
            onNotice={flash}
          />
        )}

        {notice !== null && <div className="dsh-notes__hint">{notice}</div>}
      </div>

      {creating && (
        <CreateDialog
          root={state.root}
          api={api}
          onClose={() => setCreating(false)}
          onCreated={(tab) => {
            setCreating(false);
            store.openTab(tab);
            // 目录内容变了，让文件树立刻重新列一次，不必手动切走再切回。
            store.refreshTree();
          }}
          onError={(message) => flash(message)}
        />
      )}

      {/* 文件右键菜单 */}
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: '打开', onPick: () => openFile(menu.entry) },
            {
              label: state.pinned.includes(menu.entry.path) ? '取消置顶' : '置顶',
              onPick: () => togglePin(menu.entry.path),
            },
            // 删除只在支持移入系统回收站的平台出现（见 canDelete 的说明）。
            ...(canDelete
              ? [
                  { separator: true as const },
                  { label: '删除', danger: true, onPick: () => setPendingDelete(menu.entry) },
                ]
              : []),
          ]}
        />
      )}

      {/* 删除确认：明确告诉用户文件去哪了 */}
      {pendingDelete !== null && (
        <ConfirmDialog
          title="删除文件"
          message={`确定删除「${pendingDelete.name}」吗？`}
          detail="文件会被移到系统回收站，可以再取回；系统回收站不可用时则移入笔记目录下的 dsh-notes-trash。"
          confirmLabel="删除"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 左侧栏：文件夹 + 置顶 + 树
// ---------------------------------------------------------------------------

/** 左侧栏属性。 */
interface SidebarProps {
  api: NotesApi;
  store: NotesStore;
  /** 文件树刷新令牌；变化即重新列目录。 */
  treeRevision: number;
  root: string;
  pinned: string[];
  expanded: string[];
  activePath: string | null;
  onChooseFolder: () => void;
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
}

/** 左侧：切换文件夹按钮、置顶区、文件树。 */
function NotesSidebar(props: SidebarProps): JSX.Element {
  const { root, pinned, expanded, activePath } = props;

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
      {/* 最上方：切换文件夹 */}
      <button type="button" className="dsh-notes__folder" onClick={props.onChooseFolder} title={root}>
        <IconFolder size={13} />
        <span className="dsh-notes__folder-name">{root}</span>
        <IconCaret />
      </button>

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
              const name = path.split('/').pop() ?? path;
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

      {/* 文件树：根目录按「文件夹 / 根目录文件」分组。
          可见范围开关放在这一行（置顶区下方、文件树标题旁）：
          它是「这棵树显示什么」的开关，贴着树更符合心智。 */}
      <div className="dsh-notes__treehead">
        <span className="dsh-notes__treehead-label">文件</span>
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
    };
    // treeRevision 变化（新建/删除文件后）会强制重新列这一层。
  }, [open, path, props.root, props.api, props.treeRevision]);

  return (
    <>
      {isRoot !== true && (
        <div
          className={`dsh-notes__node${dropActive ? ' dsh-notes__node--drop' : ''}`}
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
          <span className="dsh-notes__label">{path.split('/').pop() ?? path}</span>
        </div>
      )}

      {open && (
        <div className={isRoot === true ? undefined : 'dsh-notes__children'}>
          {error !== null && <div className="dsh-notes__tree-msg">无法读取：{error}</div>}

          {error === null && entries === null && <div className="dsh-notes__tree-msg">载入中…</div>}

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

// ---------------------------------------------------------------------------
// tab 栏
// ---------------------------------------------------------------------------

/** tab 栏属性。 */
interface TabStripProps {
  tabs: NoteTab[];
  activeId: string | null;
  drafts: Record<string, string>;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** 关闭除该 tab 之外的全部。 */
  onCloseOthers: (id: string) => void;
  /** 关闭该 tab 右侧的全部。 */
  onCloseToRight: (id: string) => void;
  /** 关闭全部。 */
  onCloseAll: () => void;
  onCreate: () => void;
  /** 窄容器下左侧文件夹栏已收起，这里补一个切换文件夹的入口。 */
  showFolderToggle: boolean;
  /** 点切换文件夹。 */
  onToggleFolder: () => void;
  /** 当前根目录（按钮 title 用）。 */
  root: string;
}

/** 标签页右键菜单项。 */
function buildTabMenu(id: string, props: TabStripProps): MenuItem[] {
  const at = props.tabs.findIndex((tab) => tab.id === id);
  const items: MenuItem[] = [
    { label: '关闭', onPick: () => props.onClose(id) },
    { label: '关闭其他', onPick: () => props.onCloseOthers(id) },
  ];
  // 已经是最后一个就不给「关闭右侧」，避免出现点了没反应的菜单项。
  if (at >= 0 && at < props.tabs.length - 1) {
    items.push({ label: '关闭右侧标签页', onPick: () => props.onCloseToRight(id) });
  }
  items.push({ separator: true });
  items.push({ label: '关闭全部', danger: true, onPick: () => props.onCloseAll() });
  return items;
}

/** 浏览器式 tab 栏。 */
function TabStrip(props: TabStripProps): JSX.Element {
  /** 右键菜单：屏幕坐标 + 目标 tab。 */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  /** 溢出下拉是否展开。 */
  const [listOpen, setListOpen] = useState(false);
  /** 是否有标签被横向裁掉（含向右溢出，以及已滚出左边界的情况）。 */
  const [overflowing, setOverflowing] = useState(false);

  const scrollerRef = useRef<HTMLDivElement | null>(null);

  /**
   * 检测标签是否超出可视范围。
   *
   * scrollWidth > clientWidth 只覆盖「右侧还有内容」；用户把标签栏滚到中间时，
   * 左边也会有看不到的标签，所以再加上 scrollLeft > 0 这一条。
   */
  const measure = useCallback(() => {
    const node = scrollerRef.current;
    if (node === null) return;
    const hidden = node.scrollWidth - node.clientWidth;
    setOverflowing(hidden > 1 || node.scrollLeft > 1);
  }, []);

  // 标签数量、激活项、栏宽变化都要重新判断；用 ResizeObserver 盯住栏宽。
  useEffect(() => {
    measure();
    const node = scrollerRef.current;
    if (node === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => measure());
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure, props.tabs.length, props.activeId, props.showFolderToggle]);

  // 展开下拉时，把当前标签滚进视野，用户点开就能看到自己在哪。
  useEffect(() => {
    if (!listOpen) return;
    const node = scrollerRef.current;
    const active = node?.querySelector<HTMLElement>('.dsh-notes__tab--active');
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [listOpen]);

  /** 关掉下拉后把焦点还给按钮，键盘用户不会丢失位置。 */
  const closeList = useCallback(() => setListOpen(false), []);

  return (
    <div className="dsh-notes__tabsbar">
      {/* 真正滚动的标签区。左右两侧的箭头是它的兄弟节点，不随内容滚走。 */}
      <div className="dsh-notes__tabs" ref={scrollerRef} onScroll={measure}>
        {/* 窄容器下文件夹栏被收起，把「切换文件夹」挪到 tab 栏最左 */}
        {props.showFolderToggle && (
          <button
            type="button"
            className="dsh-notes__tab-add"
            style={{ marginRight: 4 }}
            title={`切换文件夹（当前 ${props.root}）`}
            onClick={props.onToggleFolder}
          >
            <IconFolder size={15} />
          </button>
        )}

        {props.tabs.map((tab) => {
          const active = tab.id === props.activeId;
          const dirty = tab.id in props.drafts;
          return (
            <div
              key={tab.id}
              className={`dsh-notes__tab${active ? ' dsh-notes__tab--active' : ''}`}
              title={tab.path ?? tab.name}
              role="button"
              tabIndex={0}
              onClick={() => props.onActivate(tab.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') props.onActivate(tab.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ id: tab.id, x: event.clientX, y: event.clientY });
              }}
              onAuxClick={(event) => {
                // 中键关闭，和浏览器一致。
                if (event.button === 1) {
                  event.preventDefault();
                  props.onClose(tab.id);
                }
              }}
            >
              <span className="dsh-notes__tab-ic">
                <FileTypeIcon path={tab.name} size={13} />
              </span>
              <span className="dsh-notes__tab-name">{tab.name}</span>

              {/* 未保存时圆点占位；hover 时圆点隐藏、关闭按钮出现（两者同格叠放） */}
              <span className="dsh-notes__tabend">
                {dirty && <span className="dsh-notes__dot" title="未保存" />}
                <span
                  className={`dsh-notes__tab-x${dirty ? ' dsh-notes__tab-x--dirty' : ' dsh-notes__tab-x--idle'}`}
                  title="关闭"
                  role="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onClose(tab.id);
                  }}
                >
                  <IconClose />
                </span>
              </span>
            </div>
          );
        })}
      </div>

      {/* 右侧固定区：溢出时出现下拉尖头，再是新建按钮。两者都不随标签滚动。 */}
      <div className="dsh-notes__tabsend">
        {overflowing && (
          <button
            type="button"
            className="dsh-notes__tab-more"
            title="显示全部标签页"
            aria-haspopup="menu"
            aria-expanded={listOpen}
            onClick={() => setListOpen((open) => !open)}
          >
            <IconChevronDown />
          </button>
        )}

        <button type="button" className="dsh-notes__tab-add" title="新建笔记" onClick={props.onCreate}>
          <IconPlus />
        </button>
      </div>

      {/* 溢出下拉：列出全部标签，被裁掉的在这里都能点到 */}
      {listOpen && (
        <>
          <div className="dsh-notes__menu-mask" onClick={closeList} role="presentation" />
          <div className="dsh-notes__tablist" role="menu">
            {props.tabs.map((tab) => {
              const active = tab.id === props.activeId;
              const dirty = tab.id in props.drafts;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="menuitem"
                  className={`dsh-notes__tablist-item${active ? ' dsh-notes__tablist-item--active' : ''}`}
                  title={tab.path ?? tab.name}
                  onClick={() => {
                    props.onActivate(tab.id);
                    closeList();
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ id: tab.id, x: event.clientX, y: event.clientY });
                  }}
                >
                  <span className="dsh-notes__tab-ic">
                    <FileTypeIcon path={tab.name} size={13} />
                  </span>
                  <span className="dsh-notes__tab-name">{tab.name}</span>
                  {dirty && <span className="dsh-notes__dot" title="未保存" />}
                  <span
                    className="dsh-notes__tab-x dsh-notes__tab-x--idle"
                    title="关闭"
                    role="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onClose(tab.id);
                    }}
                  >
                    <IconClose />
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildTabMenu(menu.id, props)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 不可预览文件
// ---------------------------------------------------------------------------

/** 与官方 ui-open-in-app 一致的文案（不自己另编，保证措辞统一）。 */
const EXTERNAL_LABELS = {
  /** 主按钮：用某个应用打开。 */
  openWith: (app: string): string => `用 ${app} 打开`,
  /** 无法判定默认应用时，主按钮退化为「显示文件位置」。 */
  reveal: '显示文件位置',
  /** 菜单里给默认项加的后缀。 */
  appDefault: (app: string): string => `${app}（默认）`,
  /** 应用列表读取失败的占位项。 */
  appsError: '无法获取应用列表',
  /** 一个可用应用都没有时的说明。 */
  noApps: '系统里没有找到能打开此格式的应用',
  /** 不支持交给桌面程序的平台说明。 */
  unsupported: '当前环境不支持用系统程序打开文件',
  /** 打开失败。 */
  openError: '打开失败，请重试',
  /** 显示位置失败。 */
  revealError: '无法显示文件位置，请重试',
} as const;

/** 不可预览页的属性。 */
interface ExternalPaneProps {
  tab: NoteTab;
  openExternal: (
    path: string,
    options?: { application?: string; reveal?: boolean },
  ) => Promise<string | null>;
  canOpenExternal: () => Promise<boolean>;
  listApplications: (path: string) => Promise<
    readonly { id: string; name?: string; default?: boolean }[] | null
  >;
  onNotice: (message: string) => void;
}

/**
 * 阅读器打不开的文件（.doc/.pdf/.sql 等）的提示页。
 *
 * 交互：点树里的这类文件**不再直接弹出系统程序**，而是在这里显示
 * 「此格式无法在阅读器中打开」+ 一个原生风格的分裂按钮 —— 左边用默认应用打开、
 * 右边下拉列出系统里所有能打开它的应用，底部另有「显示文件位置」。
 * 接口与文案都对齐官方 ui-open-in-app（它也在 DSH 右侧栏做同样的事）。
 */
function ExternalPane(props: ExternalPaneProps): JSX.Element {
  const { tab, openExternal, canOpenExternal, listApplications, onNotice } = props;
  const path = tab.path ?? '';

  /** null=探测中；false=该平台不支持交给桌面程序。 */
  const [desktop, setDesktop] = useState<boolean | null>(null);
  /** 应用列表；null=读取失败。 */
  const [apps, setApps] = useState<readonly { id: string; name?: string; default?: boolean }[] | null>(null);
  const [loadingApps, setLoadingApps] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // 先问宿主能不能交给桌面程序；不能就不显示按钮，只给说明。
  useEffect(() => {
    let alive = true;
    void canOpenExternal().then((value) => {
      if (alive) setDesktop(value);
    });
    return () => {
      alive = false;
    };
  }, [canOpenExternal]);

  // 桌面可用时再拉应用列表（不可用时没必要拉）。
  useEffect(() => {
    if (desktop !== true || path === '') return undefined;
    let alive = true;
    setLoadingApps(true);
    void listApplications(path).then((value) => {
      if (!alive) return;
      setApps(value);
      setLoadingApps(false);
    });
    return () => {
      alive = false;
    };
  }, [desktop, path, listApplications]);

  /** 默认应用：优先标了 default 的，否则第一个。 */
  const preferred = useMemo(() => {
    if (apps === null || apps.length === 0) return null;
    return apps.find((app) => app.default === true) ?? apps[0];
  }, [apps]);

  /** 执行一次打开/显示位置，并处理失败提示。 */
  const act = useCallback(
    async (options?: { application?: string; reveal?: boolean }) => {
      if (path === '' || busy) return;
      setBusy(true);
      setMenuOpen(false);
      try {
        const failure = await openExternal(path, options);
        if (failure !== null) onNotice(failure);
      } catch (error) {
        onNotice(
          options?.reveal === true
            ? EXTERNAL_LABELS.revealError
            : `${EXTERNAL_LABELS.openError}（${messageOf(error)}）`,
        );
      } finally {
        setBusy(false);
      }
    },
    [path, busy, openExternal, onNotice],
  );

  /** 主按钮：有默认应用就用它打开，否则退化为「显示文件位置」。 */
  const runPrimary = useCallback(() => {
    if (preferred === null) void act({ reveal: true });
    else if (preferred.default === true) void act();
    else void act({ application: preferred.id });
  }, [preferred, act]);

  /** 菜单项：每个可用应用 + 底部的「显示文件位置」。 */
  const menuItems = useMemo(() => {
    const items: { id: string; label: string; disabled?: boolean }[] = [];
    if (apps !== null) {
      for (const app of apps) {
        const name = app.name ?? app.id;
        items.push({
          id: `app:${app.id}`,
          label: app.id === preferred?.id ? EXTERNAL_LABELS.appDefault(name) : name,
        });
      }
    } else if (!loadingApps) {
      items.push({ id: 'unavailable', label: EXTERNAL_LABELS.appsError, disabled: true });
    }
    return items;
  }, [apps, preferred, loadingApps]);

  const primaryLabel =
    preferred === null ? EXTERNAL_LABELS.reveal : EXTERNAL_LABELS.openWith(preferred.name ?? preferred.id);
  const hasMenu = loadingApps || apps === null || menuItems.length + 1 > 1;

  return (
    <div className="dsh-notes__external">
      <div className="dsh-notes__external-card">
        <div className="dsh-notes__external-glyph" aria-hidden="true">
          <FileTypeIcon path={tab.name} size={40} />
        </div>
        <h3 className="dsh-notes__external-title">{tab.name}</h3>
        <p className="dsh-notes__external-hint">此格式无法在阅读器中打开</p>

        {desktop === false ? (
          <p className="dsh-notes__external-note">{EXTERNAL_LABELS.unsupported}</p>
        ) : desktop === null ? null : (
          <div className="dsh-notes__external-actions">
            {/* 分裂按钮：左＝用默认应用打开，右＝下拉选其他应用 */}
            <div className="dsh-notes__openwith" data-busy={busy ? '' : undefined}>
              <button
                type="button"
                className="dsh-notes__openwith-main"
                disabled={busy}
                onClick={runPrimary}
                title={primaryLabel}
              >
                <span className="dsh-notes__openwith-icon" aria-hidden="true">
                  <FileTypeIcon path={tab.name} size={15} />
                </span>
                <span className="dsh-notes__openwith-label">{primaryLabel}</span>
              </button>
              <button
                type="button"
                className="dsh-notes__openwith-caret"
                disabled={busy || !hasMenu}
                aria-label="更多打开方式"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <IconChevronDown size={14} />
              </button>
            </div>

            {menuOpen && (
              <>
                <div
                  className="dsh-notes__menu-mask"
                  onClick={() => setMenuOpen(false)}
                  aria-hidden="true"
                />
                <div className="dsh-notes__openwith-menu" role="menu">
                  {loadingApps ? (
                    <div className="dsh-notes__openwith-loading">正在读取应用列表…</div>
                  ) : (
                    <>
                      {menuItems.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          role="menuitem"
                          className="dsh-notes__openwith-item"
                          disabled={item.disabled === true}
                          onClick={() => {
                            if (item.id.startsWith('app:')) void act({ application: item.id.slice(4) });
                          }}
                        >
                          {item.label}
                        </button>
                      ))}
                      {apps !== null && apps.length === 0 && (
                        <div className="dsh-notes__openwith-loading">{EXTERNAL_LABELS.noApps}</div>
                      )}
                      <div className="dsh-notes__openwith-sep" role="separator" />
                      <button
                        type="button"
                        role="menuitem"
                        className="dsh-notes__openwith-item"
                        onClick={() => void act({ reveal: true })}
                      >
                        {EXTERNAL_LABELS.reveal}
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        <p className="dsh-notes__external-path" title={path}>
          {path}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 编辑区
// ---------------------------------------------------------------------------

/** 编辑区属性。 */
interface EditorPaneProps {
  tab: NoteTab;
  root: string;
  api: NotesApi;
  store: NotesStore;
  initialScroll: number;
  onNotice: (message: string) => void;
}

/** 单个 tab 的编辑/预览区。 */
function EditorPane(props: EditorPaneProps): JSX.Element {
  const { tab, root, api, store } = props;

  const [loaded, setLoaded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const draft = store.getSnapshot().drafts[tab.id];
  const dirty = draft !== undefined;
  const text = draft ?? loaded ?? '';

  // 打开 tab 时读文件（已有草稿则跳过，避免覆盖未保存内容）。
  useEffect(() => {
    if (tab.path === null) {
      setLoaded('');
      return undefined;
    }
    if (store.getSnapshot().drafts[tab.id] !== undefined) {
      setLoaded(null);
      return undefined;
    }

    let alive = true;
    setLoading(true);
    api
      .read(root, tab.path)
      .then((file) => {
        if (!alive) return;
        setLoaded(file.content);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setError(messageOf(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [api, root, tab.id, tab.path, store]);

  /**
   * 记录编辑栏滚动位置，用于「记忆功能」。
   * 用 ref 包一层，避免每次渲染换函数身份导致同步钩子反复重建。
   */
  const rememberScroll = useCallback(
    (top: number) => {
      store.setScroll(tab.id, top);
    },
    [store, tab.id],
  );

  /** 同步滚动开关；关闭后两侧各自独立滚动。 */
  const [syncScroll, setSyncScroll] = useState(true);

  /**
   * Markdown 的显示方式。txt 没有渲染概念，永远是 edit，不受此状态影响。
   * - split：左编辑 + 右预览（原来唯一的行为）
   * - edit：只显示编辑框
   * - preview：只显示渲染结果，不渲染编辑框 —— 纯阅读时最省空间也最干净
   */
  const [viewMode, setViewMode] = useState<ViewMode>('split');

  /** 只有分栏时才需要同步滚动。 */
  const sync = useScrollSync(tab.kind === 'md' && viewMode === 'split' && syncScroll, rememberScroll);
  const draftRef = sync.editorRef;

  /** 是否显示编辑框。 */
  const showEditor = tab.kind !== 'md' || viewMode !== 'preview';
  /** 是否显示渲染结果。 */
  const showPreview = tab.kind === 'md' && viewMode !== 'edit';

  // 恢复上次的滚动位置（编辑器为主，恢复后再把预览对齐过去）。
  useEffect(() => {
    const node = draftRef.current;
    if (node === null || props.initialScroll === 0) return;
    node.scrollTop = props.initialScroll;
    // 只在挂载时恢复一次；恢复后同步钩子会在下一次滚动时接管对齐。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 保存：把草稿写回磁盘。 */
  const save = useCallback(async () => {
    if (tab.path === null || !dirty || saving) return;
    setSaving(true);
    try {
      await api.write(root, tab.path, store.getSnapshot().drafts[tab.id] ?? '');
      store.clearDraft(tab.id);
      props.onNotice('已保存');
    } catch (cause) {
      props.onNotice(`保存失败：${messageOf(cause)}`);
    } finally {
      setSaving(false);
    }
  }, [api, root, tab.id, tab.path, dirty, saving, store, props]);

  // Cmd/Ctrl+S 保存。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const onChange = useCallback(
    (value: string) => {
      // 与磁盘内容一致就清掉草稿，圆点自然消失。
      if (loaded !== null && value === loaded) {
        store.clearDraft(tab.id);
        return;
      }
      store.setDraft(tab.id, value);
    },
    [loaded, store, tab.id],
  );

  if (error !== null) {
    return (
      <div className="dsh-notes__empty">
        <h3>打不开这个文件</h3>
        <p>{error}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="dsh-notes__empty">
        <p>载入中…</p>
      </div>
    );
  }

  return (
    <>
      <div className="dsh-notes__dochead">
        <span className="dsh-notes__docpath" title={tab.path ?? tab.name}>
          {tab.path ?? tab.name}
        </span>
        <span style={{ flex: '0 0 auto' }}>{dirty ? '未保存' : '已保存'}</span>

        {/* 顺序有意为之：变化宽度的按钮排在左边，显示方式选择器固定在最右侧。
            同步滚动只在「分栏」出现、保存只在「预览」或未保存时出现，两者宽度
            还不一样；若把选择器放在它们左侧，切模式时选择器就会被推来推去 ——
            而它本质上是同一组选项，位置必须稳定。
            .dsh-notes__docpath 是 flex:1，会把后面这一串一起顶到最右，
            所以选择器贴在右端不会因左侧按钮增删而移动。 */}

        {/* 同步滚动开关：只在分栏时有意义 */}
        {tab.kind === 'md' && viewMode === 'split' && (
          <button
            type="button"
            className="dsh-notes__btn"
            onClick={() => setSyncScroll((on) => !on)}
            title={syncScroll ? '关闭同步滚动' : '开启同步滚动'}
            aria-pressed={syncScroll}
          >
            {syncScroll ? '同步滚动' : '不同步'}
          </button>
        )}

        {/* 预览模式下不显示常规保存按钮，避免工具栏噪声；
            但若切到预览时仍有未保存改动，保留一个保存入口，防止改动无处可存。 */}
        {(!showEditor || dirty) && (
          <button
            type="button"
            className={`dsh-notes__btn${dirty ? ' dsh-notes__btn--primary' : ''}`}
            disabled={!dirty || saving}
            onClick={() => void save()}
            title="⌘S / Ctrl+S"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        )}

        {/* 显示方式：仅 markdown 需要（txt 没有渲染概念）。固定在最右端。 */}
        {tab.kind === 'md' && (
          <SegmentedControl
            id={`notes-view-${tab.id}`}
            value={viewMode}
            options={VIEW_MODE_OPTIONS}
            onChange={setViewMode}
            label="显示方式"
            className="dsh-notes__segmented"
          />
        )}
      </div>

      <div className={`dsh-notes__body${showPreview && showEditor ? '' : ' dsh-notes__body--single'}`}>
        {/* 编辑栏：txt 恒有；md 在「预览」模式下完全不渲染，省掉整块编辑区 */}
        {showEditor && (
          <div className="dsh-notes__pane">
            <textarea
              ref={draftRef}
              className="dsh-notes__editor"
              value={text}
              spellCheck={false}
              placeholder={tab.kind === 'md' ? '开始写 Markdown…' : '开始写点什么…'}
              onChange={(event) => onChange(event.target.value)}
              onScroll={sync.onEditorScroll}
            />
          </div>
        )}

        {/* 预览栏：只有 markdown 才有；分栏时与编辑栏按比例同步滚动 */}
        {showPreview && (
          <div className="dsh-notes__pane">
            <div ref={sync.previewRef} className="dsh-notes__preview" onScroll={sync.onPreviewScroll}>
              <MarkdownText text={text} labels={MARKDOWN_LABELS} variant="body" />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 新建弹层
// ---------------------------------------------------------------------------

/** 新建弹层属性。 */
interface CreateDialogProps {
  root: string;
  api: NotesApi;
  onClose: () => void;
  onCreated: (tab: NoteTab) => void;
  onError: (message: string) => void;
}

/** 新建笔记：先选类型（Markdown / txt），再填文件名。 */
function CreateDialog(props: CreateDialogProps): JSX.Element {
  const [kind, setKind] = useState<'md' | 'txt'>('md');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /** 提交新建。 */
  const submit = useCallback(async () => {
    const trimmed = name.trim();
    if (trimmed === '' || busy) return;

    // 用户可能只写了名字没写扩展名，按选的类型补上。
    const withExt = /\.(md|markdown|txt)$/i.test(trimmed) ? trimmed : `${trimmed}.${kind}`;
    const finalName = kind === 'md' ? withExt.replace(/\.markdown$/i, '.md') : withExt.replace(/\.(md|markdown)$/i, '.txt');

    setBusy(true);
    try {
      const created = await props.api.create(
        props.root,
        finalName,
        kind === 'md' ? `# ${finalName.replace(/\.md$/i, '')}\n\n` : '',
      );
      props.onCreated({
        id: created.path,
        name: finalName,
        path: created.path,
        kind,
      });
    } catch (cause) {
      setError(messageOf(cause));
      props.onError(`新建失败：${messageOf(cause)}`);
    } finally {
      setBusy(false);
    }
  }, [kind, name, busy, props]);

  return (
    <div className="dsh-notes__mask" onClick={props.onClose} role="presentation">
      <div className="dsh-notes__dialog" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <h3>新建笔记</h3>
        <p>文件会平铺保存在当前文件夹（{props.root}）下。</p>

        <div className="dsh-notes__kind">
          <button
            type="button"
            className={`dsh-notes__kind-btn${kind === 'md' ? ' dsh-notes__kind-btn--on' : ''}`}
            onClick={() => setKind('md')}
          >
            <b>Markdown</b>
            <span>左编辑右实时预览</span>
          </button>
          <button
            type="button"
            className={`dsh-notes__kind-btn${kind === 'txt' ? ' dsh-notes__kind-btn--on' : ''}`}
            onClick={() => setKind('txt')}
          >
            <b>纯文本 txt</b>
            <span>单栏直接编辑</span>
          </button>
        </div>

        <input
          ref={inputRef}
          className="dsh-notes__input"
          value={name}
          placeholder={kind === 'md' ? '例如：周会纪要' : '例如：备忘'}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
            if (event.key === 'Escape') props.onClose();
          }}
        />

        {error !== null && <div className="dsh-notes__err">{error}</div>}

        <div className="dsh-notes__dialog-foot">
          <button type="button" className="dsh-notes__btn" onClick={props.onClose}>
            取消
          </button>
          <button
            type="button"
            className="dsh-notes__btn dsh-notes__btn--primary"
            disabled={name.trim() === '' || busy}
            onClick={() => void submit()}
          >
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 模块级单例（供递归树节点取值，避免逐层透传）
// ---------------------------------------------------------------------------

/**
 * 取路径的目录部分（不依赖 node:path，浏览器里没有）。
 *
 * 同时识别 `/` 与 `\`：Windows 上 host 返回的是反斜杠路径，只认 `/` 会把整个
 * 路径当成文件名。无分隔符时返回空串（相对路径没有目录部分）。
 */
function dirnameOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i <= 0 ? '' : path.slice(0, i);
}

/** 取路径的文件名部分（同时识别 `/` 与 `\`）。 */
function basenameOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i < 0 ? path : path.slice(i + 1);
}

/** 把任意异常转成可展示的中文文案。 */
export function messageOf(error: unknown): string {
  if (error instanceof NotesApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// 右键菜单
// ---------------------------------------------------------------------------

/** 菜单项：普通项或分隔线。 */
type MenuItem = { separator: true } | { separator?: false; label: string; danger?: boolean; onPick: () => void };

/** 右键菜单属性。 */
interface ContextMenuProps {
  /** 屏幕坐标（clientX/clientY）。 */
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * 文件行的右键菜单。
 *
 * 用 fixed 定位并按视口收边，避免贴着屏幕边缘时菜单被切掉。
 * 点空白处、按 Escape、滚动都关闭。
 */
function ContextMenu({ x, y, items, onClose }: ContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current !== null && event.target instanceof Node && ref.current.contains(event.target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // 捕获阶段，保证在别的点击处理之前先关掉。
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  // 先按原始坐标渲染，再在布局后收进视口。
  const [pos, setPos] = useState({ left: x, top: y });
  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const rect = node.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);

  return (
    <div ref={ref} className="dsh-notes__menu" style={{ left: pos.left, top: pos.top }} role="menu">
      {items.map((item, index) =>
        item.separator === true ? (
          // 分隔线用下标做 key：顺序固定，不存在重排。
          <div key={`sep-${index}`} className="dsh-notes__menu-sep" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={`dsh-notes__menu-item${item.danger === true ? ' dsh-notes__menu-item--danger' : ''}`}
            onClick={() => {
              onClose();
              item.onPick();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 确认弹层
// ---------------------------------------------------------------------------

/** 确认弹层属性。 */
interface ConfirmDialogProps {
  title: string;
  message: string;
  /** 补充说明，例如「会移到回收站」。 */
  detail?: string;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** 通用二次确认弹层。 */
function ConfirmDialog(props: ConfirmDialogProps): JSX.Element {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <div className="dsh-notes__mask" onClick={props.onCancel} role="presentation">
      <div className="dsh-notes__dialog" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <h3>{props.title}</h3>
        <p>{props.message}</p>
        {props.detail !== undefined && (
          <p className="dsh-notes__dialog-note">{props.detail}</p>
        )}
        <div className="dsh-notes__dialog-foot">
          <button type="button" className="dsh-notes__btn" onClick={props.onCancel}>
            取消
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`dsh-notes__btn${props.danger === true ? ' dsh-notes__btn--danger' : ' dsh-notes__btn--primary'}`}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
