/**
 * 「agent 指令」区：DSH 的全局 agent 文件 + 用户自己添加的。
 *
 * 【这些文件是什么】DSH 的 `dsh-agent-instructions` 插件在每次会话开头把若干
 * `AGENTS.md` 拼成一段上下文注入给模型 —— 「所有回复用中文」这类规则就写在
 * 那里面。**它约束的是模型怎么做事，不是 DSH 程序怎么跑。**
 *
 * 【为什么预置只给一条】本插件是通用的，不该替用户假设「你一定只用 DSH 那
 * 几个约定路径」。所以默认只有 DSH 自己那一条（`~/.dsh/AGENTS.md`，跟随
 * `$DSH_HOME`）；别的文件谁需要谁自己加 —— 加进来的路径就是授权来源。
 *
 * 组件只做三件事：列出来、点开读、加/删路径。读写细节全在宿主那边。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentInstructionFile, NotesApi } from './api';
import { IconClose, IconPlus } from './icons';

/** agent 指令区属性。 */
export interface AgentFilesPaneProps {
  api: NotesApi;
  /** 用户自己添加的路径（来自状态仓库）。 */
  paths: readonly string[];
  /** 点开一个文件：在右侧打开（或聚焦）它的 tab。 */
  onOpen: (file: AgentInstructionFile) => void;
  /** 添加一个路径。 */
  onAdd: (path: string) => void;
  /** 移除一个路径（只删记录，不删文件）。 */
  onRemove: (path: string) => void;
  /** 一次性提示。 */
  onNotice: (message: string) => void;
}

