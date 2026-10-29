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
import { useCallback, useEffect, useState } from 'react';
import { MarkdownText, SegmentedControl, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives';
import type { NotesApi } from './api';
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

  // ---- 大纲 ----
  /**
   * 是否提取大纲。
   *
   * **只跟「有没有预览」有关，不跟大纲开没开有关** —— 这点很关键：
   * 若把「已收起」也算进禁用条件，items 会变空，dochead 上的按钮就会因为
   * 「没有标题」而消失，用户再也打不开它。
   */
  const outlineAvailable = tab.kind === 'md' && showPreview;
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

