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
import { NotesApi, NotesApiError, type DirEntry, type SkillListing, type SkillSummary } from './api';
import { MAX_PINNED, NotesStore, type FileVisibility, type NoteTab, type PinLayout } from './store';
import { ancestorsOf, filterFiles, listAllDirectories, listAllFiles, type FileHit } from './treeOps';
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

/** 放大镜。 */
function IconSearch({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 13.6 13.6" />
    </svg>
  );
}

/** 定位图标：准星，表示「定位到当前文件」。 */
function IconLocate({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
      <circle cx="8" cy="8" r="5" />
      <path d="M8 1.4v2.2M8 12.4v2.2M1.4 8h2.2M12.4 8h2.2" />
      <circle cx="8" cy="8" r="1.4" />
    </svg>
  );
}

/** 展开图标：上下箭头朝外（Material 的 unfold_more 语义 = 打开全部）。 */
function IconUnfoldMore({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
      <path d="M5 5.2 8 2.2l3 3M11 10.8 8 13.8l-3-3" />
    </svg>
  );
}

/** 收缩图标：上下箭头朝内（Material 的 unfold_less 语义 = 收起全部）。 */
function IconUnfoldLess({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
      <path d="M5 2.6 8 5.6l3-3M11 13.4 8 10.4l-3 3" />
    </svg>
  );
}

/** 刷新图标：带箭头的开口圆环（Material 的 refresh 语义 = 重新读取）。 */
function IconRefresh({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
      <path d="M13.4 8a5.4 5.4 0 1 1-1.6-3.8" />
      <path d="M13.6 1.8v3.2h-3.2" />
    </svg>
  );
}

/**
 * 技能图标：一个带折角的「技能卡」。
 *
 * 与文件图标明确区分开 —— 技能不是文件，用文件图标会让用户以为点开的是
 * 笔记根目录里的东西。
 */
