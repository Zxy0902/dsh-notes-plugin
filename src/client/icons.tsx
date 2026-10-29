/**
 * 共用的内联 SVG 小图标。
 *
 * 为什么单独成文件：外壳（`NotesPanel`）与技能列表（`SkillListPane`）都要用
 * 同一批图标。复制粘贴两遍的话，日后改一个忘一个，两处就会长得不一样。
 *
 * 全部内联：不引外部资源，随主题色走（`currentColor`）。
 */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** 关闭（`×`）：tab 上的关闭键、弹层右上角。 */
export function IconClose({ size = 10 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} strokeWidth={1.9} aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

/** 刷新图标：带箭头的开口圆环（Material 的 refresh 语义 = 重新读取）。 */
export function IconRefresh({ size = 13 }: { size?: number }): JSX.Element {
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
export function IconSkill({ size = 13 }: { size?: number }): JSX.Element {
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

/** 文件夹图标。 */
export function IconFolder({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
      <path d="M2 4.4a1 1 0 0 1 1-1h2.6l1.3 1.6H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.4Z" />
    </svg>
  );
}

/** 折叠箭头。 */
export function IconCaret(): JSX.Element {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" {...stroke} strokeWidth={2} aria-hidden="true">
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

/** 图钉图标。 */
export function IconPin({ size = 11 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
      <path d="M9.6 2.4 13.6 6.4M11 4.9 7.6 8.3c-.5.5-1.3.6-1.9.3L4 9.8 2.4 8.2 3.6 6.6c-.3-.6-.2-1.4.3-1.9l3.4-3.4" />
    </svg>
  );
}

/** 放大镜。 */
export function IconSearch({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 13.6 13.6" />
    </svg>
  );
}

/** 定位图标：准星，表示「定位到当前文件」。 */
export function IconLocate({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
      <circle cx="8" cy="8" r="5" />
      <path d="M8 1.4v2.2M8 12.4v2.2M1.4 8h2.2M12.4 8h2.2" />
      <circle cx="8" cy="8" r="1.4" />
    </svg>
  );
}

/** 展开图标：上下箭头朝外（Material 的 unfold_more 语义 = 打开全部）。 */
export function IconUnfoldMore({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
      <path d="M5 5.2 8 2.2l3 3M11 10.8 8 13.8l-3-3" />
    </svg>
  );
}

/** 收缩图标：上下箭头朝内（Material 的 unfold_less 语义 = 收起全部）。 */
export function IconUnfoldLess({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
      <path d="M5 2.6 8 5.6l3-3M11 13.4 8 10.4l-3 3" />
    </svg>
  );
}

/** 勾选：下拉里表示「当前选中的那一项」。 */
export function IconCheck({ size = 11 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} strokeWidth={1.8} aria-hidden="true">
      <path d="M3.4 8.4 6.6 11.6 12.6 4.8" />
    </svg>
  );
}

/** 加号。 */
export function IconPlus(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" {...stroke} aria-hidden="true">
      <path d="M8 3.6v8.8M3.6 8h8.8" />
    </svg>
  );
}

/** 向下的小尖头：tab 栏放不下时，点它下拉列出被遮挡的标签页。 */
export function IconChevronDown({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
      <path d="M4.2 6.4 8 10.2l3.8-3.8" />
    </svg>
  );
}
