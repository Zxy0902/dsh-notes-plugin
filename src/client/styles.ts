/**
 * 笔记面板样式。
 *
 * 颜色一律走 DSH 主题 token（--dsw-*），所以明暗主题自动跟随，
 * 插件不硬编码任何颜色。样式在挂载时注入，卸载时移除，不污染全局。
 */

/** 样式表内容。 */
const CSS = `
/* 作用域限定的盒模型 reset。
   DSH 的 base.css 没有全局 box-sizing reset，默认的 content-box 会让
   「width:100% + padding」的元素比容器宽出内边距之和。已实测到的后果：
   .dsh-notes__editor 宽出 60px，textarea 的原生滚动条被挤出所在栏、
   压在右侧预览正文上，看起来像两个界面叠在一起，且在编辑栏右缘下拉时
   实际拖到的是预览栏的滚动条。

   选择器**只匹配本插件自己的类名**（全部以 dsh-notes__ 开头），刻意不用
   「.dsh-notes 加空格星号」这种后代通配写法：预览区里渲染着官方
   MarkdownText / CodeBlock 等组件，而官方 ui-primitives 有 36 条规则依赖
   content-box（例如 MarkdownText 的表格单元格是 max-width:320px +
   padding:10px 16px）。若把它们一并改成 border-box，这些官方组件在笔记面板
   里就会比在原生会话面板里窄，属于对 DSH 自身产生副作用 —— 必须避免。 */
.dsh-notes,
.dsh-notes [class^="dsh-notes__"],
.dsh-notes [class*=" dsh-notes__"] {
  box-sizing: border-box;
}

.dsh-notes {
  display: flex;
  height: 100%;
  width: 100%;
  min-height: 0;
  /* 折叠会话栏后，macOS 把交通灯 + 展开按钮浮在窗口左上角，并通过
     --dsh-frame-leading-clearance 公布这条带子的宽度（折叠 160px / 全屏 84px；
     未折叠时该变量不存在，回退 0px）。

     避让只由**左侧文件夹栏**承担，右侧阅读区（tab 栏 + 正文）保持不动：
     阅读区是用户视线的主战场，折叠会话栏时它整块下移会在顶部留一条空白带，
     观感上像面板"缩"了一下。而交通灯只压在左栏那一角，让左栏单独避让即可。

     这里给出一个恒定的 14px 顶部基线：未折叠时左栏就停在这条线上；折叠时
     左栏在此基础上再往下让 30px（合计 44px，正好是交通灯带的高度）。
     阅读区始终从这 14px 基线开始，与折叠与否无关。 */
  --dsh-notes-top-band: 14px;
  --dsh-notes-sidebar-extra: calc(clamp(14px, var(--dsh-frame-leading-clearance, 0px), 44px) - 14px);
  padding-top: var(--dsh-notes-top-band);
  /* height:100% 与 padding-top 并存时必须用 border-box：
     默认的 content-box 会让内容盒高度 = 100% + 14px，底部被挤出面板。 */
  box-sizing: border-box;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  overflow: hidden;
}

/* ---------------- 左侧：文件夹栏 ----------------
   它是「面板内部的一块内容区」，不是第二条导航栏。所以：
   1) 用圆角 + 内缩边距，和 DSH 的会话栏轨道明确分开，不贴着也不等高；
   2) 底色比面板浅一档、边框更克制，避免和轨道抢视觉层级；
   3) 顶部留出与折叠轨道对齐的呼吸空间，不覆盖缩放按钮所在的区域。 */
.dsh-notes__left {
  width: 248px;
  flex: 0 0 248px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  /* 只保留左侧 10px 内缩，让它看起来是嵌在面板里的一个区块。
     左边不随 clearance 右移：整列右移会在交通灯下方留一条空白。
     顶部在面板基线之上再加 --dsh-notes-sidebar-extra：折叠会话栏时它
     变成 30px，左栏因此下移到 44px 处避开交通灯；未折叠时为 0，停在基线。
     阅读区不加这一项，所以折叠与否都不动。 */
  margin: var(--dsh-notes-sidebar-extra) 0 10px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}

.dsh-notes__folder {
  margin: 8px 8px 6px;
  width: calc(100% - 16px);
  height: 28px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dsh-notes__folder:hover { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.dsh-notes__folder-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}

/* ---------------- 置顶区 ----------------
   置顶区与文件树是两类东西，给它自己的边界：下方一条分隔线、更松的内边距，
   否则两块内容挤在一起，看起来像同一棵树。 */
.dsh-notes__pinned {
  flex: 0 0 auto;
  padding: 6px 8px 9px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dsh-notes__pinned-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 4px 6px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: .3px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-notes__pinned-count { margin-left: auto; font-weight: 500; }

/* 1 个占满一行；>=2 个两列并排；更多自动往下延伸。
   两列在容器够宽时才启用（第 3 个起也保持两列）。
   窄容器由 .dsh-notes--narrow 强制回单列，否则中文名会被截成两三个字。 */
.dsh-notes__pins { display: grid; grid-template-columns: 1fr; gap: 5px; }
.dsh-notes__pins--two { grid-template-columns: repeat(2, minmax(0, 1fr)); }

.dsh-notes__pin {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-width: 0;
  height: 30px;
  padding: 0 6px 0 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
  /* 排序是「按住后移动鼠标」的手势：不允许这里起选文，否则拖动时会划出一片
     蓝色选区。点按行为（打开文件 / 取消置顶）不受影响。 */
  user-select: none;
}
.dsh-notes__pin:hover {
  border-color: var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-notes__pin--active { border-color: var(--dsw-alias-brand-primary); }
.dsh-notes__pin-ic { flex: 0 0 14px; display: grid; place-items: center; }
.dsh-notes__pin-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-notes__pin-x {
  flex: 0 0 16px;
  height: 16px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  opacity: 0;
  color: var(--dsw-alias-label-secondary);
}
.dsh-notes__pin:hover .dsh-notes__pin-x { opacity: 1; }
.dsh-notes__pin-x:hover { background: color-mix(in srgb, currentColor 14%, transparent); color: var(--dsw-alias-state-error-primary, #e5484d); }

.dsh-notes__hint {
  padding: 4px 10px 8px;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--dsw-alias-label-secondary);
}

/* ---------------- 文件树 ---------------- */
/* 文件树的标题行：左边是分组名，右边是可见范围开关。
   放在这里而不是顶部工具栏，是因为它管的就是「这棵树显示什么」。 */
.dsh-notes__treehead {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 2px;
}
.dsh-notes__treehead-label {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: .3px;
  color: var(--dsw-alias-label-secondary);
}
/* 可见范围切换：做成一个小胶囊，两种状态一眼可辨 */
.dsh-notes__vis {
  flex: 0 0 auto;
  height: 20px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.dsh-notes__vis:hover {
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
}

/* 树操作按钮（定位 / 全部展开 / 全部收起）：方形图标按钮，
   与右侧的「可编辑 / 全部」文字胶囊并排但更紧凑。 */
.dsh-notes__treebtn {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsh-notes__treebtn:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
}
.dsh-notes__treebtn:disabled {
  opacity: .4;
  cursor: default;
}

/* 定位到文件后的短暂高亮：与 hover/active 区分开，用品牌色描边闪一下 */
.dsh-notes__node--located {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);
  outline: 1px solid var(--dsw-alias-brand-primary);
  outline-offset: -1px;
}

.dsh-notes__tree { flex: 1; min-height: 0; overflow: auto; padding: 10px 8px 12px; }
/* 树里的分组标题（文件夹 / 根目录文件）：
   比正文小一档、加粗、次要色，起到分隔作用但不抢视线。 */
.dsh-notes__group {
  padding: 10px 8px 4px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: .3px;
  color: var(--dsw-alias-label-secondary);
}
/* 第一组不需要上间距（置顶区已经给了分隔线） */
.dsh-notes__tree > .dsh-notes__group:first-child { padding-top: 2px; }
.dsh-notes__node {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 6px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  user-select: none;
}
.dsh-notes__node:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.dsh-notes__node--active {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 15%, transparent);
  color: var(--dsw-alias-brand-primary);
  font-weight: 600;
}
.dsh-notes__node--muted { color: var(--dsw-alias-label-secondary); cursor: default; }
.dsh-notes__node--muted:hover { background: transparent; }
.dsh-notes__caret {
  flex: 0 0 12px;
  display: grid;
  place-items: center;
  color: var(--dsw-alias-label-secondary);
  transition: transform .12s ease;
}
.dsh-notes__caret--open { transform: rotate(90deg); }
.dsh-notes__label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-notes__pinmark {
  flex: 0 0 16px;
  height: 16px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  opacity: 0;
  color: var(--dsw-alias-label-secondary);
}
.dsh-notes__node:hover .dsh-notes__pinmark { opacity: 1; }
.dsh-notes__pinmark--on { opacity: 1; color: var(--dsw-alias-brand-primary); }
.dsh-notes__pinmark:hover { background: color-mix(in srgb, currentColor 14%, transparent); }
.dsh-notes__children { margin-left: 11px; border-left: 1px solid var(--dsw-alias-border-l1); padding-left: 2px; }
.dsh-notes__tree-msg { padding: 6px 10px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }

/* ---------------- 右侧：tab 栏 + 内容 ---------------- */
.dsh-notes__right { flex: 1; min-width: 0; display: flex; flex-direction: column; }

/* tab 栏外层：负责整条的高度、底边与固定区布局。
   真正的标签滚动交给里面的 .dsh-notes__tabs，这样右侧的「下拉尖头 + 新建」
   可以固定不动，不会被标签一起滚走。 */
.dsh-notes__tabsbar {
  flex: 0 0 38px;
  height: 38px;
  /* 下拉面板以这条栏为定位基准（top:100% 即紧贴栏下沿）。 */
  position: relative;
  /* 必须 border-box：默认 content-box 会让 flex-basis/height 只约束内容盒，
     再加 padding-top:6px 后整条实际高 44px，标签贴底居中就落到 28px 处；
     而左栏文件夹按钮中心在 22px，两者差 6px，看起来就不在同一行。
     改成 border-box 后内容盒 32px，标签正好铺满，中心与文件夹按钮对齐。 */
  box-sizing: border-box;
  display: flex;
  align-items: flex-end;
  padding: 6px 8px 0;
  /* tab 栏不需要为交通灯让位：它位于左栏右侧，起点早就越过了交通灯
     （交通灯只到 x≈68）。这里若再加 clearance 内边距，就是二次内缩 ——
     会在左栏和第一个标签之间凭空多出一段空白。
     顶部让位已由面板的 padding-top 统一处理，左栏顶边与 tab 栏顶边因此对齐。 */
  padding-left: 8px;
  /* 底边通栏，视觉上才连贯。 */
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

.dsh-notes__tabs {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-end;
  gap: 2px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.dsh-notes__tabs::-webkit-scrollbar { height: 0; }

/* 右侧固定区：下拉尖头与新建按钮，始终贴在栏右端 */
.dsh-notes__tabsend {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-end;
  gap: 2px;
  padding-left: 4px;
}

/* 溢出下拉的尖头：与新建按钮同尺寸，风格一致 */
.dsh-notes__tab-more {
  flex: 0 0 28px;
  width: 28px; height: 28px;
  margin-bottom: 2px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsh-notes__tab-more:hover { background: color-mix(in srgb, currentColor 10%, transparent); color: var(--dsw-alias-label-primary); }

/* 下拉面板：右对齐挂在 tab 栏下方 */
.dsh-notes__tablist {
  position: absolute;
  top: 100%;
  right: 8px;
  z-index: 70;
  min-width: 220px;
  max-width: 340px;
  max-height: 320px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 9px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 8px 28px color-mix(in srgb, #000 18%, transparent);
}
.dsh-notes__tablist-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 30px;
  padding: 0 6px 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.dsh-notes__tablist-item:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
.dsh-notes__tablist-item--active {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 15%, transparent);
  color: var(--dsw-alias-brand-primary);
  font-weight: 600;
}
/* 下拉里的关闭按钮常显：这是列表，没有 hover 才出现的余地 */
.dsh-notes__tablist-item .dsh-notes__tab-x { visibility: visible; }
.dsh-notes__tablist-item .dsh-notes__dot { grid-area: auto; width: auto; height: auto; flex: 0 0 auto; }

/* 下拉的点击遮罩：点空白处收起。不能用 .dsh-notes__menu-mask 的深色，
   那会像弹了个对话框；这里只要一个透明的点击层。 */
.dsh-notes__menu-mask {
  position: fixed;
  inset: 0;
  z-index: 69;
  background: transparent;
}

.dsh-notes__tab {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 104px;
  max-width: 190px;
  height: 32px;
  padding: 0 6px 0 10px;
  border: 0;
  border-radius: 9px 9px 0 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.dsh-notes__tab:hover { background: color-mix(in srgb, currentColor 9%, transparent); color: var(--dsw-alias-label-primary); }
.dsh-notes__tab--active {
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
.dsh-notes__tab--active::after {
  content: "";
  position: absolute;
  left: 8px; right: 8px; bottom: 0;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--dsw-alias-brand-primary);
}
.dsh-notes__tab-ic { flex: 0 0 14px; display: grid; place-items: center; }
.dsh-notes__tab-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 尾部槽位：圆点与关闭按钮叠在同一格，避免切换时文字抖动 */
.dsh-notes__tabend {
  position: relative;
  flex: 0 0 16px;
  height: 16px;
  display: grid;
  place-items: center;
}
.dsh-notes__tab-x {
  grid-area: 1 / 1;
  width: 16px; height: 16px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-notes__tab-x:hover { background: color-mix(in srgb, currentColor 16%, transparent); color: var(--dsw-alias-label-primary); }
.dsh-notes__tab-x--idle { visibility: hidden; }
.dsh-notes__tab:hover .dsh-notes__tab-x--idle { visibility: visible; }
/* 未保存：圆点默认显示，hover 时让位给关闭按钮 */
.dsh-notes__dot {
  grid-area: 1 / 1;
  width: 16px; height: 16px;
  display: grid;
  place-items: center;
}
.dsh-notes__dot::before {
  content: "";
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary);
}
.dsh-notes__tab:hover .dsh-notes__dot { visibility: hidden; }
.dsh-notes__tab-x--dirty { visibility: hidden; }
.dsh-notes__tab:hover .dsh-notes__tab-x--dirty { visibility: visible; }

.dsh-notes__tab-add {
  flex: 0 0 28px;
  width: 28px; height: 28px;
  margin-bottom: 2px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsh-notes__tab-add:hover { background: color-mix(in srgb, currentColor 10%, transparent); color: var(--dsw-alias-label-primary); }

/* ---------------- 文档头 ---------------- */
.dsh-notes__dochead {
  flex: 0 0 30px;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-notes__docpath {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  font-family: var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10.5px;
}
.dsh-notes__btn {
  height: 22px;
  padding: 0 9px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.dsh-notes__btn:hover { border-color: var(--dsw-alias-border-l2); }
/* 主按钮：背景与前景必须用【配套】的两个 token。
   注意 --dsw-alias-brand-primary 是反色语义 —— 亮色主题下近黑、暗色主题下近白。
   前景若写死 #fff，暗色主题下就是白字压白底，几乎看不见。
   官方 ui-primitives 的 Button.primary 用的正是 label-primary-foreground 配对，
   hover 也走 button-primary-hover 而不是 filter。 */
.dsh-notes__btn--primary {
  background: var(--dsw-alias-button-primary-fill);
  border-color: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
  font-weight: 600;
}
.dsh-notes__btn--primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover);
  border-color: var(--dsw-alias-button-primary-hover);
  filter: none;
}
.dsh-notes__btn:disabled { opacity: .5; cursor: default; }

/* ---------------- 编辑区 ---------------- */
.dsh-notes__body { flex: 1; min-height: 0; display: flex; }
.dsh-notes__pane { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.dsh-notes__pane + .dsh-notes__pane { border-left: 1px solid var(--dsw-alias-border-l1); }


/* 单栏模式（仅编辑 / 仅预览）：唯一的面板占满宽度，不留分栏边线 */
.dsh-notes__body--single .dsh-notes__pane { flex: 1 1 auto; }

/* 显示方式切换器：压缩到与旁边按钮一致的高度，别把工具栏撑高 */
.dsh-notes__segmented { flex: 0 0 auto; }
.dsh-notes__segmented button,
.dsh-notes__segmented [role="tab"] { font-size: 11.5px; }

/* ---------------- 窄容器适配 ----------------
   面板被压窄时（窗口小 / 右侧栏被拉宽），左右分栏会让每栏只剩一两百像素、
   中文被逐字折断，所以改为上下堆叠：编辑在上、预览在下，各占一半高度。
   左侧文件夹栏的收放由 JS 按同一个断点控制。 */
.dsh-notes--narrow .dsh-notes__body { flex-direction: column; }
.dsh-notes--narrow .dsh-notes__pane { min-height: 120px; }
.dsh-notes--narrow .dsh-notes__pane + .dsh-notes__pane {
  border-left: 0;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
/* 窄容器下置顶改为单列：两列时每个胶囊只剩 ~100px，
   中文名会被截成两三个字，单列反而更好认。 */
.dsh-notes--narrow .dsh-notes__pins--two { grid-template-columns: 1fr; }

/* 窄容器下缩一缩内边距，把宽度尽量留给正文。
   这里同样保持「顶部 padding 为 0」——原因见 .dsh-notes__preview 的注释，
   否则窄窗下代码块工具条一样会悬空。 */
.dsh-notes--narrow .dsh-notes__editor { padding: 14px 16px 40px; }
.dsh-notes--narrow .dsh-notes__preview { padding: 0 16px 40px; }
.dsh-notes--narrow .dsh-notes__preview > *:first-child { margin-top: 14px; }

/* 窄容器下左栏不渲染，贴着窗口左上角的就是阅读区，此时改由它承担避让：
   没有左栏挡在交通灯前面，tab 栏会直接落到控件底下。 */
.dsh-notes--narrow .dsh-notes__right { padding-top: var(--dsh-notes-sidebar-extra); }

.dsh-notes__editor {
  flex: 1;
  min-height: 0;
  width: 100%;
  /* 必须 border-box：DSH 的 base.css 没有全局 box-sizing reset，默认 content-box
     会让 width:100% 之外再叠加 30+30 的左右内边距，textarea 因此比所在栏宽出
     60px，它自己的原生滚动条被挤出栏外，压在右侧预览正文上 —— 看起来像"两个
     界面叠在一起"，而且在编辑栏右缘下拉时其实拖到的是预览栏的滚动条。
     预览栏靠 flex 撑开、没有显式 width，不受影响，但为一致性也一并声明。 */
  box-sizing: border-box;
  padding: 22px 30px 60px;
  border: 0;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12.5px;
  line-height: 1.75;
  tab-size: 2;
}
.dsh-notes__preview {
  flex: 1;
  min-height: 0;
  overflow: auto;
  box-sizing: border-box;
  /* 顶部**不能**用 padding：代码块工具条（官方 CodeBlock 的 .bannerWrap）是
     position: sticky + top: 0，吸顶时贴的是滚动容器的 padding box 上沿。
     若容器带 padding-top，工具条就会停在 padding 下沿，上方留出一条空隙，
     视觉上「悬空」而不贴住阅读区顶边 —— 这正是之前的 bug。
     官方 ui-sidebar-documentpreview 的滚动容器同样是 padding: 0。
     顶部留白改由首个子元素的 margin 承担（见下一条规则），静止时观感不变。 */
  padding: 0 30px 60px;
}
/* 顶部留白：给首个子元素加 margin。用通配是因为 MarkdownText 的首个节点
   可能是段落、标题或列表，不固定；:first-child 保证只作用于第一个。 */
.dsh-notes__preview > *:first-child { margin-top: 22px; }

/* ---------------- 空状态 ---------------- */
.dsh-notes__empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 40px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
}
.dsh-notes__empty h3 { font-size: 13.5px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-notes__empty p { font-size: 12px; line-height: 1.6; max-width: 320px; }

/* ---------------- 不可预览文件（打开方式） ---------------- */
.dsh-notes__external {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 24px;
  overflow: auto;
}
.dsh-notes__external-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
  max-width: 420px;
}
.dsh-notes__external-glyph {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
  background: var(--dsw-alias-bg-elevated, rgba(0, 0, 0, 0.04));
  margin-bottom: 4px;
}
.dsh-notes__external-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  word-break: break-all;
}
.dsh-notes__external-hint {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
}
.dsh-notes__external-note {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
}
.dsh-notes__external-path {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  word-break: break-all;
  margin-top: 2px;
}

/* 分裂按钮：与官方 ui-open-in-app 的紧凑尺寸一致（高 28，左圆右圆拼接） */
.dsh-notes__external-actions { position: relative; margin-top: 6px; }
.dsh-notes__openwith {
  display: inline-flex;
  align-items: stretch;
  height: 28px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(0, 0, 0, 0.12));
  border-radius: 7px;
  background: var(--dsw-alias-bg-base, #fff);
  overflow: hidden;
}
.dsh-notes__openwith[data-busy] { opacity: 0.6; }
.dsh-notes__openwith-main {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  padding: 0 10px;
  font-size: 12.5px;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: 0;
  cursor: pointer;
}
.dsh-notes__openwith-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 中间分隔线：用伪元素而不是 border，避免和外框双线 */
.dsh-notes__openwith-caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  padding: 0;
  background: transparent;
  border: 0;
  border-left: 1px solid var(--dsw-alias-border-secondary, rgba(0, 0, 0, 0.12));
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsh-notes__openwith-main:hover,
.dsh-notes__openwith-caret:hover:not(:disabled) { background: var(--dsw-alias-bg-hover, rgba(0, 0, 0, 0.05)); }
.dsh-notes__openwith-main:disabled,
.dsh-notes__openwith-caret:disabled { cursor: default; }

.dsh-notes__openwith-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  /* 必须高于 .dsh-notes__menu-mask（69）：那个透明遮罩铺满整屏用来「点空白收起」，
     层级若低于它，菜单里的每一项都会被遮罩吃掉点击，表现为「点了没反应」。 */
  z-index: 70;
  min-width: 200px;
  max-width: 300px;
  max-height: 280px;
  overflow-y: auto;
  padding: 5px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(0, 0, 0, 0.08));
  background: var(--dsw-alias-bg-overlay, #fff);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.16);
  text-align: left;
}
.dsh-notes__openwith-item {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  font-size: 12.5px;
  color: var(--dsw-alias-label-primary);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-notes__openwith-item:hover:not(:disabled) { background: var(--dsw-alias-bg-hover, rgba(0, 0, 0, 0.05)); }
.dsh-notes__openwith-item:disabled { color: var(--dsw-alias-label-tertiary, rgba(0, 0, 0, 0.35)); cursor: default; }
.dsh-notes__openwith-sep { height: 1px; margin: 5px 6px; background: var(--dsw-alias-border-secondary, rgba(0, 0, 0, 0.08)); }
.dsh-notes__openwith-loading {
  padding: 7px 10px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}


/* ---------------- 右键菜单 ---------------- */
.dsh-notes__menu {
  position: fixed;
  z-index: 80;
  min-width: 140px;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 9px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 8px 28px color-mix(in srgb, #000 18%, transparent);
}
.dsh-notes__menu-item {
  display: block;
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.dsh-notes__menu-item:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
.dsh-notes__menu-item--danger { color: var(--dsw-alias-state-error-primary, #e5484d); }
.dsh-notes__menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--dsw-alias-border-l1);
}

/* 危险按钮：与官方 ui-primitives 的 Menu.danger 一致 —— 用红字 + 淡红底，
   不用「红底白字」。原因同主按钮：--dsw-alias-state-error-primary 随主题变化
   （亮色深红、暗色浅红），写死 #fff 前景在暗色主题下对比度不足。
   前景走 token、背景保持极淡，就不会有「白字压浅底」的问题。 */
.dsh-notes__btn--danger {
  border-color: var(--dsw-alias-state-error-primary, #e5484d);
  background: transparent;
  color: var(--dsw-alias-state-error-primary, #e5484d);
  font-weight: 600;
}
.dsh-notes__btn--danger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, 0.05));
  border-color: var(--dsw-alias-state-error-primary, #e5484d);
}
.dsh-notes__btn--danger:hover { filter: brightness(1.06); }

/* 弹层里的补充说明，比正文更小更淡 */
.dsh-notes__dialog-note {
  margin-top: -8px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
}

/* 拖动排序时的被拖项：半透明虚影，示意它正被拿起 */
.dsh-notes__pin--ghost { opacity: .45; }
/* 拖动排序中：手势光标 + 禁止选中文字（指针拖拽会划过其他卡片） */
.dsh-notes__pins--dragging { cursor: grabbing; }
.dsh-notes__pins--dragging .dsh-notes__pin { user-select: none; }

/* 插入缝隙指示线：绝对定位在卡片左缘外一点，表示「插到这张卡前面」；
   --after 变体贴右缘，表示「插到最后」。 */
.dsh-notes__pin { position: relative; }
.dsh-notes__pin-gap {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: -3.5px;
  width: 2px;
  border-radius: 1px;
  background: var(--dsw-alias-brand-primary);
  pointer-events: none;
}
.dsh-notes__pin-gap--after {
  left: auto;
  right: -3.5px;
}

/* 拖拽时文件夹高亮 */
.dsh-notes__node--drop {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent);
  outline: 1px solid var(--dsw-alias-brand-primary);
  outline-offset: -1px;
}

/* ---------------- 新建弹层 ---------------- */
.dsh-notes__mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, #000 32%, transparent);
}
.dsh-notes__dialog {
  width: 380px;
  max-width: calc(100vw - 40px);
  padding: 18px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 16px 44px color-mix(in srgb, #000 26%, transparent);
}
.dsh-notes__dialog h3 { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
.dsh-notes__dialog p { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.55; margin-bottom: 14px; }
.dsh-notes__kind { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px; }
.dsh-notes__kind-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
  text-align: left;
}
.dsh-notes__kind-btn--on { border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); }
.dsh-notes__kind-btn b { font-size: 12.5px; font-weight: 600; }
.dsh-notes__kind-btn span { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.45; }
.dsh-notes__input {
  width: 100%;
  height: 32px;
  padding: 0 10px;
  margin-bottom: 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12.5px;
  outline: none;
}
.dsh-notes__input:focus { border-color: var(--dsw-alias-brand-primary); }
.dsh-notes__dialog-foot { display: flex; justify-content: flex-end; gap: 8px; }
.dsh-notes__err { margin: -6px 0 12px; font-size: 11.5px; color: var(--dsw-alias-state-error-primary, #e5484d); }

/* ---------------- 插件页上的「检查更新」控件 ----------------
   这段控件渲染在 DSH 的插件详情页里，**不在 .dsh-notes 作用域内**，所以：
   1) 顶部那条作用域限定的 box-sizing reset 管不到它，这里必须自己声明
      box-sizing: border-box，否则按钮会因内边距而比设计宽出几像素；
   2) 颜色仍然只用主题 token（--dsw-*），明暗主题自动跟随。 */
.dsh-notes-update {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  box-sizing: border-box;
}
.dsh-notes-update__note {
  box-sizing: border-box;
  max-width: 420px;
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--dsw-alias-label-secondary);
}
.dsh-notes-update__btn {
  box-sizing: border-box;
  flex: 0 0 auto;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.dsh-notes-update__btn:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
}
/* 主按钮用官方那套配对 token（背景 + 前景会随主题反转），不要写死白色前景 */
.dsh-notes-update__btn--primary {
  border-color: var(--dsw-alias-button-primary-fill);
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
  font-weight: 600;
}
.dsh-notes-update__btn--primary:hover:not(:disabled) {
  border-color: var(--dsw-alias-button-primary-hover);
  background: var(--dsw-alias-button-primary-hover);
  color: var(--dsw-alias-label-primary-foreground);
}
/* 危险动作（本地链接安装时仍要更新）：红字 + 透明底，与官方 Menu.danger 同款 */
.dsh-notes-update__btn--danger {
  border-color: var(--dsw-alias-state-error-primary, #e5484d);
  background: transparent;
  color: var(--dsw-alias-state-error-primary, #e5484d);
  font-weight: 600;
}
.dsh-notes-update__btn--danger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, 0.05));
}
`;

/** 样式标签的 data 属性，用于识别本插件注入的样式。 */
const STYLE_ID = 'dsh-notes-styles';

/**
 * 注入样式表。
 * @returns 释放函数，移除注入的样式标签。
 */
export function injectStyles(): () => void {
  const existing = document.querySelector<HTMLStyleElement>(`style[data-dsh-notes="${STYLE_ID}"]`);
  if (existing !== null) {
    // 已被别的实例注入：不重复插入，也不需要移除。
    return () => {};
  }

  const style = document.createElement('style');
  style.setAttribute('data-dsh-notes', STYLE_ID);
  style.textContent = CSS;
  document.head.appendChild(style);

  return () => {
    style.remove();
  };
}