function IconSkill({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
      {/* 卡片主体 + 右上折角 */}
      <path d="M3 2.6h6.2L13 6.4v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9.8a1 1 0 0 1 1-1Z" />
      <path d="M9 2.6v3.8h3.8" />
      {/* 中间一道星芒：表示「可被召唤使用的指令集」 */}
      <path d="M7.5 8.2v3" />
      <path d="M6 9.7h3" />
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

/** 技能目录页那个单例 tab 的固定 id（不用路径，因为它不是文件）。 */
const SKILLS_TAB_ID = 'dsh-notes:skills';

/** 置顶并排所需的最小左栏宽度（px）：低于此值单列，保证文件名可读。 */
const PIN_TWO_COLUMN_MIN_WIDTH = 240;

/**
 * 置顶排序：按下后移动多少像素才算「拖拽」（px）。
 *
 * 小于该距离视为普通点击（打开文件 / 点 × 取消置顶），这样排序不会把点击吃掉。
 */
const PIN_DRAG_THRESHOLD = 4;

/**
 * 「全部展开」最多展开多少个目录。
 *
 * 展开要逐层列目录，超大目录树会遍历很久；到上限就停下并提示用户，
 * 而不是让界面长时间没反应。
 */
const EXPAND_ALL_LIMIT = 500;

/** 定位到文件后，节点高亮多久（毫秒）。 */
const LOCATE_HIGHLIGHT_MS = 1600;

/** 定位时等待树渲染出来的最大帧数（子目录是懒加载，展开后要几帧才出现）。 */
const LOCATE_MAX_FRAMES = 40;

/**
 * 列目录超过这个时间才显示「载入中…」。
 *
 * 本地读一个目录通常几毫秒就返回，若立刻显示占位文案，会从「载入中…」跳到
 * 「空的文件夹」—— 空文件夹最明显，点一下就是一闪。等一小会儿再显示，
 * 快的路径完全无闪，慢的时候仍有反馈。
 */
const SLOW_LISTING_MS = 150;

/** 显示方式的可选项（供 SegmentedControl 使用）。 */
const VIEW_MODE_OPTIONS = [
  { value: 'edit' as const, label: '编辑' },
  { value: 'split' as const, label: '分栏' },
  { value: 'preview' as const, label: '预览' },
];

/**
 * 一个 tab 打开时应该用哪种显示方式。
 *
 * 非 Markdown（txt、外部文件、技能页）永远走编辑态：它们没有渲染概念，
 * 记下来的偏好不该影响它们。
 *
 * @param tab - 要打开的 tab。
 * @param store - 状态仓库，读 `mdViewMode` 偏好。
 * @returns 初始显示方式。
 */
function defaultViewModeFor(tab: NoteTab, store: NotesStore): ViewMode {
  if (tab.kind !== 'md') return 'edit';
  return store.getSnapshot().mdViewMode;
}

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
  /**
   * 「技能」阅读是否启用（插件配置里的开关，默认开）。
   *
   * 关掉后入口与技能页都不出现，整个功能就像不存在一样 —— 这是给
   * 「只想用笔记、不想要额外功能」的用户准备的最小化开关。
   */
  skillsEnabled?: () => Promise<boolean>;
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
  skillsEnabled,
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
   * 技能阅读是否可用。
   *
   * 先按「开」显示：绝大多数用户的配置是开着的，等宿主回话再关，避免入口
   * 闪一下才消失。宿主不支持这个字段（旧版本）时也保持开。
   */
  const [skillsOn, setSkillsOn] = useState(true);

  /** 技能页「重新读取」的转圈反馈（点击后 480ms 内转一圈，与文件树刷新一致）。 */
  const [skillsRefreshing, setSkillsRefreshing] = useState(false);
  /** 技能页的重新读取令牌：递增即让技能页再读一次。 */
  const [skillsRevision, setSkillsRevision] = useState(0);

  /**
   * 从「技能列表」打开过的文件路径集合。
   *
   * 用途：这些文件在阅读器顶部会多一个「← 技能列表」按钮。没有它，
   * 用户根本分不清「我是在看笔记还是在看技能」—— 打开效果和普通文件一模一样。
   */
  const fromSkillsRef = useRef<Set<string>>(new Set());
  /** 上面那个集合的变更计数（集合本身是 ref，改它不会触发重渲染）。 */
  const [fromSkillsRev, setFromSkills] = useState(0);
  /**
   * 正在阅读的内置技能正文（虚拟文档）。
   *
   * 内置技能没有文件，不能做成只读文件 tab：那样「保存」会写向不存在的路径。
   * 单独一块视图、纯只读，关掉就回到原来的 tab。
   */
  const [inlineSkill, setInlineSkill] = useState<
    { name: string; content?: string; loading?: boolean } | null
  >(null);

  /**
   * 本平台是否支持删除（能否移入系统回收站）。
   *
   * 初值 false：**先当作不能用**，等宿主确认后再放开。宁可在极短的首帧里
   * 少一个菜单项，也不要让 Windows 用户看到一个点了会被 403 拒绝的「删除」。
   */
  const [canDelete, setCanDelete] = useState(false);

  /**
   * 本平台是否支持「在系统文件管理器里定位到文件」。
   *
   * 同样以 false 起步、等宿主确认后再放开：Web GUI 等没有桌面能力的场景下
   * `openWorkspacePath` 不可用，此时不该出现一个点了只会弹错的菜单项。
   */
  const [canReveal, setCanReveal] = useState(false);

  /** 宿主平台，用于挑选跟随平台的文案（菜单里的「在访达中打开」等）。 */
  const [platform, setPlatform] = useState<string | null>(null);

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
        if (!alive) return;
        setCanDelete(info.canDelete === true);
        setPlatform(typeof info.platform === 'string' ? info.platform : null);
      })
      .catch(() => {
        // 读不到能力信息时按「不支持」处理，界面少一项总好过点了失败。
      });
    return () => {
      alive = false;
    };
  }, [api]);

  // 问一次「技能阅读」是否启用：关掉就不显示任何技能入口。
  useEffect(() => {
    if (typeof skillsEnabled !== 'function') return;
    let alive = true;
    skillsEnabled()
      .then((value) => {
        if (alive) setSkillsOn(value);
      })
      .catch(() => {
        // 探测失败按开处理：少一个功能入口比整块功能凭空消失更糟。
      });
    return () => {
      alive = false;
    };
  }, [skillsEnabled]);

  // 同一套思路：先问能不能「在系统文件管理器里定位到文件」，不能就不给入口。
  useEffect(() => {
    let alive = true;
    canOpenExternal()
      .then((value) => {
        if (alive) setCanReveal(value);
      })
      .catch(() => {
        // 探测失败按不支持处理（函数内部已兜底，这里只是防御）。
      });
    return () => {
      alive = false;
    };
  }, [canOpenExternal]);

  /**
   * 在系统文件管理器里定位到某个文件。
   *
   * 走官方 `openWorkspacePath({ action: 'reveal' })`（与「不可预览文件」页里的
   * 「显示文件位置」同一个入口），由系统自己决定打开访达/资源管理器/文件管理器。
   */
  const revealFile = useCallback(
    async (path: string) => {
      const error = await openExternal(path, { reveal: true });
      if (error !== null) flash(error);
    },
    [openExternal, flash],
  );

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
      // 记下它是从哪个根打开的：切到别的文件夹后，这个 tab 仍要能读能存。
      store.openTab({ id: entry.path, name: entry.name, path: entry.path, kind, root: state.root ?? undefined });
    },
    [store, state.root],
  );

  /**
   * 从技能目录点开一条技能：在阅读器里打开它的 SKILL.md。
   *
   * 两处与普通文件不同：
   * 1. 技能通常**不在笔记根目录里**（`~/.dsh/skills/...`），而本插件的读写路由
   *    有「必须在选中根目录之内」的围栏，直接写进 tab 的话，编辑器一读就会 404。
   *    所以这里把根切到技能自己所在的目录：围栏仍然生效，只是围成了它的家。
   * 2. tab 名仍然用真实的 `SKILL.md`：`FileTypeIcon` 与文档头都按名字推类型
   *    和显示路径，硬改成 `/技能名` 会让图标与路径都对不上。
   *
   * @param skill - 技能页点中的那条摘要。
   */
  const openSkill = useCallback(
    (skill: SkillSummary) => {
      if (skill.path !== undefined) {
        // 【关键】**完全不碰文件夹**。
        //
        // 早期做法是「为了读文件临时把根切到技能目录」，结果适得其反：
        // 当前文件夹标签变成 `~/.dsh/skills/xxx`，用户真正的工作目录反而
        // 从历史里消失。现在技能文件走专用的只读接口（`readSkillFile`），
        // 那条路不需要根目录、也不改任何文件夹状态。
        //
        // tab 名仍用真实的 SKILL.md 文件名：`FileTypeIcon` 与文档头都按名字推
        // 类型/显示路径，写成 `/技能名` 会被当成无扩展名的文件，图标与路径都错。
        const tab: NoteTab = {
          id: skill.path,
          name: basenameOf(skill.path),
          path: skill.path,
          kind: 'md',
        };
        store.openTab(tab);
        // 记录「是从技能列表进入的」：这样阅读器顶部会出现「← 技能列表」，
        // 而不是让人以为这只是又一个普通笔记文件。
        fromSkillsRef.current.add(skill.path);
        setFromSkills((value) => value + 1);
        return;
      }

      // 插件内置技能（如 Office 三件套）：磁盘上**没有** path，宿主也不给路径。
      // 正文向宿主换（带列表发的 token），在阅读区开一个只读的虚拟文档 ——
      // 它没有真正的文件，所以不放进 tab 列表，避免「保存」写到不存在的地方。
      if (skill.token === undefined) {
        flash('这条技能既没有文件，也拿不到正文');
        return;
      }
      setInlineSkill({ name: skill.name, loading: true });
      api
        .skillContent(skill.token)
        .then((result) => {
          setInlineSkill({ name: result.name, content: result.content });
        })
        .catch((error: unknown) => {
          setInlineSkill(null);
          flash(`读取技能正文失败：${messageOf(error)}`);
        });
    },
    [api, store, flash],
  );

  /**
   * 打开技能目录页。
   *
   * 做成**单例 tab**：不管点多少次，都只有一个「技能」tab，不会开出一排。
   * 这样从某个技能回到列表只需点左边的 tab —— 这正是之前「读完了没法返回、
   * 只能再点一次按钮」的根本解法。
   *
   * 打开前记下当前文件夹与当前 tab：切走时还原，避免「看个技能把笔记目录也换了」。
   */
  const openSkills = useCallback(() => {
    const skillsTab: NoteTab = {
      id: SKILLS_TAB_ID,
      name: '技能',
      path: null,
      kind: 'skills',
    };
    setInlineSkill(null);
    store.openTab(skillsTab);
  }, [store]);

  /**
   * 回到列表：如果「技能」tab 还在就直接切过去，否则重新打开。
   *
   * 从技能回到列表时顺手把文件夹还原 —— 打开技能期间为了读文件切过根目录，
   * 回到列表就该回到原来的笔记目录。
   */
  const backToSkills = useCallback(() => {
    const existing = state.tabs.find((tab) => tab.id === SKILLS_TAB_ID);
    if (existing !== undefined) {
      store.activateTab(SKILLS_TAB_ID);
      return;
    }
    openSkills();
  }, [store, state.tabs, openSkills]);

  /**
   * 点技能 tab：它本身是列表页；从技能正文回来时把文件夹还原。
   */
  const activateSkillsTab = useCallback(() => {
    setInlineSkill(null);
    store.activateTab(SKILLS_TAB_ID);
  }, [store]);

  /** 重新读取技能目录：令牌递增，外加一圈旋转反馈。 */
  const refreshSkills = useCallback(() => {
    setSkillsRevision((value) => value + 1);
    setSkillsRefreshing(true);
    setTimeout(() => setSkillsRefreshing(false), 480);
  }, []);

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

  /** 刷新按钮的短暂旋转反馈（只是视觉提示，不参与刷新逻辑）。 */
  const [refreshing, setRefreshing] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 重新读取文件树。
   *
   * 递增 `treeRevision` 会让每个**已展开**的目录节点重新列自己那一层，
   * 展开状态与滚动位置都保留 —— 所以这是「原地刷新」，不是重建整棵树。
   */
  const refreshTree = useCallback(() => {
    store.refreshTree();
    setRefreshing(true);
    if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
    // 与旋转动画时长对齐，给用户一个「点了确实有反应」的反馈。
    refreshTimer.current = setTimeout(() => setRefreshing(false), 480);
  }, [store]);

  useEffect(
    () => () => {
      if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
    },
    [],
  );

  /**
   * 切回窗口或标签页时自动刷新文件树。
   *
   * 解决的是最常见的那种「树过期」：用外部编辑器（VSCode、备忘录、终端）改了
   * 文件名或增删文件，DSH 收不到任何通知，树里就留着旧条目。
   * 用户改完切回来，这一眼看到的应该是最新的磁盘状态。
   *
   * 刻意**不用定时轮询**：目录大时会持续打请求，还会打断正在进行的展开操作。
   * 也刻意不用宿主 `fs.watch`：跨平台（尤其 Windows）可靠性差，且要新增推送通道，
   * 对「切回来更新一下」这个需求来说过度了。
   */
  useEffect(() => {
    /** 上次自动刷新的时间，用来合并密集的 focus/visibilitychange 事件。 */
    let last = 0;
    const AUTO_REFRESH_MS = 800;

    const refreshIfStale = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const now = Date.now();
      // 切标签页再切回来会连着触发 visibilitychange + focus，合并成一次。
      if (now - last < AUTO_REFRESH_MS) return;
      last = now;
      store.refreshTree();
    };

    window.addEventListener('focus', refreshIfStale);
    document.addEventListener('visibilitychange', refreshIfStale);
    return () => {
      window.removeEventListener('focus', refreshIfStale);
      document.removeEventListener('visibilitychange', refreshIfStale);
    };
  }, [store]);

  /** 从置顶区打开文件。 */
  const openPinned = useCallback(
    (path: string) => {
      // 名字必须走 basenameOf：Windows 上是反斜杠路径，只认 `/` 会把整串路径
      // 当成文件名（标签页标题因此显示全路径）。
      const name = basenameOf(path);
      const lower = name.toLowerCase();
      const kind: 'md' | 'txt' = lower.endsWith('.md') || lower.endsWith('.markdown') ? 'md' : 'txt';
      // 置顶可能是切根之前放上去的，所以不能直接用当前根 —— 先问它属于哪个根。
      store.openTab({ id: path, name, path, kind, root: store.rootForPinned(path) || undefined });
    },
    [store],
  );

  // 没有选中根目录时给一个引导态。
  if (state.root === null) {
    return (
      <div className="dsh-notes">
        {/* 还没选文件夹时的引导页。
            技能不依赖笔记目录，所以这里也给一个入口 —— 但选了文件夹之后，
            技能入口统一收进文件夹下拉，避免左栏出现两处入口。 */}
        <div className="dsh-notes__empty">
          <IconFolder size={30} />
          <h3>还没有选择文件夹</h3>
          <p>选择一个文件夹作为笔记的存放与浏览位置。文件会平铺保存其中，随时可以用外部编辑器打开。</p>
          <div className="dsh-notes__emptyactions">
            <button type="button" className="dsh-notes__btn dsh-notes__btn--primary" onClick={() => void chooseFolder()}>
              选择文件夹
            </button>
            {skillsOn && (
              <button type="button" className="dsh-notes__btn" onClick={openSkills}>
                <IconSkill size={13} />
                看技能
              </button>
            )}
          </div>
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
          onRefreshTree={refreshTree}
          refreshing={refreshing}
          root={state.root}
          pinned={state.pinned}
          expanded={state.expanded}
          activePath={activeTab?.path ?? null}
          onChooseFolder={() => void chooseFolder()}
          onPickRoot={(path) => store.setRoot(path)}
          onForgetRoot={(path) => store.forgetRoot(path)}
          recentRoots={state.recentRoots}
          showSkillsEntry={skillsOn}
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
          onNotice={flash}
          onOpenSkills={skillsOn ? openSkills : undefined}
        />
      )}

      <div className="dsh-notes__right">
        {inlineSkill !== null ? (
          /* 内置技能正文是独立视图：它没有文件，不该占 tab 位，
             也不该给「保存」入口。关掉回到刚才的 tab（通常是技能列表）。 */
          <InlineSkillPane
            name={inlineSkill.name}
            content={inlineSkill.content}
            loading={inlineSkill.loading}
            onClose={backToSkills}
          />
        ) : (
          <>
            <TabStrip
              tabs={state.tabs}
              activeId={state.activeTabId}
              drafts={state.drafts}
              onActivate={(id) => {
                if (id === SKILLS_TAB_ID) activateSkillsTab();
                else store.activateTab(id);
              }}
              onClose={(id) => store.closeTab(id)}
              onCloseOthers={(id) => store.closeOthers(id)}
              onCloseToRight={(id) => store.closeToRight(id)}
              onCloseAll={() => store.closeAll()}
              onCreate={() => setCreating(true)}
              showFolderToggle={narrow}
              onToggleFolder={() => void chooseFolder()}
              root={state.root}
              onMove={(id, slot) => store.moveTab(id, slot)}
            />

            {activeTab === null ? (
              <div className="dsh-notes__empty">
                <h3>没有打开的标签页</h3>
                <p>从左侧文件树选择一个文件，或点右上角的 + 新建笔记。</p>
              </div>
            ) : activeTab.kind === 'skills' ? (
              /* 技能列表本身就是一个 tab：从技能正文回来点它即可，
                 不需要额外的「返回」按钮。 */
              <SkillListPane
                key={skillsRevision}
                api={api}
                onOpen={openSkill}
                onNotice={flash}
                onRefresh={refreshSkills}
                refreshing={skillsRefreshing}
                onClose={() => store.closeTab(SKILLS_TAB_ID)}
              />
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
                // 从技能列表打开的：顶部给一个明确的「← 技能列表」。
                backLabel={
                  // fromSkillsRev 只是让「从技能打开」这个标记变化时重渲染一次。
                  fromSkillsRev >= 0 &&
                  fromSkillsRef.current.has(activeTab.id) &&
                  state.tabs.some((tab) => tab.id === SKILLS_TAB_ID)
                    ? '技能列表'
                    : undefined
                }
                onBack={backToSkills}
              />
            )}
          </>
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
            // 技能文件（SKILL.md）属于 DSH 自己的资产，不是用户的笔记：
            // 置顶会把它混进「我的收藏」，删除更会直接破坏技能。两者都不给。
            ...(isSkillFile(menu.entry.path)
              ? []
              : [
                  {
                    label: state.pinned.includes(menu.entry.path) ? '取消置顶' : '置顶',
                    onPick: () => togglePin(menu.entry.path),
                  },
                ]),
            // 定位与删除都属于「对文件本身的操作」，与上面的打开/置顶用分隔线隔开。
            ...(canReveal || canDelete ? [{ separator: true as const }] : []),
            // 文案跟随平台：系统自己怎么叫就怎么写，用户才知道文件会出现在哪。
            ...(canReveal
              ? [
                  {
                    label: revealLabelOf(platform),
                    onPick: () => void revealFile(menu.entry.path),
                  },
                ]
              : []),
            // 删除只在支持移入系统回收站的平台出现（见 canDelete 的说明），
            // 且技能文件一律不给删除入口。
            ...(canDelete && !isSkillFile(menu.entry.path)
              ? [{ label: '删除', danger: true, onPick: () => setPendingDelete(menu.entry) }]
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

/** 搜索最多展示多少条命中。 */
const SEARCH_LIMIT = 30;
/** 全量文件清单最多收集多少个（超出部分搜不到，给出提示）。 */
const SEARCH_SCAN_LIMIT = 5000;

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

/**
 * 对勾图标（下拉里标记「当前项」）。
 * @param props - 尺寸。
 */
function IconCheck({ size = 11 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} strokeWidth={2.1} aria-hidden="true">
      <path d="M3 8.4 6.4 11.8 13 4.6" />
    </svg>
  );
}

/** 左侧：切换文件夹按钮、置顶区、文件树。 */
function NotesSidebar(props: SidebarProps): JSX.Element {
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
  /** 拖动后把某个 tab 放到新位置（坑位按「摘除后」的数组计）。 */
  onMove: (id: string, slot: number) => void;
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
  const tabsRef = useRef<HTMLDivElement | null>(null);

  /**
   * 正在拖动的 tab id，以及拖动过程中的落点预览。
   *
   * 与置顶区同一套做法（那边踩过两次坑）：
   * 1. 用**指针事件**而不是原生 HTML5 拖拽 —— 原生拖拽会把拖动源从 DOM 里
   *    「摘出来」，一旦重排就触发 dragend，表现为「往后拖不动」。
   * 2. 拖动期间只改 CSS `order` 做**视觉重排**，DOM 顺序纹丝不动，
   *    拖动源永远不会被挪走，也就不会中断拖动。
   */
  const [dragId, setDragId] = useState<string | null>(null);
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null);
  /** 拖动状态放进 ref：指针回调在闭包里读 state 会读到旧值。 */
  const dragRef = useRef<{ id: string; order: string[] } | null>(null);
  /** 刚拖完的那一次 click 要丢掉，否则会误触发「激活」。 */
  const suppressClickRef = useRef(false);

  /** 越过相邻标签多少像素就切换预览（不必拖过中线）。 */
  const DRAG_SWAP_EDGE_PX = 8;

  /**
   * 根据指针横坐标算出落点，并更新预览顺序。
   *
   * 判定用的是**相邻标签的内侧边缘**，不是中线：指针一越过邻居的边缘
   * （再多走几个像素，避免边界抖动）就立刻换位。
   *
   * 为什么不用中线：拖过中线意味着指针已经压到邻居的「后半段」，
   * 视觉上要等很久才动一下，和置顶区的手感不一致。
   * 用边缘则「刚压上去就让位」，与所见即所得一致。
   *
   * @param clientX - 指针横坐标。
   */
  const updateDragOrder = useCallback((clientX: number) => {
    const current = dragRef.current;
    const container = tabsRef.current;
    if (current === null || container === null) return;

    const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-tab-id]'));
    const rest = current.order.filter((id) => id !== current.id);

    // 【关键】用**指针所在的格子**决定落点，而不是「指针相对某个邻居的位置」。
    //
    // 之前按邻居边缘/中线判断，两个方向容易不对称：拖动时邻居靠 CSS order
    // 让位，读到的矩形一直在变，往回拖时判定会差一格（表现为「向左必须拖到
    // 最左边」）。改成「指针落在第几格」之后，左右完全对称：
    // 指针进入某一格 = 目标位置就是那一格。
    //
    // 格子边界用**所有标签（含被拖的）**的矩形取，它们的位置不会因为 order 变化。
    const rects = nodes
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { id: node.getAttribute('data-tab-id'), left: rect.left, right: rect.right };
      })
      .filter((item): item is { id: string; left: number; right: number } => item.id !== null)
      .sort((a, b) => a.left - b.left);

    // 指针越过第 i 个标签的左边界，就说明目标格 >= i；算到最后一个越过的为止。
    let slot = 0;
    for (let i = 0; i < rects.length; i += 1) {
      if (clientX >= rects[i]!.left + DRAG_SWAP_EDGE_PX) slot = i;
    }
    // 被拖标签自己也算一格，但插入点是「摘除后」的下标，所以不能超过 rest 长度。
    slot = Math.max(0, Math.min(slot, rest.length));

    const order = [...rest.slice(0, slot), current.id, ...rest.slice(slot)];
    current.order = order;
    setPreviewOrder(order);
  }, []);

  /** 开始拖动：记录起点并挂全局监听（指针移出标签栏也要继续跟）。 */
  const startTabDrag = useCallback(
    (event: React.MouseEvent, id: string) => {
      // 只认左键；点在关闭按钮上不算拖动。
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest('.dsh-notes__tab-x') !== null) return;

      const order = props.tabs.map((tab) => tab.id);
      dragRef.current = { id, order };
      setDragId(id);
      setPreviewOrder(order);

      let moved = false;
      const onMove = (e: MouseEvent) => {
        // 拖动超过一点距离才算「拖」，否则当成普通点击。
        if (!moved && Math.abs(e.clientX - event.clientX) < 4) return;
        moved = true;
        updateDragOrder(e.clientX);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const final = dragRef.current;
        dragRef.current = null;
        setDragId(null);
        setPreviewOrder(null);
        if (!moved || final === null) return;
        // 拖过就不该再触发一次 onClick 激活。
        suppressClickRef.current = true;
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        // 坑位按下标直接取：moveTab 会先摘除再按这个下标插入，
        // 所以「在最终顺序里的位置」正好就是摘除后数组里的插入点。
        props.onMove(final.id, final.order.indexOf(final.id));
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [props, updateDragOrder],
  );

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
      <div className={`dsh-notes__tabs${dragId !== null ? ' dsh-notes__tabs--reordering' : ''}`} ref={(node) => {
        scrollerRef.current = node;
        tabsRef.current = node;
      }} onScroll={measure}>
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
          // 拖动预览：按预览顺序给 order，DOM 顺序保持不变（见 startTabDrag 的说明）。
          const orderIndex = previewOrder === null ? -1 : previewOrder.indexOf(tab.id);
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              className={`dsh-notes__tab${active ? ' dsh-notes__tab--active' : ''}${dragId === tab.id ? ' dsh-notes__tab--ghost' : ''}${dragId !== null ? ' dsh-notes__tab--dragging' : ''}`}
              title={tab.path ?? tab.name}
              role="button"
              tabIndex={0}
              style={orderIndex >= 0 ? { order: orderIndex } : undefined}
              onMouseDown={(event) => startTabDrag(event, tab.id)}
              onClick={() => {
                if (suppressClickRef.current) return;
                props.onActivate(tab.id);
              }}
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
  /**
   * 有值时在文档头最左侧显示「← 标签」。
   *
   * 用于「从技能列表打开的文件」：它的打开效果与普通笔记完全一样，
   * 不给一个明确去处的话，用户会以为回不去了。
   */
  backLabel?: string | undefined;
  /** 点「←」时的动作。 */
  onBack?: (() => void) | undefined;
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
    // 技能文件走专用只读接口：它不需要根目录，因此在技能 tab 里，
    // 用户当前的笔记文件夹与历史完全不受影响。
    //
    // 普通文件用 **tab 自己的根**，不是当前根：切过文件夹之后，旧 tab 的文件
    // 落在别的根下。同时把「其他已打开文件的根」一并报给宿主，让它知道这些
    // 也是允许范围（否则宿主会按单个根围栏拒绝）。
    const request = isSkillFile(tab.path)
      ? api.readSkillFile(tab.path)
      : api.read(tab.root ?? root, tab.path, store.knownRoots());
    request
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
   * - split：左编辑 + 右预览
   * - edit：只显示编辑框
   * - preview：只显示渲染结果，不渲染编辑框 —— 纯阅读时最省空间也最干净
   *
   * 初值取**用户记住的默认值**（`store.state.mdViewMode`），而不是写死的 split：
   * 习惯只读的人每次打开 md 都要手动切一下，很烦。
   * 这个初值**不使用** useState 的惰性初始化之外的任何同步逻辑 —— 用户在本
   * 面板里切换时走 `chooseView`，那里会同时更新偏好；而「打开另一个文件」时
   * EditorPane 会重新挂载（key 是 tab.id），因此自然读到最新的偏好。
   */
  const [viewMode, setViewMode] = useState<ViewMode>(() => defaultViewModeFor(tab, store));

  /**
   * 切换显示方式，并把它记成默认。
   *
   * 只在**手动切换**时记录：那是用户明确表达的偏好。打开文件时按偏好初始化
   * 不算，否则「split 被初始化成 split」也会写一次盘。
   */
  const chooseView = useCallback(
    (next: ViewMode) => {
      setViewMode(next);
      store.setMdViewMode(next);
    },
    [store],
  );

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

  /**
   * 保存：把草稿写回磁盘。
   *
   * 【顺序很重要】编辑器显示的是 `draft ?? loaded`，`loaded` 是**打开文件时**读到的
   * 那份内容。清掉草稿后 `draft` 变 undefined，显示就会退回 `loaded` —— 也就是
   * 保存前的旧内容，表现为「点保存后界面回滚，切换文件再回来才正常」。
   * 所以必须先把 `loaded` 推进到刚写入的新内容，再清草稿，两步之间没有空档。
   */
  const save = useCallback(async () => {
    if (tab.path === null || !dirty || saving) return;
    setSaving(true);
    try {
      const content = store.getSnapshot().drafts[tab.id] ?? '';
      if (isSkillFile(tab.path)) {
        props.onNotice('技能文件是只读的，不能保存修改');
        return;
      }
      // 与读同一套规则：用 tab 自己的根，并把其他已打开文件的根一并报上去。
      await api.write(tab.root ?? root, tab.path, content, store.knownRoots());
      // 先更新基线，再清草稿：否则中间那一帧会显示旧内容。
      setLoaded(content);
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
        {/* 从技能列表打开的文件：最左边给一个明确的返回入口。 */}
        {props.backLabel !== undefined && props.onBack !== undefined && (
          <button
            type="button"
            className="dsh-notes__back"
            title={`回到${props.backLabel}`}
            onClick={props.onBack}
          >
            ← {props.backLabel}
          </button>
        )}
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
            // 走 chooseView 而不是裸 setViewMode：切换的同时记住为默认，
            // 下次打开任何 md 都从这一种开始。
            onChange={chooseView}
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
// 内置技能正文（只读）
// ---------------------------------------------------------------------------

/** 内置技能阅读视图属性。 */
interface InlineSkillProps {
  name: string;
  /** 正文；loading 为 true 时还没有。 */
  content?: string;
  loading?: boolean;
  /** 关掉、回到刚才的笔记。 */
  onClose: () => void;
}

/**
 * 插件内置技能的正文（Office 三件套等）。
 *
 * 这类技能磁盘上没有 `SKILL.md`，正文由 DSH 注册表在内存里给出，所以：
 * - **只读**：没有编辑框、没有保存按钮 —— 没有文件可存，给了保存反而是陷阱；
 * - **不进 tab 列表**：它不是一个文件，关闭就是回到之前的样子。
 */
function InlineSkillPane(props: InlineSkillProps): JSX.Element {
  const { name, content, loading, onClose } = props;
  return (
    <div className="dsh-notes__skillpane">
      <div className="dsh-notes__skillhead">
        <div className="dsh-notes__skilltitle">
          <IconSkill size={14} />
          <code className="dsh-notes__inlineskill-name">/{name}</code>
          <span className="dsh-notes__skilltag">内置</span>
        </div>
        <span className="dsh-notes__skillsearch dsh-notes__inlineskill-note">
          由 DSH 插件提供，只读
        </span>
        <button
          type="button"
          className="dsh-notes__treebtn"
          title="关闭，回到刚才的笔记"
          aria-label="关闭技能"
          onClick={onClose}
        >
          <IconClose size={11} />
        </button>
      </div>
      <div className="dsh-notes__skillbody">
        {loading === true ? (
          <div className="dsh-notes__hint">正在读取…</div>
        ) : (
          <div className="dsh-notes__preview">
            <MarkdownText text={content ?? ''} labels={MARKDOWN_LABELS} variant="body" />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 技能目录页
// ---------------------------------------------------------------------------

/** 技能目录页属性。 */
interface SkillListPaneProps {
  api: NotesApi;
  /**
   * 点某条技能时调用。
   *
   * 由外壳决定怎么打开：有 `path` 的走阅读器（读 SKILL.md），没有文件的
   * （插件内置技能）只给提示。
   */
  onOpen: (skill: SkillSummary) => void;
  /** 在面板顶部做成一次性提示。 */
  onNotice: (message: string) => void;
  /** 重新读一遍技能目录（在外部新建了技能后点）。 */
  onRefresh: () => void;
  /** 重新读取进行中（转圈反馈）。 */
  refreshing: boolean;
  /** 关掉技能页、回到刚才的笔记（右上角 ×）。 */
  onClose: () => void;
}

/**
 * 技能目录页：列出当前可用的 skill，点一条在阅读器里看它的 SKILL.md 全文。
 *
 * 两个刻意的设计：
 * 1. **只读**。本插件不启用/禁用 skill、不改任何文件 —— 那是 skill 管理插件的事，
 *    这里只回答「它写了什么」，避免两套开关互相打架。
 * 2. **不自己解析文件**。列表来自 DSH 官方 skill 注册表（宿主半边去问），
 *    正文复用本插件现成的文件读取，所以看到的内容与 Agent 实际加载的完全一致。
 */
function SkillListPane(props: SkillListPaneProps): JSX.Element {
  const { api, onOpen, onNotice, onRefresh, refreshing, onClose } = props;
  const [listing, setListing] = useState<SkillListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  /** 首次读取未完成时先不渲染列表，避免「空 → 有内容」闪一下。 */
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (fresh: boolean): void => {
      setLoading(true);
      api
        .skills()
        .then((result) => {
          setListing(result);
          setError(null);
          if (fresh) {
            const count = result.skills.length;
            onNotice(count === 0 ? '没有发现技能' : `已读取 ${count} 个技能`);
          }
        })
        .catch((err: unknown) => {
          setError(messageOf(err));
          if (fresh) onNotice(`读取技能失败：${messageOf(err)}`);
        })
        .finally(() => setLoading(false));
    },
    [api, onNotice],
  );

  // 进页面读一次；宿主那边有注册表就一定有结果，不需要轮询。
  useEffect(() => {
    load(false);
  }, [load]);

  const skills = listing?.skills ?? [];
  const icons = listing?.icons ?? {};

  /** 按名称/描述过滤（本地过滤，不必再打一次宿主）。 */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return skills;
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q),
    );
  }, [skills, query]);

  /**
   * 分成「系统内置」与「我的」两组。
   *
   * 内置技能是随 DSH 或其插件自带的（Office 三件套等），数量固定、用户改不了；
   * 用户自己的才是他真正关心的。混在一起时，内置的往往按字母排在前面，
   * 把自己写的挤到看不见的地方。
   */
  const groups = useMemo(() => {
    const bundled = shown.filter((skill) => skill.source === 'bundled');
    const mine = shown.filter((skill) => skill.source !== 'bundled');
    return { bundled, mine };
  }, [shown]);

  /**
   * 取某条技能自带的图标（宿主按「目录 + 相对路径」索引）。
   *
   * 目录优先用 `resourceBase`（内置技能只有它），再退到 SKILL.md 所在目录。
   */
  const iconFor = (skill: SkillSummary): string | null => {
    const dirs: string[] = [];
    if (skill.resourceDir !== undefined) dirs.push(skill.resourceDir);
    if (skill.path !== undefined) {
      const dir = dirnameOf(skill.path);
      if (!dirs.includes(dir)) dirs.push(dir);
    }
    for (const dir of dirs) {
      for (const rel of ['assets/icon.svg', 'assets/icon.png', 'icon.svg', 'icon.png']) {
        const found = icons[`${dir}\u0000${rel}`];
        if (found !== undefined) return found;
      }
    }
    return null;
  };

  /** 渲染一条技能（两组共用，避免两处样式走样）。 */
  const renderItem = (skill: SkillSummary): JSX.Element => {
    const icon = iconFor(skill);
    // 「内置」= 插件提供的技能，磁盘上没有 SKILL.md，正文由宿主从注册表取。
    const builtin = skill.path === undefined;
    return (
      <button
        type="button"
        className="dsh-notes__skillitem"
        title={skill.path ?? `${skill.name}（插件内置，正文由 DSH 提供）`}
        onClick={() => onOpen(skill)}
      >
        <span className="dsh-notes__skillicon">
          {icon === null ? <IconSkill size={15} /> : <img src={icon} alt="" width={16} height={16} />}
        </span>
        <span className="dsh-notes__skilltext">
          <span className="dsh-notes__skillname">
            <code>/{skill.name}</code>
            {!skill.modelInvocable && (
              <span className="dsh-notes__skilltag" title="只允许用户手动调用">
                仅手动
              </span>
            )}
            {builtin && (
              <span className="dsh-notes__skilltag" title="由插件内置，没有独立文件；正文仍可在这里查看">
                内置
              </span>
            )}
          </span>
          <span className="dsh-notes__skilldesc">{skill.description}</span>
        </span>
      </button>
    );
  };

  return (
    <div className="dsh-notes__skillpane">
      <div className="dsh-notes__skillhead">
        <div className="dsh-notes__skilltitle">
          <IconSkill size={14} />
          技能
          {listing !== null && <span className="dsh-notes__skillcount">{skills.length}</span>}
        </div>
        <div className="dsh-notes__skillsearch">
          <input
            className="dsh-notes__skillinput"
            type="search"
            placeholder="按名称或说明筛选"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="筛选技能"
          />
        </div>
        {/* 技能目录在磁盘上、由 DSH 热监听；但清单是「进页面时读一次」的，
            外部刚加了技能文件时点这里重读，免得用户以为没生效。 */}
        <button
          type="button"
          className={refreshing ? 'dsh-notes__treebtn dsh-notes__treebtn--spin' : 'dsh-notes__treebtn'}
          title="重新读取技能目录"
          aria-label="重新读取技能目录"
          onClick={onRefresh}
        >
          <IconRefresh />
        </button>
        <button
          type="button"
          className="dsh-notes__treebtn"
          title="关闭技能，回到刚才的笔记"
          aria-label="关闭技能"
          onClick={onClose}
        >
          <IconClose size={11} />
        </button>
      </div>

      <div className="dsh-notes__skillbody">
        {loading && listing === null && <div className="dsh-notes__hint">正在读取技能…</div>}

        {error !== null && (
          <div className="dsh-notes__skillerror">
            读取技能失败：{error}
            <button type="button" className="dsh-notes__btn" onClick={() => load(false)}>
              重试
            </button>
          </div>
        )}

        {listing !== null && !listing.available && (
          <div className="dsh-notes__skillempty">
            <h3>当前环境没有安装技能功能</h3>
            <p>
              技能列表由 DSH 的技能插件提供。这个环境没有加载它，所以这里暂时看不到内容；
              笔记本身的读写不受影响。
            </p>
          </div>
        )}

        {listing !== null && listing.available && shown.length === 0 && (
          <div className="dsh-notes__skillempty">
            <h3>{query.trim() === '' ? '还没有技能' : '没有匹配的技能'}</h3>
            <p>
              {query.trim() === ''
                ? '把技能写成 ~/.dsh/skills/<名称>/SKILL.md，或放进项目的 .dsh/skills/ 下，这里就会出现。'
                : '换个关键词试试。'}
            </p>
          </div>
        )}

        {/* 两组分开：内置在上（数量固定、不可改），自己的在下（用户真正关心的）。 */}
        {groups.bundled.length > 0 && (
          <div className="dsh-notes__skillgroup">
            <div className="dsh-notes__skillgroup-head">
              系统内置
              <span className="dsh-notes__skillgroup-count">{groups.bundled.length}</span>
            </div>
            <ul className="dsh-notes__skilllist">
              {groups.bundled.map((skill) => (
                <li key={skill.name}>{renderItem(skill)}</li>
              ))}
            </ul>
          </div>
        )}

        {groups.mine.length > 0 && (
          <div className="dsh-notes__skillgroup">
            <div className="dsh-notes__skillgroup-head">
              我的技能
              <span className="dsh-notes__skillgroup-count">{groups.mine.length}</span>
            </div>
            <ul className="dsh-notes__skilllist">
              {groups.mine.map((skill) => (
                <li key={skill.name}>{renderItem(skill)}</li>
              ))}
            </ul>
          </div>
        )}

        {/* 诊断行：只回答「这些技能是哪来的、按哪个目录找的」。
            真实环境里出现过「只列出内置技能」的报障，而本地用同一个注册表能全列出来，
            把来源摆出来比让人猜快得多。 */}
        {listing !== null && listing.available && (
          <div className="dsh-notes__skillfoot">
            {listing.skills.length} 条 · 供出 {listing.providers?.length ? listing.providers.join('、') : '未知'}
            {' · 登记 '}
            {listing.registeredProviders?.length ? listing.registeredProviders.join('、') : '无'}
            {listing.askedCwd !== undefined && ` · 工作目录 ${listing.askedCwd}`}
            {listing.complete === false && ' · 部分来源读取失败，列表可能不全'}
          </div>
        )}
      </div>
    </div>
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

/**
 * 这个路径是不是「技能文件」（技能目录里的 `SKILL.md`）。
 *
 * 判据刻意用**路径**而不是「是不是从技能页打开的」：
 * 同一个 SKILL.md 也可能从文件树直接点开、或本来就在置顶里，
 * 按来源判断会漏掉那些情况。技能文件一律不给置顶/删除入口。
 *
 * @param path - 文件绝对路径。
 * @returns 是技能文件则为 true。
 */
function isSkillFile(path: string): boolean {
  const base = basenameOf(path).toLowerCase();
  if (base !== 'skill.md') return false;
  // 目录里带 `.dsh/skills` 或 `.agents/skills` 段，才认定是技能根。
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/.dsh/skills/') || normalized.includes('/.agents/skills/');
}

/** 取路径的文件名部分（同时识别 `/` 与 `\`）。 */
function basenameOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i < 0 ? path : path.slice(i + 1);
}

/**
 * 「在系统文件管理器里定位到文件」这项菜单的文案。
 *
 * 各平台对这个动作的叫法不同（macOS 的访达、Windows 的资源管理器、Linux 各家
 * 文件管理器），用系统自己的说法，用户一眼就知道文件会出现在哪里。宿主没报
 * 平台时用通用说法兜底。
 */
function revealLabelOf(platform: string | null): string {
  if (platform === 'darwin') return '在访达中打开';
  if (platform === 'win32') return '打开文件所在位置';
  return '在文件管理器中显示';
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
