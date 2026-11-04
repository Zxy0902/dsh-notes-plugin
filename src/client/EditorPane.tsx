/**
 * 单个 tab 的编辑 / 预览区。
 *
 * 包括：读取文件、草稿状态、Markdown 分栏编辑、只读预览、保存（⌘S）、
 * 显示方式切换（编辑 / 分栏 / 预览）、滚动同步、大纲栏。
 *
 * 为什么单独成文件：它是面板里最大的一块（约 330 行），而且与「技能浏览」
 * 完全无关 —— 技能那边只关心「左侧显示哪棵树、右侧显示哪份正文」。混在
 * `NotesPanel` 里时，改技能最容易碰到编辑器。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { MarkdownText, SegmentedControl, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives';
import { CodeColorView } from './CodeColorView';
import { defaultViewMode, isCodeFile, languageOf } from './codeColor';
import type { NotesApi } from './api';
import { indent, outdent } from './indent';
import { isSkillFile, messageOf } from './paths';
import type { NoteTab, NotesStore } from './store';
import { useScrollSync } from './useScrollSync';
import { useOutline, OutlinePane } from './OutlinePane';

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
export type ViewMode = 'split' | 'edit' | 'preview';

/**
 * 这个 tab 是不是 Markdown（要左编右渲、有大纲、有显示方式切换）。
 *
 * `global` 是 agent 指令文件，内容就是 Markdown，所以按 md 对待 ——
 * 少一种分支，也让它免费获得预览与大纲。
 *
 * @param tab - 要判断的 tab。
 * @returns 是 Markdown 则为 true。
 */
function isMarkdownTab(tab: NoteTab): boolean {
  return tab.kind === 'md' || tab.kind === 'global';
}

/** 显示方式的可选项（供 SegmentedControl 使用）。 */
const VIEW_MODE_OPTIONS = [
  { value: 'edit' as const, label: '编辑' },
  { value: 'split' as const, label: '分栏' },
  { value: 'preview' as const, label: '预览' },
];

