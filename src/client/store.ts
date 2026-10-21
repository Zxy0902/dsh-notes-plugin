/**
 * 笔记面板的状态仓库。
 *
 * 这是你要的「记忆功能」：tab 列表、当前 tab、置顶列表、展开的目录、根目录、
 * 滚动位置都存在这里，并写入 localStorage。DSH 的中间主面板会在打开会话时切回
 * 对话，笔记面板被顶掉后再回来，状态从这份仓库原样恢复。
 *
 * 同时它是「未保存草稿」的唯一持有者：编辑中的内容不落盘，切 tab 也不丢，
 * 只有 Cmd+S / 保存按钮才写回文件。
 */

/** 一个打开的 tab。 */
export interface NoteTab {
  /** 稳定 id（用文件绝对路径，或新建草稿的临时 id）。 */
  id: string;
  /** 文件名（tab 上显示）。 */
  name: string;
  /** 文件绝对路径；新建草稿在保存前为 null。 */
  path: string | null;
  /**
   * 文件类型：
   * - `md` 走左编右渲；
   * - `txt` 走单栏编辑；
   * - `external` 阅读器打不开（.doc/.pdf/.sql 等），只显示提示 + 「打开方式」控件。
   *
   * 技能的 SKILL.md 也走 `md`（它就是 markdown），不单列一种类型 —— 少一种
   * 类型就少一处要同步的分支。技能与笔记的区别只在「怎么打开的」。
   * - `skills` 是技能目录页本身（单例 tab）。把它做成 tab 而不是独立视图，
   *   是为了让「看过某个技能、想回到列表」有天然的返回路径：点左边的 tab 即可。
   */
  kind: 'md' | 'txt' | 'external' | 'skills';
}

/** 文件夹历史最多保留几个。太多会让下拉变成又一份文件树。 */
export const MAX_RECENT_ROOTS = 8;

/** 面板的持久状态。 */
export interface NotesState {
  /** 用户选中的根目录（浏览范围）。 */
  root: string | null;
  /**
   * 最近用过的文件夹（最近一次在最前，不含当前的 `root`）。
   *
   * 多工作区场景下反复弹系统选择框成本很高，所以把历史留在下拉里直接切换；
   * 每项可以单独删除（只删记录，不碰磁盘）。
   */
  recentRoots: string[];
  /** 打开的 tab。 */
  tabs: NoteTab[];
  /** 当前激活的 tab id。 */
  activeTabId: string | null;
  /** 置顶的文件路径（最多 6 个）。 */
  pinned: string[];
  /** 展开的目录路径集合。 */
  expanded: string[];
  /** 每个 tab 的滚动位置。 */
  scroll: Record<string, number>;
  /** 每个 tab 的未保存草稿；键是 tab id。 */
  drafts: Record<string, string>;
  /**
   * 文件树可见范围：
   * - `editable`：只列出能在阅读器里打开的文件（默认，行为与之前一致）；
   * - `all`：连同 .doc/.pdf 这类不可阅读的文件一起列出，点它们用系统默认程序打开。
   */
  fileVisibility: FileVisibility;
  /**
   * 打开 Markdown 文件时的默认展示方式（分栏 / 编辑 / 阅读）。
   *
   * 与 `fileVisibility` 一样是全局偏好：立刻落盘，下一次打开 md 沿用。
   */
  mdViewMode: MdViewMode;
  /**
   * 置顶区排版：`one` 单栏（每项一行，文件名完整可读）或 `two` 双栏（省空间）。
   * 默认 `two`（与历史行为一致）。
   */
  pinLayout: PinLayout;
  /**
   * 文件树刷新令牌。
   *
   * 目录内容是存在各树节点自己的 state 里的（懒加载、按展开状态拉取），
   * 所以「新建了文件」这类外部变化不会自动反映到树上。递增这个值并让树节点
   * 订阅它，就能在需要时强制重新列目录，而不必重建整棵树。
   *
   * 它是纯运行期信号，不持久化。
   */
  treeRevision: number;
}

/** 置顶上限。 */
export const MAX_PINNED = 6;

/** 文件树可见范围。 */
export type FileVisibility = 'editable' | 'all';

/**
 * 打开 Markdown 文件时的默认展示方式。
 *
 * - `split`：左编辑 + 右预览（历史行为，默认值保持不变）
 * - `edit`：只显示编辑器
 * - `preview`：只显示渲染结果
 *
 * 这是**跨文件的全局偏好**：用户选了「阅读」之后，下次打开任何 md 都还是阅读。
 * 与「当前这个 tab 临时切一下」是两件事 —— 后者不落盘，见面板里的 viewMode。
 */
