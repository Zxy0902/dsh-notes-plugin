/**
 * 技能正文阅读区。
 *
 * 只做一件事：把一条技能的正文（`SKILL.md` 或用户在左侧文件树里点开的
 * 某个子文件）渲染成只读的 Markdown，顶部给出技能名与退出入口。
 *
 * 文件树**不在这里** —— 它在左侧的 `SkillTreePane`，替换掉原来的笔记文件树。
 * 技能常把正文拆进 `rules/`、`references/` 等子目录，塞进这里会把正文挤窄，
 * 而左侧那一栏本来就是「文件导航」的位置。
 */
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives';

const MARKDOWN_LABELS: MarkdownLabels = {
  code: { copyLabel: '复制', copiedLabel: '已复制' },
  footnotes: '脚注',
};

/** 图标：返回（`←`）。 */
function IconBack(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 3.5 5.5 8 10 12.5" />
    </svg>
  );
}

/** 技能详情页属性。 */
export interface SkillDetailPaneProps {
  /** 技能名（显示在标题上）。 */
  name: string;
  /** 技能目录；null 表示这是没有独立文件的插件内置技能。 */
  dir: string | null;
  /** 正文。 */
  content: string | null;
  /** 正文的来源路径（`SKILL.md` 或用户在列表里点开的某个子文件）。 */
  sourcePath: string | null;
  /** 正文读取中。 */
  contentLoading: boolean;
  /** 正文读取失败原因。 */
  contentError: string | null;
  /** 技能名右边的小标签（「内置」「仅手动」）。 */
  chip: string | null;
  /**
   * 退出技能浏览。
   *
   * 与左侧「‹ 笔记」是**同一个动作**（外壳里传的是同一个函数）：左侧恢复笔记
   * 目录、右侧回到你本来在看的笔记。想看技能列表就点上方「技能」tab ——
   * 那是另一件事，不该塞在这里当第二个按钮。
   */
  onBack: () => void;
}

export function SkillDetailPane(props: SkillDetailPaneProps): JSX.Element {
  const { name, dir, content, sourcePath, contentLoading, contentError, chip, onBack } = props;

  return (
    <div className="dsh-notes__skilldetail">
      {/* 头部：返回 + 技能名。
          **整个技能浏览只有这一个退出入口** —— 左侧栏不再放按钮，否则同一个动作
          会在两个位置各摆一个，用户会以为是两件事。回到技能列表交给上方「技能」tab。 */}
      <div className="dsh-notes__sd-head">
        <button
          type="button"
          className="dsh-notes__sd-back"
          title="退出技能浏览，回到刚才的笔记"
          onClick={onBack}
        >
          <IconBack />
          <span className="dsh-notes__sd-backtext">返回</span>
        </button>
        <code className="dsh-notes__sd-name">/{name}</code>
        {chip !== null && <span className="dsh-notes__sd-chip">{chip}</span>}
      </div>

      <div className="dsh-notes__sd-body">
        {/* 读的是子文件时，先说清「你正在看哪个」——否则会以为技能正文就是这样 */}
        {sourcePath !== null && dir !== null && sourcePath !== `${dir}/SKILL.md` && (
          <div className="dsh-notes__sd-origin">正在阅读 · {sourcePath.split('/').slice(-2).join('/')}</div>
        )}
        {contentLoading && content === null && <div className="dsh-notes__sd-treetip">正在读取…</div>}
        {contentError !== null && <div className="dsh-notes__sd-error">读取失败：{contentError}</div>}
        {content !== null && (
          <div className="dsh-notes__preview dsh-notes__sd-md">
            <MarkdownText text={content} labels={MARKDOWN_LABELS} variant="body" />
          </div>
        )}
      </div>
    </div>
  );
}