/** 「agent 指令」区：默认那一条 + 用户添加的。 */
export function AgentFilesPane(props: AgentFilesPaneProps): JSX.Element {
  /** 宿主算出来的默认文件（跟随 `$DSH_HOME`，所以每次现取）。 */
  const [defaultFile, setDefaultFile] = useState<AgentInstructionFile | null>(null);
  /** 用户添加的那些文件的存在状态（键是路径）。 */
  const [exists, setExists] = useState<Record<string, boolean>>({});
  /** 添加框是否展开。 */
  const [adding, setAdding] = useState(false);
  /** 添加框里输入的路径。 */
  const [draft, setDraft] = useState('');
  /**
   * 刚添加的那条路径：用来高亮。
   *
   * 【为什么需要它】添加成功后新行和既有行长得一模一样，用户根本分不清
   * 自己刚加进来的是哪一条 —— 只能把列表从头扫一遍去确认。标出来之后，
   * 那一行直接就是可以点开的目标。
   *
   * 清空时机：点开它（用户已经确认过）、或移除它、或又加了另一条。
   */
  const [justAdded, setJustAdded] = useState<string | null>(null);

  /** 列表容器：新行可能落在视野外（列表长时），要用它滚过去。 */
  const listRef = useRef<HTMLUListElement | null>(null);

  // 取默认那一条。
  useEffect(() => {
    let alive = true;
    props.api
      .defaultAgentFile()
      .then((result) => {
        if (alive) setDefaultFile(result.defaultFile);
      })
      .catch(() => {
        // 取不到就不显示默认项（旧宿主没有这条路由）。用户仍可自己加路径。
      });
    return () => {
      alive = false;
    };
  }, [props.api]);

  /**
   * 逐个探一下用户添加的文件在不在。
   *
   * 用一个不读内容的轻量方式：直接调读接口拿 `exists` 字段。文件可能很大，
   * 但 `readAgentFile` 本来就有大小上限，且这是用户自己的几个文件、不是遍历。
   */
  useEffect(() => {
    if (props.paths.length === 0) return undefined;
    let alive = true;
    void Promise.all(
      props.paths.map((path) =>
        props.api
          .readAgentFile(path)
          .then((file) => [path, file.exists] as const)
          .catch(() => [path, false] as const),
      ),
    ).then((pairs) => {
      if (!alive) return;
      setExists(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
  }, [props.api, props.paths]);

  /**
   * 把刚添加的那一行滚进视野。
   *
   * 用路径逐个比对而不是拼选择器：路径里可能带引号、方括号等，
   * 直接塞进 `querySelector` 会语法错误或误匹配。
   */
  useEffect(() => {
    if (justAdded === null) return;
    const list = listRef.current;
    if (list === null) return;
    const node = Array.from(list.querySelectorAll<HTMLElement>('[data-agent-path]')).find(
      (item) => item.getAttribute('data-agent-path') === justAdded,
    );
    // block: 'nearest' —— 已经在视野里就不动，避免列表无故跳一下。
    node?.scrollIntoView({ block: 'nearest' });
  }, [justAdded]);

  /**
   * 提交添加。
   *
   * 无论新加还是已在列表里，都把那一行标成「刚添加」：两种情况用户都需要
   * 知道「我刚才说的那个文件，在列表的哪个位置」。
   */
  const submit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed === '') return;
    const already = props.paths.includes(trimmed);
    props.onAdd(trimmed);
    setJustAdded(trimmed);
    setDraft('');
    setAdding(false);
    if (already) props.onNotice('这个文件已经在列表里了');
  }, [draft, props]);

  /** 渲染一行文件。 */
  const renderRow = (file: AgentInstructionFile, removable: boolean): JSX.Element => {
    const isNew = justAdded === file.path;
    return (
      <li key={file.path} data-agent-path={file.path}>
        <div className={`dsh-notes__agentrow${isNew ? ' dsh-notes__agentrow--new' : ''}`}>
          <button
            type="button"
            className="dsh-notes__agentpick"
            title={file.path}
            onClick={() => {
              // 点开即确认完毕，高亮可以收掉了。
              setJustAdded(null);
              props.onOpen(file);
            }}
          >
            <span className="dsh-notes__agentname">
              {file.name}
              {isNew && <span className="dsh-notes__agenttag-new">刚添加</span>}
              {file.isDefault && (
                <span className="dsh-notes__skilltag" title="DSH 默认会加载的那一条">
                  默认
                </span>
              )}
              {!file.exists && (
                <span className="dsh-notes__agenttag-missing" title="文件还不存在，点开即可创建">
                  尚未创建
                </span>
              )}
            </span>
            <span className="dsh-notes__agentpath">{file.path}</span>
          </button>
          {removable && (
            /* 移除只作用于「这条记录」，所以放在行内单独的可点区域，
               点了不会顺带打开文件。 */
            <button
              type="button"
              className="dsh-notes__agentx"
              title="从列表里移除（不会删除文件）"
              aria-label={`从列表里移除 ${file.path}`}
              onClick={() => {
                if (isNew) setJustAdded(null);
                props.onRemove(file.path);
              }}
            >
              <IconClose size={9} />
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="dsh-notes__skillgroup">
      <div className="dsh-notes__skillgroup-head">
        agent 指令
        <span className="dsh-notes__skillgroup-count">
          {(defaultFile === null ? 0 : 1) + props.paths.length}
        </span>
        <button
          type="button"
          className="dsh-notes__treebtn"
          title="添加一个 agent 指令文件（填绝对路径）"
          aria-label="添加 agent 指令文件"
          onClick={() => setAdding((value) => !value)}
        >
          <IconPlus />
        </button>
      </div>

      {/* 说明一行：这个区的文件到底是什么。很多人会把它当成「控制 DSH 的配置」，
          说清楚能省掉一轮误解。 */}
      <div className="dsh-notes__agenthint">
        这些是给模型看的规则文件。DSH 在每次会话开头把它们注入上下文 ——
        它约束模型怎么做事，不是控制 DSH 程序怎么跑。
      </div>

      {adding && (
        <div className="dsh-notes__agentadd">
          <input
            className="dsh-notes__agentinput"
            type="text"
            placeholder="例如 ~/.agents/AGENTS.md"
            value={draft}
            autoFocus
            aria-label="agent 指令文件路径"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
              if (event.key === 'Escape') {
                setDraft('');
                setAdding(false);
              }
            }}
          />
          <button type="button" className="dsh-notes__btn" disabled={draft.trim() === ''} onClick={submit}>
            添加
          </button>
        </div>
      )}

      <ul className="dsh-notes__skilllist" ref={listRef}>
        {defaultFile !== null && renderRow({ ...defaultFile, isDefault: true }, false)}
        {props.paths.map((path) => {
          const file: AgentInstructionFile = {
            name: path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1) || path,
            path,
            exists: exists[path] ?? false,
            isDefault: false,
          };
          return renderRow(file, true);
        })}
      </ul>

      {defaultFile === null && props.paths.length === 0 && (
        <div className="dsh-notes__hint" style={{ padding: '2px 10px 6px' }}>
          读不到 DSH 的默认指令文件位置。可以用上面的「+」自己添加一个路径。
        </div>
      )}
    </div>
  );
}
