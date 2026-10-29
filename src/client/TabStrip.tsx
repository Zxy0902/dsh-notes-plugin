/**
 * 浏览器式 tab 栏：切换 / 关闭 / 右键菜单 / 溢出下拉 / 新建。
 *
 * 单独成文件的原因：它有一整套自己的交互状态（右键菜单坐标、溢出判断、
 * 标签拖动重排），与外层面板的文件状态无关。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives';
import type { NoteTab } from './store';
import { IconChevronDown, IconClose, IconFolder, IconPlus } from './icons';
import { ContextMenu, type MenuItem } from './Dialogs';

// ---------------------------------------------------------------------------
// tab 栏
// ---------------------------------------------------------------------------

/** tab 栏属性。 */
export interface TabStripProps {
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
export function TabStrip(props: TabStripProps): JSX.Element {
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
    // 整条标签栏都是 chrome：空白处按住可拖整窗。栏里的标签、按钮命中
    // base.css 的 :is(button, [role=button], [tabindex] …) 规则自动 no-drag，
    // 点击和标签拖动重排都不受影响。
    <div className="dsh-notes__tabsbar" data-window-drag="">
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