export type MdViewMode = 'split' | 'edit' | 'preview';

/** 置顶区排版。 */
export type PinLayout = 'one' | 'two';

/** localStorage 键名（带版本，便于后续迁移）。 */
const STORAGE_KEY = 'dsh.notes.v1';

/** 初始状态。 */
function emptyState(): NotesState {
  return {
    root: null,
    recentRoots: [],
    tabs: [],
    activeTabId: null,
    pinned: [],
    expanded: [],
    scroll: {},
    drafts: {},
    fileVisibility: 'editable',
    mdViewMode: 'split',
    pinLayout: 'two',
    treeRevision: 0,
  };
}

/** 校验并规范从 localStorage 读回的状态；坏数据只丢自己，不拖垮面板。 */
function reviveState(raw: unknown): NotesState {
  const base = emptyState();
  if (typeof raw !== 'object' || raw === null) return base;
  const input = raw as Partial<NotesState>;

  const tabs: NoteTab[] = [];
  if (Array.isArray(input.tabs)) {
    for (const item of input.tabs) {
      if (typeof item !== 'object' || item === null) continue;
      const tab = item as Partial<NoteTab>;
      if (typeof tab.id !== 'string' || typeof tab.name !== 'string') continue;
      if (tab.kind !== 'md' && tab.kind !== 'txt' && tab.kind !== 'external' && tab.kind !== 'skills') continue;
      const path = typeof tab.path === 'string' ? tab.path : null;
      // external tab 完全以路径为身份，没有路径就无法恢复，直接丢弃。
      if (tab.kind === 'external' && path === null) continue;
      tabs.push({ id: tab.id, name: tab.name, path, kind: tab.kind });
    }
  }

  const ids = new Set(tabs.map((tab) => tab.id));
  const activeTabId =
    typeof input.activeTabId === 'string' && ids.has(input.activeTabId) ? input.activeTabId : (tabs[0]?.id ?? null);

  const recentRoots = Array.isArray(input.recentRoots)
    ? input.recentRoots
        .filter((item): item is string => typeof item === 'string' && item !== '')
        .slice(0, MAX_RECENT_ROOTS)
    : [];

  const pinned = Array.isArray(input.pinned)
    ? input.pinned.filter((p): p is string => typeof p === 'string').slice(0, MAX_PINNED)
    : [];

  const expanded = Array.isArray(input.expanded)
    ? input.expanded.filter((p): p is string => typeof p === 'string')
    : [];

  const scroll: Record<string, number> = {};
  if (typeof input.scroll === 'object' && input.scroll !== null) {
    for (const [key, value] of Object.entries(input.scroll)) {
      if (typeof value === 'number' && Number.isFinite(value)) scroll[key] = value;
    }
  }

  const drafts: Record<string, string> = {};
  if (typeof input.drafts === 'object' && input.drafts !== null) {
    for (const [key, value] of Object.entries(input.drafts)) {
      if (typeof value === 'string') drafts[key] = value;
    }
  }

  return {
    root: typeof input.root === 'string' ? input.root : null,
    recentRoots,
    tabs,
    activeTabId,
    pinned,
    expanded,
    scroll,
    drafts,
    // 旧版本数据没有这个字段，回落到默认值，不影响已有用户的记忆。
    fileVisibility: input.fileVisibility === 'all' ? 'all' : 'editable',
    // 旧数据没有这个字段：回落到 split，与历史行为一致。
    mdViewMode:
      input.mdViewMode === 'edit' ? 'edit' : input.mdViewMode === 'preview' ? 'preview' : 'split',
    pinLayout: input.pinLayout === 'one' ? 'one' : 'two',
    treeRevision: 0,
  };
}

/** 读一次持久状态。 */
function load(): NotesState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return emptyState();
    return reviveState(JSON.parse(raw) as unknown);
  } catch {
    // 隐私模式 / 配额错误 / 坏 JSON：退化成内存态，面板照常可用。
    return emptyState();
  }
}

/**
 * 面板状态仓库：极简的外部 store + 订阅，配 React 的 useSyncExternalStore。
 */
export class NotesStore {
  private state: NotesState = load();

  private readonly listeners = new Set<() => void>();

  /** 写盘时的防抖句柄。 */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  /** 读取当前快照（引用稳定，直到下次提交）。 */
  getSnapshot = (): NotesState => this.state;

