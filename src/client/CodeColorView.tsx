/**
 * 代码染色视图：把整份文件按语言语法渲染成带颜色的行。
 *
 * 【为什么不复用 MarkdownText】MarkdownText 渲染的是 Markdown —— 它会把
 * `#` 当标题、`|` 当表格、`*` 当强调。`.sql`、`.java` 这些文件的内容不是
 * Markdown，直接丢进去会被解析得面目全非。染色要的是「原样按语法着色」，
 * 所以单独渲染：自己取 token、自己按行铺。
 *
 * 【为什么用 useCodeHighlighter 而不是自己接 shiki】它是 DSH 自己的高亮器：
 * 同步、grammar 白名单、颜色走 `--shiki-*` 主题变量（明暗主题自动跟随）。
 * 自己接一个高亮库等于往 bundle 里塞第二个高亮引擎，而且颜色要自己配一套。
 */
import { useMemo } from 'react';
import { useCodeHighlighter, type HighlightSpan } from '@deepseek-ai/dsh-client-ui-primitives';
import { colorWithFallback } from './codeColor';

/**
 * 染色最多渲染多少行。
 *
 * 【为什么必须封顶】`maxReadBytes` 是 8 MiB，一份 20 万行的日志也能被读进来；
 * 逐行渲染 div（每行再套 N 个 span）会把主线程卡死 —— 那是几万个 DOM 节点。
 * 一次只给屏幕看得过来的量：超过就染前这么多行，末尾明说截断了多少，
 * 用户想看全可以关掉染色用纯文本（编辑框是单个 textarea，没有这个问题）。
 */
const MAX_COLOR_LINES = 3000;

/** 代码染色视图属性。 */
export interface CodeColorViewProps {
  /** 完整文件内容。 */
  text: string;
  /** 语言 id（`sql`、`java`…）；undefined 或未注册的语法走纯文本兜底。 */
  language: string | undefined;
}

/**
 * 把一份代码渲染成带颜色的行。
 *
 * 行号单独一列：大块代码里「第几行」是定位的基本手段，而染色的目的正是
 * 让大块代码看得清 —— 没有行号等于少了一半用处。
 *
 * 语法还没加载完时 `highlight` 返回 undefined：此时渲染纯文本兜底，
 * grammar 注册完成后 `useCodeHighlighter` 会自己触发重渲染，不需要额外处理。
 *
 * @param props - 文本与语言。
 * @returns 带行号与颜色的代码视图。
 */
export function CodeColorView({ text, language }: CodeColorViewProps): JSX.Element {
  const highlight = useCodeHighlighter(language);

  /**
   * 取出按行分组的 token。
   *
   * 末尾的空行去掉：文件以换行结尾时 shiki 会多给一行空 token，
   * 留着会在代码末尾顶出一行空行号。
   */
  const lines = useMemo<HighlightSpan[][] | null>(() => {
    const result = highlight(text);
    if (result === undefined) return null;
    if (result.length > 0) {
      const last = result[result.length - 1];
      if (last !== undefined && last.length === 0) return result.slice(0, -1);
    }
    return result;
  }, [highlight, text]);

  /** 总行数（用于判断是否截断）与截断后要渲染的行。 */
  const total = lines?.length ?? 0;
  const shown = lines === null ? null : lines.slice(0, MAX_COLOR_LINES);
  const truncated = total > MAX_COLOR_LINES;

  // 语法未就绪（或语言不被支持）：纯文本兜底，保持等宽与行号，不会「闪成一段没格式的文字」。
  if (lines === null) {
    const plain = text.split('\n');
    if (plain.length > 0 && plain[plain.length - 1] === '') plain.pop();
    // 兜底分支同样封顶：语法还没加载完时也可能是一份巨长的文件。
    const plainShown = plain.slice(0, MAX_COLOR_LINES);
    return (
      <div className="dsh-notes__codecolor">
        {plainShown.map((line, index) => (
          // 行号 + 内容都是纯文本，行本身没有稳定 id，用下标作 key 是安全的
          // （列表内容整体不可变，不会重排）。
          <div className="dsh-notes__codeline" key={index}>
            <span className="dsh-notes__codeln">{index + 1}</span>
            <span className="dsh-notes__codetext">{line === '' ? '\u00a0' : line}</span>
          </div>
        ))}
        {plain.length > MAX_COLOR_LINES && (
          <div className="dsh-notes__codemore">
            只显示前 {MAX_COLOR_LINES} 行（共 {plain.length} 行）。关掉「染色」可看全文。
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="dsh-notes__codecolor">
      {shown?.map((run, index) => (
        <div className="dsh-notes__codeline" key={index}>
          <span className="dsh-notes__codeln">{index + 1}</span>
          <span className="dsh-notes__codetext">
            {run.length === 0
              ? '\u00a0'
              : run.map((span, at) => {
                  // 颜色必须补兜底：主题里缺这个变量时 var() 会静默回落到
                  // 继承色（黑），显示成「只有个别 token 有颜色」。
                  const color = colorWithFallback(span.style.color);
                  return (
                    // 同一段文本里可能有多个同色 span，下标作 key 同样安全。
                    <span key={at} style={color === undefined ? undefined : { color }}>
                      {span.text}
                    </span>
                  );
                })}
          </span>
        </div>
      ))}
      {truncated && (
        <div className="dsh-notes__codemore">
          只显示前 {MAX_COLOR_LINES} 行（共 {total} 行）。关掉「染色」可看全文。
        </div>
      )}
    </div>
  );
}