/** 编辑区属性。 */
export interface EditorPaneProps {
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
export function EditorPane(props: EditorPaneProps): JSX.Element {
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
    // 全局 agent 指令文件也走专用通道（白名单围栏）：它同样不在笔记目录里。
    //
    // 普通文件用 **tab 自己的根**，不是当前根：切过文件夹之后，旧 tab 的文件
    // 落在别的根下。同时把「其他已打开文件的根」一并报给宿主，让它知道这些
    // 也是允许范围（否则宿主会按单个根围栏拒绝）。
    const request =
      tab.kind === 'global'
        ? api.readAgentFile(tab.path)
        : isSkillFile(tab.path)
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
  }, [api, root, tab.id, tab.path, tab.kind, store]);

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
   * 这份内容能不能染色。
   *
   * 只有「整份文件都是代码」的类型才可以（`.sql`、`.java`…）；Markdown 的
   * 代码块由 MarkdownText 自己处理，不归这条路。
   */
  const colorable = isCodeFile(tab.path);
  /** 染色语言 id（`sql`、`java`…）。 */
  const colorLanguage = languageOf(tab.path);
  /**
   * 当前是否正在染色。
   *
   * 两个条件同时成立：用户开了这个偏好，且这份文件是可染色的类型。
   * 后者很重要 —— 偏好是全局的，但 `.md`/`.txt` 不该被它影响。
   */
  const [codeColor, setCodeColor] = useState(() => store.getSnapshot().codeColor && colorable);

  /* ---------------- 染色叠加层 ----------------
   *
   * 染色**不是**只读预览，而是盖在编辑框之上的一层「着色显示」：
   *   · 下面一层：CodeColorView 画出带颜色的文字；
   *   · 上面一层：textarea 的文字设为全透明，只留光标与选区。
   * 两层共用同一套字号/行高/内边距/制表符宽度，所以彩色文字和光标位置严丝合缝，
   * 打字、选中、滚动、保存照常可用 —— 染色再也不会把文件变成只能看的图片。
   *
   * 为什么不让 textarea 自己上色：textarea 只能显示纯文本，这是浏览器的限制。
   */
  const paintRef = useRef<HTMLDivElement | null>(null);
  /**
   * 滚动同步用**位移**而不是 scrollTop。
   *
   * 两层的内容高度不可能分毫不差（编辑框有 border/内边距差异，着色层有行号列），
   * 用 scrollTop 同步时，可滚动范围短的那一侧滚到底就停住，颜色会比光标落后
   * 几十像素。平移没有「可滚动范围」这个概念，滚多少就移多少，永远严格相等。
   */
  /**
   * 输入法组字（打中文）期间临时撤掉着色层。
   *
   * 组字时文字是透明的，候选字看不见就成了瞎打；所以组字期间把 textarea 的
   * 文字显示出来、并隐藏下面的着色层，组字结束再切回去。
   */
  const [composing, setComposing] = useState(false);



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
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    // 统一由 codeColor.ts 判定：染色时只能 preview，md 沿用偏好，其余编辑。
    defaultViewMode(tab.kind, tab.path, store.getSnapshot().mdViewMode),
  );

  /**
   * 切换显示方式，并把它记成默认。
   *
   * 只在**手动切换**时记录：那是用户明确表达的偏好。打开文件时按偏好初始化
   * 不算，否则「split 被初始化成 split」也会写一次盘。
   */
  const chooseView = useCallback(
    (next: ViewMode) => {
      setViewMode(next);
      /*
       * agent 指令文件**不写入** md 的默认偏好。
       *
       * 这个偏好是「打开笔记时默认用哪种方式」；用户为一份 AGENTS.md 临时切到
       * 预览，不该连带改掉他以后打开所有笔记的习惯。两者是不同意图，
       * 混在一起会让人莫名其妙地发现「我的笔记怎么变预览了」。
       */
      if (tab.kind !== 'global') store.setMdViewMode(next);
    },
    [store, tab.kind],
  );

  /** 只有分栏时才需要同步滚动。 */
  const sync = useScrollSync(isMarkdownTab(tab) && viewMode === 'split' && syncScroll, rememberScroll);
  /**
   * 叠加编辑框滚动时：① 平移着色层；② 交给同步钩子记录位置、并在
   * Markdown 分栏时把右侧渲染结果一起对齐。
   */
  const onPaintScroll = useCallback(
    (event: { currentTarget: HTMLTextAreaElement }) => {
      const paint = paintRef.current;
      if (paint !== null) {
        const { scrollLeft, scrollTop } = event.currentTarget;
        paint.style.transform = `translate3d(${-scrollLeft}px, ${-scrollTop}px, 0)`;
      }
      // 位置记忆与分栏同步都在这里（enabled=false 时内部自动跳过同步）。
      sync.onEditorScroll();
    },
    [sync],
  );
  const draftRef = sync.editorRef;

  /**
   * 这一份内容此刻“有没有源码栏可看”。
   *
   * Markdown 切到「预览」时完全没有编辑框，也就没有可染色的东西；
   * 代码文件与 txt 永远有源码栏。
   */
  const sourceVisible = !isMarkdownTab(tab) || viewMode !== 'preview';
  /**
   * 是否走「编辑框 + 底下着色层」这条叠加渲染路径。
   *
   * 只有代码文档会走到这里：Markdown 不在染色白名单里，`colorable` 为 false，
   * 它的 `codeColor` 状态恒为 false（见 codeColor.ts 的 COLORABLE_LANGUAGES）。
   */
  const paintCode = codeColor;
  /** 是否显示编辑框（染色时由叠加层接管，见上）。 */
  const showEditor = !paintCode && sourceVisible;
  /** 是否显示渲染结果（Markdown 预览）。 */
  const showPreview = isMarkdownTab(tab) && viewMode !== 'edit';
  /** 只有代码文档才显示染色开关。 */
  const canToggleColor = colorable;

  // ---- 大纲 ----
  /**
   * 是否提取大纲。
   *
   * **只跟「有没有预览」有关，不跟大纲开没开有关** —— 这点很关键：
   * 若把「已收起」也算进禁用条件，items 会变空，dochead 上的按钮就会因为
   * 「没有标题」而消失，用户再也打不开它。
   */
  const outlineAvailable = isMarkdownTab(tab) && showPreview;
  const outline = useOutline(sync.previewRef, text, outlineAvailable);
  /** 有没有正文标题可列。 */
  const hasOutline = outlineAvailable && outline.items.length > 0;
  /**
   * 最终是否渲染大纲栏。
   *
   * **故意不按窗口宽度做门槛。** 早先的版本会在窗口不够宽时把按钮一起隐藏，
   * 结果是：用户根本看不到这个功能存在，以为没做。开关不该有「看不见」的状态 ——
   * 挤不挤让用户自己判断，他随时可以收起。宽度只由 CSS 兜底（见
   * `.dsh-notes__outline` 的 flex 收缩规则）。
   */
  const showOutline = hasOutline && store.getSnapshot().outlineOpen;

  /**
   * 把记住的滚动位置套到当前编辑框上，并让下面的着色层跟着对齐。
   *
   * 【为什么需要单独抽出来】切换「染色」会换掉整个编辑框元素（普通 textarea
   * 与叠加层里的透明 textarea 不是同一个节点），新节点滚动位置是 0 ——
   * 于是在一份长文件中间点一下染色，画面直接跳回文件顶部。
   */
  const applyScroll = useCallback((top: number) => {
    const node = draftRef.current;
    if (node === null || top === 0) return;
    node.scrollTop = top;
    const paint = paintRef.current;
    if (paint !== null) {
      paint.style.transform = `translate3d(${-node.scrollLeft}px, ${-node.scrollTop}px, 0)`;
    }
  }, []);

  // 首次挂载：恢复上次的滚动位置（编辑器为主，恢复后同步钩子再对齐预览）。
  useEffect(() => {
    applyScroll(props.initialScroll);
    // 只在挂载时恢复一次；恢复后同步钩子会在下一次滚动时接管对齐。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换染色后（编辑框元素被替换）把位置补回去，避免跳回顶部。
  useEffect(() => {
    applyScroll(store.getSnapshot().scroll[tab.id] ?? 0);
  }, [applyScroll, paintCode, store, tab.id]);

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
      if (tab.kind === 'global') {
        // agent 指令文件走专用通道（宿主按「绝对路径 + 文本扩展名」围栏），
        // 不走笔记那套「根目录之内」的规则 —— 它本来就不在笔记目录里。
        await api.writeAgentFile(tab.path, content);
      } else {
        if (isSkillFile(tab.path)) {
          props.onNotice('技能文件是只读的，不能保存修改');
          return;
        }
        // 与读同一套规则：用 tab 自己的根，并把其他已打开文件的根一并报上去。
        await api.write(tab.root ?? root, tab.path, content, store.knownRoots());
      }
      // 先更新基线，再清草稿：否则中间那一帧会显示旧内容。
      setLoaded(content);
      store.clearDraft(tab.id);
      props.onNotice('已保存');
    } catch (cause) {
      props.onNotice(`保存失败：${messageOf(cause)}`);
    } finally {
      setSaving(false);
    }
  }, [api, root, tab.id, tab.path, tab.kind, dirty, saving, store, props]);

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

  /**
   * Tab 键：缩进 / 反缩进，而不是把焦点挪走。
   *
   * textarea 里的 Tab 默认是「跳到下一个可聚焦元素」，在面板里表现为按一下
   * Tab 编辑光标就丢了、DSH 整个界面被抢走焦点。对写 Markdown 的人而言，
   * Tab 应该是缩进（列表嵌套、代码块）。
   *
   * 焦点仍然留在编辑框里 —— 这正是用户要的「在阅读器里面进行 tab 缩进」。
   *
   * 逃生口：⌘/Ctrl + Tab 保留浏览器默认的「移动焦点」。偶尔需要跳出编辑框
   * 去点别处时用它；纯 Tab 则永远是缩进。
   */
  const [pendingSelection, setPendingSelection] = useState<{ start: number; end: number } | null>(null);

  const onEditorKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Tab') return;
      // ⌘/Ctrl + Tab：交回默认行为（移动焦点），当作跳出编辑框的出口。
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // 阻止默认行为：不然后台会先跑一遍「移动焦点」，光标就跑了。
      event.preventDefault();

      const node = event.currentTarget;
      const result = event.shiftKey
        ? outdent(text, node.selectionStart, node.selectionEnd)
        : indent(text, node.selectionStart, node.selectionEnd);

      if (result.text === text) return;
      onChange(result.text);
      // 选区要等 React 把新值写回 DOM 之后再设，否则会被旧值覆盖。
      setPendingSelection({ start: result.start, end: result.end });
    },
    [text, onChange],
  );

  // 新文本落进 textarea 之后，把选区挪到新位置。
  useEffect(() => {
    if (pendingSelection === null) return;
    const node = draftRef.current;
    if (node === null) return;
    node.setSelectionRange(pendingSelection.start, pendingSelection.end);
    setPendingSelection(null);
  }, [pendingSelection, text]);

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
        {isMarkdownTab(tab) && viewMode === 'split' && (
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
            但若切到预览时仍有未保存改动，保留一个保存入口，防止改动无处可存。
            【判据用 sourceVisible，不能用 showEditor】染色时编辑框由叠加层接管，
            showEditor 为 false，用它会误判成“没有编辑框”，保存按钮就常驻工具栏了 ——
            保存该由「有没有未保存改动」决定，与染色开关无关。 */}
        {(!sourceVisible || dirty) && (
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

        {/* 大纲开关：只要有正文标题就出现。
            放在显示方式选择器左边 —— 那个选择器位置必须稳定，不能被挤动。 */}
        {hasOutline && (
          <button
            type="button"
            className={`dsh-notes__btn dsh-notes__btn--outline${showOutline ? ' dsh-notes__btn--on' : ''}`}
            onClick={() => store.setOutlineOpen(!store.getSnapshot().outlineOpen)}
            title={showOutline ? '收起大纲' : '展开大纲'}
            aria-pressed={showOutline}
          >
            大纲
          </button>
        )}

        {/* 代码染色开关：只在这个文件是可染色的代码类型时出现（.sql/.java/...）。
            放在显示方式选择器左边 —— 那个选择器位置必须稳定，不能被挤动。
            染色是叠在编辑框上的一层着色，开了照样能编辑。 */}
        {canToggleColor && (
          <button
            type="button"
            className={`dsh-notes__btn dsh-notes__btn--outline${codeColor ? ' dsh-notes__btn--on' : ''}`}
            onClick={() => {
              const next = !codeColor;
              setCodeColor(next);
              // 记成偏好，下次打开别的代码文件也直接用。
              store.setCodeColor(next);
            }}
            title={codeColor ? '关闭代码染色（回到纯文本）' : '按语法给代码染色'}
            aria-pressed={codeColor}
          >
            染色
          </button>
        )}

        {/* 显示方式：仅 markdown 需要（txt 没有渲染概念）。固定在最右端。 */}
        {isMarkdownTab(tab) && (
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

      {/* 两个栏是否并存：源码栏（普通编辑框 或 染色叠加层）＋ 渲染栏。
          染色时 showEditor 为 false，但源码栏其实还在，不能据此判成单栏。 */}
      <div className={`dsh-notes__body${sourceVisible && showPreview ? '' : ' dsh-notes__body--single'}`}>
        {/* 染色叠加：下面着色层 + 上面透明文字的编辑框。
            两层共用同一套排版，所以颜色和光标位置完全重合。 */}
        {paintCode && (
          <div className="dsh-notes__pane">
            <div className={`dsh-notes__codewrap${composing ? ' dsh-notes__codewrap--composing' : ''}`}>
              {/* 着色层：纯展示，不接收鼠标事件（否则会挡住编辑框的点击和选区）。 */}
              <div className="dsh-notes__codepaint" aria-hidden="true">
                <div ref={paintRef} className="dsh-notes__preview dsh-notes__preview--paint">
                  {/* 这里**不能**用 MarkdownText —— 它会把 `#`、`|`、`*`
                      当 Markdown 语法解析，代码会被改得面目全非。 */}
                  <CodeColorView text={text} language={colorLanguage} />
                </div>
              </div>
              <textarea
                ref={draftRef}
                className="dsh-notes__editor dsh-notes__editor--paint"
                value={text}
                spellCheck={false}
                wrap="off"
                placeholder=""
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={onEditorKeyDown}
                onScroll={onPaintScroll}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={() => setComposing(false)}
              />
            </div>
          </div>
        )}

        {/* 编辑栏：txt 恒有；md 在「预览」模式下完全不渲染，省掉整块编辑区 */}
        {showEditor && (
          <div className="dsh-notes__pane">
            <textarea
              ref={draftRef}
              className="dsh-notes__editor"
              value={text}
              spellCheck={false}
              placeholder={isMarkdownTab(tab) ? '开始写 Markdown…' : '开始写点什么…'}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={onEditorKeyDown}
              onScroll={sync.onEditorScroll}
            />
          </div>
        )}

        {/* 预览栏：Markdown 渲染。分栏时与编辑栏按比例同步滚动。 */}
        {showPreview && (
          <div className="dsh-notes__pane">
            <div ref={sync.previewRef} className="dsh-notes__preview" onScroll={sync.onPreviewScroll}>
              <MarkdownText text={text} labels={MARKDOWN_LABELS} variant="body" />
            </div>
          </div>
        )}

        {/* 大纲栏：常驻在内容区最右。它不参与滚动同步 —— 自己是一列导航，
            滚动的是里面的列表，与正文位置无关。 */}
        {showOutline && (
          <OutlinePane
            items={outline.items}
            activeIndex={outline.activeIndex}
            onJump={outline.jumpTo}
          />
        )}
      </div>
    </>
  );
}

