/**
 * 左侧「技能文件夹」栏。
 *
 * 用途：浏览某条技能时，把左侧原本的**笔记文件树**整块换成这条技能的文件树。
 *
 * 为什么放在左侧、而不是在技能列表里就地展开：技能常常把正文拆进 `rules/`、
 * `references/` 等子目录，文件一多，塞在列表行里会把列表撑得很长、也很挤。
 * 左侧那一栏本来就是「文件导航」的位置，把技能树放进去，位置固定、空间充足；
 * 看完一个文件还能接着点下一个，不用反复展开收起。
 *
 * 退出方式就是切走 —— 点任意笔记 tab，左侧自动变回笔记目录（由外壳决定
 * 挂哪一栏），所以这里只需要一个「返回笔记」的快捷出口。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives';
import type { NotesApi, SkillTreeNode, SkillTree } from './api';

/** 这些扩展名可以在这里点开阅读；其余交给系统的「打开方式」。 */
const READABLE_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.yml', '.yaml',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.sh', '.ps1', '.py', '.sql',
]);

/** 这个文件名是否可以当文本读。 */
function isReadable(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return READABLE_EXT.has(name.slice(dot).toLowerCase());
}

/** 图标：文件夹。 */
function IconFolder({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.8 4.2a1 1 0 0 1 1-1h3l1.4 1.6h6.9a1 1 0 0 1 1 1v6.9a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z" />
    </svg>
  );
}

/** 图标：展开箭头（默认朝下）。 */
function IconChevron({ size = 11 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6.5 8 10.5l4-4" />
    </svg>
  );
}

/** 图标：非文本文件。 */
function IconDoc({ size = 12 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 1.8h5l3 3v9.4H4z" />
      <path d="M9 1.9v3h3" />
    </svg>
  );
}

/** 一个树节点（由扁平清单还原）。 */
interface TreeItem {
  node: SkillTreeNode;
  children: TreeItem[];
}

/**
 * 把宿主给的扁平清单还原成嵌套树。
 *
 * **不能用「按顺序推栈」**：宿主是**广度优先**返回的 —— 同一层的目录全排在
 * 前面，再逐层展开它们的子项。真实数据长这样：
 *
 * ```
 * 1 directory rules
 * 1 directory scripts
 * 1 file      SKILL.md          ← 与 rules 同层，却排在 rules 的子项之前
 * 2 file      rules/dict.md
 * 2 file      scripts/x.sh      ← 两个目录的子项混在一起
 * ```
 *
 * 按顺序推，`rules/dict.md` 的「上一个节点」是 `SKILL.md`，会挂错爹。
 * 所以改为按**路径**找爹：`a/b/c.md` 的父目录是 `a/b`，再按 `rel` 索引对回去。
 *
 * @param nodes - 宿主返回的扁平清单。
 * @returns 嵌套树（保持宿主给的顺序）。
 */
export function buildSkillTree(nodes: readonly SkillTreeNode[]): TreeItem[] {
  const items = nodes.map((node) => ({ node, children: [] as TreeItem[] }));
  const byRel = new Map<string, TreeItem>();
  for (const item of items) byRel.set(item.node.rel, item);

  const roots: TreeItem[] = [];
  for (const item of items) {
    const rel = item.node.rel;
    const cut = rel.lastIndexOf('/');
    const parent = cut < 0 ? undefined : byRel.get(rel.slice(0, cut));
    if (parent !== undefined) parent.children.push(item);
    else roots.push(item);
  }
  return roots;
}

/** 技能文件夹栏属性。 */
export interface SkillTreePaneProps {
  api: NotesApi;
  /** 技能名（栏目顶部显示）。 */
  name: string;
  /** 技能目录。 */
  dir: string;
  /** 当前正在阅读的文件（高亮用）。 */
  current: string | null;
  /** 点一个文本文件。 */
  onPick: (node: SkillTreeNode) => void;
  /** 点一个非文本文件（交给系统的打开方式）。 */
  onPickBinary: (node: SkillTreeNode) => void;
  /** 在面板顶部做成一次性提示。 */
  onNotice: (message: string) => void;
}