  /** 订阅变更。 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * 提交一份新状态并通知订阅者。
   *
   * @param immediate - true 表示结构性变更（开/关 tab、置顶、切根目录），
   *   立即落盘；false（默认）走防抖，供打字/滚动这类高频更新使用。
   *   结构性变更必须立即写：否则用户在 400ms 内刷新或切走，状态就丢了。
   */
  private commit(next: NotesState, immediate = false): void {
    this.state = next;
    for (const listener of this.listeners) listener();
    if (immediate) this.persistNow();
    else this.schedulePersist();
  }

  /** 立即写盘。 */
  private persistNow(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // 配额不足等写入失败不影响内存态。
    }
  }

  /**
   * 清掉持久化状态（卸载插件时用）。
   *
   * 目的是「不留痕迹」：DSH 的卸载只做 `pnpm remove` + 重载组合，
   * 不会碰浏览器存储。不清的话，tab / 置顶 / 文件夹历史会一直留在
   * localStorage 里，重装后突然「复活」一批可能已失效的旧路径。
   *
   * 只清存储、不动内存态：插件正在卸载，界面马上就要消失，
   * 这时候把内存清空反而可能触发一次无意义的重渲染报错。
   */
  clearPersistedState(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // 存储不可用就不用清：本来也没写进去。
    }
  }

  /** 防抖落盘：输入过程中不写 localStorage，停手 400ms 再写。 */
  private schedulePersist(): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 400);
  }

  /**
   * 页面卸载前把未落盘的改动补写一次。
   *
   * 返回释放函数；面板卸载时应调用，避免监听器泄漏。
   */
  attachFlushOnUnload(): () => void {
    if (typeof window === 'undefined') return () => {};
    const flush = () => this.persistNow();
    window.addEventListener('beforeunload', flush);
    // 页面进后台（切标签页/移动端切走）也补写一次，比 beforeunload 更可靠。
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
    };
  }

  // -------------------------------------------------------------------------
  // 根目录
  // -------------------------------------------------------------------------

  /**
   * 切换浏览根目录：清空 tab 之外的浏览状态，避免残留别的目录的树。
   *
   * 同时把这个目录推进历史（最近的在最前，去掉重复、去掉它自己），
   * 这样「换回去」不必再弹一次系统选择框。
   *
   * @param root - 新根目录。
   * @param options - `{ remember: false }` 表示这次切换不进历史。
   *   「打开技能时临时换根」就走这个：技能目录不是用户的工作区，
   *   把它塞进历史会污染下拉列表、也顶掉用户真正用过的目录。
   */
  setRoot(root: string, options: { remember?: boolean } = {}): void {
    if (this.state.root === root) return;
    const remember = options.remember !== false;
    const previous = this.state.root;
    if (typeof console !== 'undefined' && (globalThis as { __NOTES_DEBUG__?: boolean }).__NOTES_DEBUG__) {
      console.log('[notes][setRoot]', { from: previous, to: root, remember, recent: this.state.recentRoots });
    }
    const recentRoots = remember
      ? [previous, ...this.state.recentRoots].filter(
          (item): item is string => typeof item === 'string' && item !== '' && item !== root,
        )
      : this.state.recentRoots;
    // 去重（同一个目录可能出现在不同位置）。
    const unique = [...new Set(recentRoots)].slice(0, MAX_RECENT_ROOTS);
    this.commit({ ...this.state, root, recentRoots: unique, expanded: [], scroll: {} }, true);
  }

  /**
   * 从历史里删掉一个文件夹。
   *
   * 只删这条记录，不碰磁盘、也不影响当前根。
   *
   * @param path - 要忘记的目录。
   */
  forgetRoot(path: string): void {
    if (!this.state.recentRoots.includes(path)) return;
    this.commit(
      { ...this.state, recentRoots: this.state.recentRoots.filter((item) => item !== path) },
      true,
    );
  }

  /**
   * 切换文件树的可见范围。
   *
   * 立即落盘：这是用户的显式偏好，下次打开应当保持，不能因为 400ms 内刷新而丢。
   */
  setFileVisibility(mode: FileVisibility): void {
    if (this.state.fileVisibility === mode) return;
    this.commit({ ...this.state, fileVisibility: mode }, true);
  }

  /**
   * 记住 Markdown 的默认展示方式。
   *
   * 立即落盘：这是用户的显式偏好，下次打开 md 沿用，不能因为 400ms 内刷新而丢。
   */
  setMdViewMode(mode: MdViewMode): void {
    if (this.state.mdViewMode === mode) return;
    this.commit({ ...this.state, mdViewMode: mode }, true);
  }

  /**
   * 切换置顶区排版：单栏（每项一行，看得全）或双栏（省纵向空间）。
   *
   * 立即落盘：显式偏好，下次打开应当保持。旧版本数据没有这个字段，
   * reviveState 会回落到默认值，不影响已有用户。
   */
  setPinLayout(layout: PinLayout): void {
    if (this.state.pinLayout === layout) return;
    this.commit({ ...this.state, pinLayout: layout }, true);
  }

  // -------------------------------------------------------------------------
  // tab
  // -------------------------------------------------------------------------

  /** 打开（或聚焦）一个文件 tab。 */
  openTab(tab: NoteTab): void {
    const existing = this.state.tabs.find((item) => item.id === tab.id);
    if (existing !== undefined) {
      this.commit({ ...this.state, activeTabId: existing.id }, true);
      return;
    }
    this.commit({ ...this.state, tabs: [...this.state.tabs, tab], activeTabId: tab.id }, true);
  }

  /** 关闭一个 tab：同时丢弃它的草稿与滚动记忆。 */
  closeTab(id: string): void {
    const index = this.state.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;

    const tabs = this.state.tabs.filter((tab) => tab.id !== id);
    // 关掉当前 tab 时，落到它左边那个；没有左边就落到新的第一个。
    let activeTabId = this.state.activeTabId;
    if (activeTabId === id) {
      activeTabId = tabs[Math.max(0, index - 1)]?.id ?? null;
    }

    const drafts = { ...this.state.drafts };
    delete drafts[id];
    const scroll = { ...this.state.scroll };
    delete scroll[id];

    this.commit({ ...this.state, tabs, activeTabId, drafts, scroll }, true);
  }

  /**
   * 关闭若干 tab（批量入口）。
   *
   * 单个关闭的语义（落到左边那个）在这里不适用：批量关闭是用户明确指定的
   * 集合，被保留下来的 tab 顺序不变。若当前 tab 被关掉，就落到保留集合里
   * 离它最近的一个 —— 优先右边（视觉上更贴近原来位置），没有再取左边。
   *
   * @param ids - 要关闭的 tab id 集合。
   * @param preferId - 保留集合中优先激活的 id（关闭其他时用，通常是右键的那个）。
   */
  private closeMany(ids: Set<string>, preferId?: string): void {
    if (ids.size === 0) return;

    const removed = this.state.tabs.filter((tab) => ids.has(tab.id));
    if (removed.length === 0) return;

    const tabs = this.state.tabs.filter((tab) => !ids.has(tab.id));

    let activeTabId = this.state.activeTabId;
    if (activeTabId !== null && ids.has(activeTabId)) {
      // 被关掉的当前 tab 在原数组里的位置，用于找最近的保留项。
      const at = this.state.tabs.findIndex((tab) => tab.id === activeTabId);
      const right = this.state.tabs.slice(at + 1).find((tab) => !ids.has(tab.id));
      const left = this.state.tabs.slice(0, at).reverse().find((tab) => !ids.has(tab.id));
      activeTabId = (right ?? left)?.id ?? null;
    }

    // 指定的保留项优先激活（它一定还在 tabs 里）。
    if (preferId !== undefined && tabs.some((tab) => tab.id === preferId)) {
      activeTabId = preferId;
    }

    const drafts = { ...this.state.drafts };
    const scroll = { ...this.state.scroll };
    for (const tab of removed) {
      delete drafts[tab.id];
      delete scroll[tab.id];
    }

    this.commit({ ...this.state, tabs, activeTabId, drafts, scroll }, true);
  }

  /** 关闭除 id 之外的全部 tab，并把 id 置为当前。 */
  closeOthers(id: string): void {
    if (!this.state.tabs.some((tab) => tab.id === id)) return;
    const ids = new Set(this.state.tabs.filter((tab) => tab.id !== id).map((tab) => tab.id));
    this.closeMany(ids, id);
  }

  /** 关闭 id 右侧的全部 tab。 */
  closeToRight(id: string): void {
    const at = this.state.tabs.findIndex((tab) => tab.id === id);
    if (at < 0) return;
    const ids = new Set(this.state.tabs.slice(at + 1).map((tab) => tab.id));
    this.closeMany(ids);
  }

  /** 关闭全部 tab。 */
  closeAll(): void {
    this.closeMany(new Set(this.state.tabs.map((tab) => tab.id)));
  }

  /** 聚焦一个 tab。 */
  activateTab(id: string): void {
    if (this.state.activeTabId === id) return;
    if (!this.state.tabs.some((tab) => tab.id === id)) return;
    this.commit({ ...this.state, activeTabId: id }, true);
  }

  /** 把草稿写回 tab 的正式内容（保存成功后调用）。 */
  clearDraft(id: string): void {
    if (!(id in this.state.drafts)) return;
    const drafts = { ...this.state.drafts };
    delete drafts[id];
    this.commit({ ...this.state, drafts });
  }

  /** 记录某个 tab 的未保存草稿。 */
  setDraft(id: string, content: string): void {
    if (this.state.drafts[id] === content) return;
    this.commit({ ...this.state, drafts: { ...this.state.drafts, [id]: content } });
  }

  /**
   * 记住某个 tab 的滚动位置。
   *
   * 滚动是高频事件，所以这里**不通知订阅者**：只静默改内存状态并排一次落盘。
   * 否则每滚一像素都会触发 NotesPanel 重渲染，长文档下纯属浪费 ——
   * 而滚动位置本身不影响任何已渲染的内容。
   */
  setScroll(id: string, top: number): void {
    if (this.state.scroll[id] === top) return;
    this.state = { ...this.state, scroll: { ...this.state.scroll, [id]: top } };
    this.schedulePersist();
  }

  /** 新建后拿到真实路径：把草稿 tab 转正。 */
  adoptTab(id: string, path: string, name: string): void {
    const tabs = this.state.tabs.map((tab) => (tab.id === id ? { ...tab, id: path, path, name } : tab));
    const drafts = { ...this.state.drafts };
    const draft = drafts[id];
    delete drafts[id];
    const scroll = { ...this.state.scroll };
    const top = scroll[id];
    delete scroll[id];

    const next: NotesState = { ...this.state, tabs, drafts, scroll };
    if (draft !== undefined) drafts[path] = draft;
    if (top !== undefined) scroll[path] = top;
    if (this.state.activeTabId === id) next.activeTabId = path;
    this.commit(next, true);
  }

  // -------------------------------------------------------------------------
  // 置顶
  // -------------------------------------------------------------------------

  /**
   * 切换置顶。
   * @param path - 文件绝对路径。
   * @returns 操作结果：是否成功、以及是否因为超上限被拒。
   */
  togglePin(path: string): { ok: boolean; reason?: 'limit' } {
    const pinned = this.state.pinned;
    const index = pinned.indexOf(path);

    if (index >= 0) {
      this.commit({ ...this.state, pinned: pinned.filter((item) => item !== path) }, true);
      return { ok: true };
    }
    if (pinned.length >= MAX_PINNED) {
      return { ok: false, reason: 'limit' };
    }
    this.commit({ ...this.state, pinned: [...pinned, path] }, true);
    return { ok: true };
  }

  /** 取消置顶（拖动排序等场景用）。 */
  unpin(path: string): void {
    if (!this.state.pinned.includes(path)) return;
    this.commit({ ...this.state, pinned: this.state.pinned.filter((item) => item !== path) }, true);
  }

  /**
   * 拖动排序：把一个置顶项插到指定「缝隙」位置。
   *
   * 用缝隙下标而不是「插到某项前面」做锚点：锚点若是标签，插入后标签移位
   * 会让锚点漂移，指针不动列表也会来回重排（闪烁）。缝隙是位置锚点，
   * 预览重排后依然指向同一个地方，视觉稳定。
   *
   * @param path - 被拖动的置顶项路径。
   * @param slot - 插入缝隙下标（按「摘除被拖项后」的数组计）；超出按末尾处理。
   * @returns 是否真的发生了顺序变化（原地放置返回 false）。
   */
  reorderPinned(path: string, slot: number): boolean {
    const pinned = this.state.pinned;
    if (!pinned.includes(path)) return false;

    // 先摘下来再算插入点，slot 按「摘除后」的数组计算才正确。
    const rest = pinned.filter((item) => item !== path);
    const index = Math.max(0, Math.min(slot, rest.length));
    const next = [...rest.slice(0, index), path, ...rest.slice(index)];
    if (next.every((item, i) => item === pinned[i])) return false;

    this.commit({ ...this.state, pinned: next }, true);
    return true;
  }

  /**
   * 把某个 tab 移到另一个位置（拖动排序）。
   *
   * 与 `reorderPinned` 同一套约定：用「摘除被拖项后」的目标下标做锚点，
   * 先摘下来再插入，避免边拖边重排时下标漂移。
   *
   * @param id - 被拖动的 tab id。
   * @param slot - 摘除后数组里的插入位置；超出按末尾处理。
   * @returns 顺序是否真的变了（回原位返回 false）。
   */
  moveTab(id: string, slot: number): boolean {
    const tabs = this.state.tabs;
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return false;
    const rest = tabs.filter((tab) => tab.id !== id);
    const at = Math.max(0, Math.min(slot, rest.length));
    const next = [...rest.slice(0, at), tabs[index]!, ...rest.slice(at)];
    if (next.every((tab, i) => tab.id === tabs[i]?.id)) return false;
    this.commit({ ...this.state, tabs: next }, true);
    return true;
  }

  // -------------------------------------------------------------------------
  // 目录展开
  // -------------------------------------------------------------------------

  /** 切换一个目录的展开状态。 */
  toggleExpanded(path: string): void {
    const expanded = this.state.expanded;
    const next = expanded.includes(path)
      ? expanded.filter((item) => item !== path)
      : [...expanded, path];
    this.commit({ ...this.state, expanded: next }, true);
  }

  /**
   * 全部收起：清空展开集合。
   *
   * 不必遍历目录树 —— 树的展开状态就是一串路径，清空即全部收拢。
   */
  collapseAll(): void {
    if (this.state.expanded.length === 0) return;
    this.commit({ ...this.state, expanded: [] }, true);
  }

  /**
   * 整体替换展开集合（「全部展开」与「定位到当前文件」用）。
   *
   * 去重后与原集合完全一致就不写入，避免无意义的重渲染与落盘。
   *
   * @param paths - 需要处于展开状态的目录路径。
   */
  setExpanded(paths: readonly string[]): void {
    const next = [...new Set(paths)];
    const same =
      next.length === this.state.expanded.length &&
      next.every((item, index) => this.state.expanded[index] === item);
    if (same) return;
    this.commit({ ...this.state, expanded: next }, true);
  }

  /**
   * 文件被移动后，把引用旧路径的地方全部改到新路径。
   *
   * 涉及四处：已打开的 tab（id/path）、置顶列表、滚动记忆、未保存草稿。
   * 不改的话，那个 tab 再保存就会写回一个不存在的位置，置顶项也会变成死链。
   *
   * @param from - 移动前的绝对路径。
   * @param to - 移动后的绝对路径。
   */
  remapPath(from: string, to: string): void {
    const name = basenameOfPath(to);

    const tabs = this.state.tabs.map((tab) =>
      tab.id === from || tab.path === from ? { ...tab, id: to, path: to, name } : tab,
    );
    const pinned = this.state.pinned.map((p) => (p === from ? to : p));
    // 只把顶层那条记录改名：from 的子路径（目录内文件）不在这里处理，
    // 当前也只允许移动文件，不存在子树问题。
    const scroll = { ...this.state.scroll };
    if (from in scroll) {
      scroll[to] = scroll[from];
      delete scroll[from];
    }
    const drafts = { ...this.state.drafts };
    if (from in drafts) {
      drafts[to] = drafts[from];
      delete drafts[from];
    }
    const activeTabId = this.state.activeTabId === from ? to : this.state.activeTabId;

    this.commit({ ...this.state, tabs, pinned, scroll, drafts, activeTabId }, true);
  }

  // -------------------------------------------------------------------------
  // 文件树刷新
  // -------------------------------------------------------------------------

  /**
   * 请求文件树重新列目录。
   *
   * 在「新建 / 删除文件」这类会改变目录内容之后调用。递增令牌而不是重建树，
   * 这样已展开的层级与滚动位置都能保留，只是内容重新拉一次。
   */
  refreshTree(): void {
    // 纯运行期信号：不落盘，所以走静默更新 + 通知订阅者。
    this.state = { ...this.state, treeRevision: this.state.treeRevision + 1 };
    for (const listener of this.listeners) listener();
  }
}

/**
 * 取路径的文件名部分（同时识别 `/` 与 `\`）。
 *
 * 浏览器里没有 node:path，只能自己切；而 Windows 上 host 返回的是反斜杠路径，
 * 只认 `/` 会让整个路径被当成文件名。
 *
 * @param path - 绝对或相对路径。
 * @returns 最后一个分隔符之后的部分；没有分隔符时原样返回。
 */
function basenameOfPath(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i < 0 ? path : path.slice(i + 1);
}
