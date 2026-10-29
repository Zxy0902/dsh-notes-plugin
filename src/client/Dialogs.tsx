/**
 * 几种小弹层：新建笔记、右键菜单、确认。
 *
 * 它们的共同点：都是「临时浮在上面、做完就消失」，没有跨页面的状态，
 * 因此集中放一起，不占主面板的篇幅。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotesApi } from './api';
import { messageOf } from './paths';
import type { NoteTab } from './store';

// ---------------------------------------------------------------------------
// 新建弹层
// ---------------------------------------------------------------------------

/** 新建弹层属性。 */
export interface CreateDialogProps {
  root: string;
  api: NotesApi;
  onClose: () => void;
  onCreated: (tab: NoteTab) => void;
  onError: (message: string) => void;
}

/** 新建笔记：先选类型（Markdown / txt），再填文件名。 */
export function CreateDialog(props: CreateDialogProps): JSX.Element {
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
// 右键菜单
// ---------------------------------------------------------------------------

/** 菜单项：普通项或分隔线。 */
export type MenuItem = { separator: true } | { separator?: false; label: string; danger?: boolean; onPick: () => void };

/** 右键菜单属性。 */
export interface ContextMenuProps {
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
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): JSX.Element {
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
export interface ConfirmDialogProps {
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
export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element {
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