/**
 * 技能文件夹栏（占据左侧整块）。
 *
 * @param props - 见 {@link SkillTreePaneProps}。
 * @returns 技能文件树。
 */
export function SkillTreePane(props: SkillTreePaneProps): JSX.Element {
  const { api, name, dir, current, onPick, onPickBinary, onNotice } = props;
  const [tree, setTree] = useState<SkillTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 已折叠的目录（默认全展开：技能通常只有几十个文件）。 */
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());

  // 换一条技能才重读；同一条技能内切文件不重读。
  useEffect(() => {
    let alive = true;
    setTree(null);
    setError(null);
    setFolded(new Set());
    api
      .skillTree(dir)
      .then((result) => {
        if (!alive) return;
        setTree(result);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [api, dir]);

  const nodes = useMemo(() => (tree === null ? null : buildSkillTree(tree.entries)), [tree]);
  const fileCount = tree === null ? 0 : tree.entries.filter((entry) => entry.kind === 'file').length;

  const toggle = useCallback((path: string) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const allFolded = folded.size === 0;
  const toggleAll = useCallback(() => {
    if (tree === null) return;
    if (!allFolded) {
      setFolded(new Set());
      return;
    }
    setFolded(new Set(tree.entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.path)));
  }, [allFolded, tree]);

  /** 渲染一层（递归）。 */
  const renderRows = (items: readonly TreeItem[], depth: number): JSX.Element => (
    <ul className="dsh-notes__stree">
      {items.map((item) => {
        const isDir = item.node.kind === 'directory';
        const isFolded = folded.has(item.node.path);
        const active = current === item.node.path;
        return (
          <li key={item.node.path}>
            <button
              type="button"
              className={`dsh-notes__stree-row${isDir ? ' dsh-notes__stree-row--dir' : ''}${active ? ' dsh-notes__stree-row--active' : ''}`}
              style={{ paddingLeft: 8 + depth * 12 }}
              title={item.node.rel}
              aria-expanded={isDir ? !isFolded : undefined}
              aria-current={active ? 'true' : undefined}
              onClick={() => {
                if (isDir) {
                  toggle(item.node.path);
                  return;
                }
                if (isReadable(item.node.name)) {
                  onPick(item.node);
                  return;
                }
                onNotice(`${item.node.name} 不是文本文件，已交给系统打开`);
                onPickBinary(item.node);
              }}
            >
              <span className="dsh-notes__stree-caret">{isDir ? <IconChevron /> : null}</span>
              {isDir ? (
                <IconFolder />
              ) : isReadable(item.node.name) ? (
                <FileTypeIcon path={item.node.name} size={12} />
              ) : (
                <IconDoc />
              )}
              <span className="dsh-notes__stree-name">{item.node.name}</span>
            </button>
            {isDir && !isFolded && item.children.length > 0 && renderRows(item.children, depth + 1)}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="dsh-notes__skillpane-left">
      {/* 栏目头只做标识：这是哪条技能的文件夹。
          退出统一放在右侧阅读区顶部的「←」—— 同一个动作只该有一个入口，
          两侧各摆一个会让人以为是两回事。 */}
      <div className="dsh-notes__skillleft-head">
        <span className="dsh-notes__skillleft-name" title={dir}>
          /{name}
        </span>
      </div>

      <div className="dsh-notes__skillleft-bar">
        <span>
          {tree === null ? '读取中…' : `共 ${fileCount} 个文件`}
          {tree?.truncated === true && '（已截断）'}
        </span>
        {tree !== null && tree.entries.length > 0 && (
          <button type="button" className="dsh-notes__sd-fileswitch" onClick={toggleAll}>
            {allFolded ? '全部展开' : '全部收起'}
          </button>
        )}
      </div>

      <div className="dsh-notes__skillleft-body">
        {error !== null ? (
          <div className="dsh-notes__sd-error">读取文件清单失败：{error}</div>
        ) : nodes === null ? (
          <div className="dsh-notes__sd-treetip">正在读取文件清单…</div>
        ) : nodes.length === 0 ? (
          <div className="dsh-notes__sd-treetip">这个技能目录读不到内容</div>
        ) : (
          renderRows(nodes, 0)
        )}
      </div>
    </div>
  );
}
