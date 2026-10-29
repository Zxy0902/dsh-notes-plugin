/**
 * 笔记面板主体：文件夹树 + 置顶区 + tab 栏 + 编辑器/预览。
 *
 * 这是 B 方案（插件接管中间主面板）的界面实现，交互对齐 Typora：
 * - 左侧：切换文件夹按钮、置顶区（最多 6 个，数量自适应）、文件树
 * - 右侧：浏览器式 tab 栏（切换 / × 关闭 / + 新建）、md 左编右渲、txt 单栏
 * - 手动保存：Cmd/Ctrl+S 或保存按钮；未保存时 tab 上显示小圆点
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { NotesApi, type DirEntry, type SkillSummary, type SkillTreeNode } from './api';
import { basenameOf, dirnameOf, isSkillFile, messageOf, revealLabelOf } from './paths';
import { IconFolder, IconSkill } from './icons';
import { EditorPane } from './EditorPane';
import { NotesSidebar } from './Sidebar';
import { ConfirmDialog, ContextMenu, CreateDialog } from './Dialogs';
import { ExternalPane } from './Panes';
import { TabStrip } from './TabStrip';
import { SkillListPane } from './SkillListPane';
import { SkillDetailPane } from './SkillPanes';
import { SkillTreePane } from './SkillTreePane';
import { MAX_PINNED, NotesStore, type NoteTab } from './store';
import { BREAKPOINTS, useElementWidth } from './useElementWidth';

/** 技能目录页那个单例 tab 的固定 id（不用路径，因为它不是文件）。 */
const SKILLS_TAB_ID = 'dsh-notes:skills';

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
   * 正在阅读的一条技能（详情页状态）。
   *
   * 以前这里是 `inlineSkill`，只给「没有文件的内置技能」用；现在**所有**技能
   * 点进去都走详情页：头部有「内容 / 文件」两个切页，正文与文件清单各占一页。
   * 这样技能列表每条就只剩一个入口（点名字进详情），不用在行尾另设按钮。
   *
   * 详情页是独立视图：技能文件只读、没有可保存的目标，做成 tab 会让「保存」
   * 写向不存在的地方。
   */
  /**
   * 左侧文件栏当前显示谁的文件夹。
   *
   * - `null`：显示你自己的笔记目录（默认）；
   * - 有值：正在浏览某条技能，左侧换成它的文件夹树。
   *
   * 由**当前 tab**驱动：切到任何笔记 tab 就自动清空（见下面的 effect），
   * 所以用户不需要记得「退出技能」这件事 —— 点回自己的文件即可。
   */
  const [folderScope, setFolderScope] = useState<{
    /** 技能名。 */
    name: string;
    /** 技能目录。 */
    dir: string;
    /** 当前正在阅读的文件（左侧高亮）。 */
    current: string | null;
  } | null>(null);

  /**
   * 已经主动切到某个技能的文件夹栏了（用户点技能时置真）。
   *
   * 【为什么需要这个标记】「切回笔记就自动恢复笔记目录」是靠比对**当前 tab**
   * 的路径是否落在技能目录里来判断的。但点技能的那一刻，右侧还停在「技能列表」
   * 那个 tab（path 为 null），于是判断立刻得出「不在技能里」→ 把刚设好的技能栏
   * 又清掉，表现就是**左侧闪一下、始终切不过去**。
   *
   * 所以规则改成：只有**用户主动切了 tab**（点击 tab 栏、打开笔记、关闭 tab 等）
   * 才做「是否离开技能」的判定；程序自己切的那一下不算。
   */
  const userLeftSkillRef = useRef(false);

  /** 最近点开的那条技能（内置技能没有目录，靠它记住名字）。 */
  const lastSkillRef = useRef<SkillSummary | null>(null);
  const [skillView, setSkillView] = useState<{
    /** 技能名。 */
    name: string;
    /** 技能目录；内置技能为 null（没有独立文件）。 */
    dir: string | null;
    /** 正文。 */
    content: string | null;
    /** 正文来源路径（`SKILL.md`，或用户在文件页点开的子文件）。 */
    sourcePath: string | null;
    /** 正文读取中。 */
    loading: boolean;
    /** 正文读取失败原因。 */
    error: string | null;
    /** 技能名右边的小标签（「内置」「仅手动」）。 */
    chip: string | null;
  } | null>(null);

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

  /**
   * 离开技能浏览：左侧恢复笔记目录，右侧恢复到你本来在看的笔记。
   *
   * 三处都要走这里，否则会出现「左侧退出了、右侧还停在技能正文」的错位：
   * 1. 点左侧栏顶部的「‹ 笔记」；
   * 2. 切到任意笔记 tab；
   * 3. 回到技能列表。
   *
   * 两侧必须**同时**复位 —— `folderScope` 管左边、`skillView` 管右边，
   * 只清一个就会错位。
   */
  const leaveSkill = useCallback(() => {
    userLeftSkillRef.current = false;
    setFolderScope(null);
    setSkillView(null);
  }, []);

  /** 打开一个文件（点树或点置顶都会走这里）。 */
  const openFile = useCallback(
    (entry: DirEntry) => {
      const kind: 'md' | 'txt' =
        entry.name.toLowerCase().endsWith('.md') || entry.name.toLowerCase().endsWith('.markdown')
          ? 'md'
          : 'txt';
      // 用户主动打开了笔记：直接退出技能浏览，左右一起复位
      // （不能只等 effect —— 那个要等一帧，右侧会先闪一下技能正文）
      leaveSkill();
      // 记下它是从哪个根打开的：切到别的文件夹后，这个 tab 仍要能读能存。
      store.openTab({ id: entry.path, name: entry.name, path: entry.path, kind, root: state.root ?? undefined });
    },
    [store, state.root, leaveSkill],
  );

  /**
   * 读一个技能文件，填进详情页的「内容」切页。
   *
   * 技能文件走专用的只读接口 `readSkillFile`：那条路不需要根目录，也不改
   * 任何文件夹状态。早期试过「为了读技能临时把根切过去」，结果用户真正的
   * 工作目录被顶掉，方向刚好反了。
   *
   * @param path - 文件绝对路径（`SKILL.md` 或子目录里的某个文件）。
   */
  const loadSkillDoc = useCallback(
    (path: string): void => {
      setSkillView((prev) =>
        prev === null ? null : { ...prev, content: null, sourcePath: path, loading: true, error: null },
      );
      api
        .readSkillFile(path)
        .then((file) => {
          setSkillView((prev) =>
            prev === null || prev.sourcePath !== path
              ? prev
              : { ...prev, content: file.content, loading: false, error: null },
          );
        })
        .catch((error: unknown) => {
          setSkillView((prev) =>
            prev === null || prev.sourcePath !== path
              ? prev
              : { ...prev, loading: false, error: messageOf(error) },
          );
        });
    },
    [api],
  );

  /**
   * 点开一条技能：进入**技能详情页**。
   *
   * 详情页里有「内容 / 文件」两个切页：
   * - 内容：`SKILL.md`（或用户在文件页点开的子文件）正文，只读渲染；
   * - 文件：这个技能目录的完整文件树，点一个文件就把它读到内容页。
   *
   * 为什么是「点进详情」而不是「在列表行里展开」：技能的视觉重心是名字，
   * 而展开按钮只能挂在行尾，鼠标要先横跨整行、再折返点文件，来回很累。
   * 现在列表每行只有一个入口，进去之后所有操作都在同一侧。
   *
   * @param skill - 技能页点中的那条摘要。
   */
  const openSkill = useCallback(
    (skill: SkillSummary) => {
      lastSkillRef.current = skill;
      if (skill.path !== undefined) {
        const dir = dirnameOf(skill.path);
        setSkillView({
          name: skill.name,
          dir,
          chip: skill.modelInvocable ? null : '仅手动',
          content: null,
          sourcePath: skill.path,
          loading: true,
          error: null,
        });
        // 左侧整块换成这条技能的文件夹树：之后点任意文件都在这棵树里点。
        // 同时清掉「用户已离开」标记 —— 这一下是**进入**技能，不是离开。
        userLeftSkillRef.current = false;
        setFolderScope({ name: skill.name, dir, current: skill.path });
        loadSkillDoc(skill.path);
        return;
      }

      // 插件内置技能（如 Office 三件套）：磁盘上**没有** path，宿主也不给路径。
      // 正文向宿主换（带列表发的 token）。它没有文件，所以「文件」切页会禁用。
      if (skill.token === undefined) {
        flash('这条技能既没有文件，也拿不到正文');
        return;
      }
      // 内置技能没有目录：左侧保持笔记树，只是右侧显示它的正文
      setFolderScope(null);
      setSkillView({
        name: skill.name,
        dir: null,
        chip: '内置',
        content: null,
        sourcePath: null,
        loading: true,
        error: null,
      });
      api
        .skillContent(skill.token)
        .then((result) => {
          setSkillView((prev) =>
            prev === null || prev.name !== skill.name
              ? prev
              : { ...prev, name: result.name, content: result.content, loading: false },
          );
        })
        .catch((error: unknown) => {
          setSkillView((prev) =>
            prev === null || prev.name !== skill.name
              ? prev
              : { ...prev, loading: false, error: messageOf(error) },
          );
        });
    },
    [api, flash, loadSkillDoc],
  );

  /**
   * 点左侧技能文件夹树里的一个文件：在右侧读它。
   *
   * 只做两件事：更新左侧高亮、把正文换成这个文件。不切 tab、不动笔记目录。
   *
   * 这里**不建 skillView**：左侧技能树只在「已经在浏览某条技能」时才会渲染，
   * 那时 `skillView` 一定已经有值（点技能时就建好了）。以前这里还留了一段
   * 「prev 为 null 就兜一个壳」的代码，实际上是死分支 —— 会让读者以为存在
   * 「直接从文件树进入、没经过技能列表」的路径，其实并不存在。
   *
   * @param node - 文件树里点中的节点。
   */
  const openSkillPath = useCallback(
    (node: SkillTreeNode) => {
      setFolderScope((prev) => (prev === null ? prev : { ...prev, current: node.path }));
      loadSkillDoc(node.path);
    },
    [loadSkillDoc],
  );

  /**
   * 把一个打不开的文件交给系统的「打开方式」。
   *
   * 技能里常见 `.png`、`.xlsx` 这类非文本文件：阅读器读不了，但用户仍可能
   * 想看看它是什么，所以给一个明确的去处，而不是报错。
   *
   * @param path - 文件绝对路径。
   */
  const openSkillBinary = useCallback(
    (path: string) => {
      store.openTab({ id: path, name: basenameOf(path), path, kind: 'external' });
    },
    [store],
  );

  /**
   * 切到笔记 tab 时，让左侧栏自动变回你的笔记目录。
   *
   * 这是「退出技能浏览」的**唯一**方式，也是刻意做成唯一：不做额外的退出按钮，
   * 用户点回任意笔记（或点左侧的「笔记」）就回来了，符合直觉。
   *
   * 判据是「现在看的东西是否还属于这条技能」：
   * - 正在读技能里的某个文件（`skillView` 有值且路径在目录内）：保持技能树；
   * - 已经不在了（切回自己的笔记）：清空，左侧恢复笔记目录。
   *
   * 注意不能只看 `activeTab.path`：浏览技能时右侧是**独立视图**，活动 tab 仍然
   * 停在「技能列表」那个 tab 上（path 为 null）。只看 tab 会把「还在技能里」判成
   * 「已经离开」。
   */
  useEffect(() => {
    if (folderScope === null) return;
    // 用户没动过 tab，不判定 —— 否则「点技能」这一下自己就会被判成离开技能
    if (!userLeftSkillRef.current) return;

    const tabPath = activeTab?.path ?? null;
    const viewPath = skillView?.sourcePath ?? null;
    const insideDir = (path: string | null): boolean =>
      path !== null && path.startsWith(folderScope.dir + '/');

    const inside = insideDir(viewPath) || insideDir(tabPath);
    if (!inside) leaveSkill();
  }, [activeTab, folderScope, skillView, leaveSkill]);

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
    // 重开技能页等于「回到列表」：详情页状态一并清掉。
    setSkillView(null);
    store.openTab(skillsTab);
  }, [store]);

  /**
   * 点技能 tab：它本身是列表页；从技能详情回来时清掉详情状态。
   */
  const activateSkillsTab = useCallback(() => {
    // 回到技能列表就等于离开了某条技能的浏览：左右一起复位
    leaveSkill();
    store.activateTab(SKILLS_TAB_ID);
  }, [store, leaveSkill]);

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
      userLeftSkillRef.current = true;
      leaveSkill();
      store.openTab({ id: path, name, path, kind, root: store.rootForPinned(path) || undefined });
    },
    [store, leaveSkill],
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
      {/* 窗口最上沿那条 14px 留白单独做成拖拽带。
         DSH 的 frame 自己不声明拖拽区（见 ui-web 文档：每个 chrome 行自己标
         data-window-drag），主面板里的页面谁占住窗口顶部，谁就得把那条标出来。
         本面板此前只留白不标，鼠标落在窗口最上沿按下时没有任何元素认领拖拽，
         整个窗口就拖不动了。这条带子只在本平台出现，别处 display:none。 */}
      <div className="dsh-notes__dragband" data-window-drag="" aria-hidden="true" />
      {/* 窄容器下收起文件夹栏，避免左侧固定宽度把编辑区挤没 */}
      {!narrow && folderScope !== null ? (
        /* 正在浏览技能：左侧整块换成这条技能的文件夹树。
           切走（点任意笔记 tab）就自动变回笔记目录 —— 由 folderScope 决定，
           不需要额外的「退出技能」状态。 */
        <SkillTreePane
          api={api}
          name={folderScope.name}
          dir={folderScope.dir}
          current={folderScope.current}
          onPick={(node) => openSkillPath(node)}
          onPickBinary={(node) => openSkillBinary(node.path)}
          onNotice={flash}
        />
      ) : !narrow ? (
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
      ) : null}

      <div className="dsh-notes__right">
        {skillView !== null ? (
          /* 技能详情页是独立视图：技能文件只读、没有可保存的目标，做成 tab 会让
             「保存」写向不存在的地方。关掉回到技能列表 —— 列表与详情共用
             「技能」这一个 tab。 */
          <SkillDetailPane
            name={skillView.name}
            dir={skillView.dir}
            content={skillView.content}
            sourcePath={skillView.sourcePath}
            contentLoading={skillView.loading}
            contentError={skillView.error}
            chip={skillView.chip}
            onBack={leaveSkill}
          />
        ) : (
          <>
            <TabStrip
              tabs={state.tabs}
              activeId={state.activeTabId}
              drafts={state.drafts}
              onActivate={(id) => {
                // 用户主动点了某个 tab：允许「离开技能」的判定生效
                userLeftSkillRef.current = true;
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

