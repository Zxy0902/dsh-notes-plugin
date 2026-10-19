/**
 * 笔记插件在「插件页」里的配置面板。
 *
 * **为什么自己画，而不用 DSH 的 settings 表单**
 *
 * 参考官方插件 `dsh-workbuddy-connect` 的做法（它的配置页在
 * `lib/client.js` 的 `WorkBuddyConfigPage`）：DSH 的插件页只认两种配置入口，
 *
 *   - `plugins.bundle.config`，key = **包名**（0.1.6+ 的包级入口，直接渲染在
 *     包详情页里、「包含的组件」上方）；
 *   - `plugins.row.config`，key = `<包名>#<行id>`（行级入口，要再点进行详情）。
 *
 * 前者更省事也更强：它是**包级**的，不需要点进某一行，渲染条件只是
 * `configured = ledger.bundles.has(pkg.name)` —— 与 `configForms` 服务、
 * `SettingsFormModel` 这些内部约定完全无关。我们只需要把页面挂上去，
 * 值走插件自己的 HTTP 路由（本插件本来就有一整套带 loopback 围栏的路由）。
 *
 * 这样做的好处正是用户要的那条：**不依赖 DSH 的内部表单机制**，
 * 版本升级换掉 settings 那一套也不会把配置页带崩。
 */
import { useCallback, useEffect, useState } from 'react';

/** 本插件的语言命名空间。 */
const NS = 'notes.config';

/** 中文字典。 */
const zh = {
  title: '笔记设置',
  intro: '技能阅读是笔记之外的一个附加功能，默认开启。只想要纯笔记工具的话，关掉它即可。',
  skillsReading: '启用技能阅读',
  skillsReadingHint: '关掉后文件夹下拉里不再出现「浏览技能…」，技能页也会收起。',
  skillRoots: '额外的技能目录',
  skillRootsHint: '每行一个绝对路径。留空表示只用 DSH 约定的位置（项目 .dsh/skills、~/.dsh/skills 等）。',
  maxReadBytes: '单个文件读取上限',
  maxReadBytesHint: '超过这个大小的文件在阅读器里打不开。',
  maxWriteBytes: '单个文件写入上限',
  maxWriteBytesHint: '保存时超过这个大小会被拒绝。',
  unitMb: 'MB',
  invalidSize: '请填一个大于 0 的数（单位 MB）。',
  advanced: '高级',
  advancedHint: '文件大小上限与自定义技能目录。绝大多数情况不需要改动。',
  advancedShow: '展开',
  advancedHide: '收起',
  advancedChanged: '这一组里有改动过的值',
  save: '保存',
  saving: '保存中…',
  saved: '已保存',
  readOnly: '本部署不支持从界面修改插件配置，下面只展示当前值。',
  loadFailed: '读取配置失败',
  saveFailed: '保存失败',
  invalidNumber: '请填一个正整数。',
  retry: '重试',
  loading: '正在读取配置…',
};

/** 英文字典。 */
const en = {
  title: 'Notes settings',
  intro: 'Skill reading is an extra beyond notes, on by default. Turn it off for a plain notes tool.',
  skillsReading: 'Enable skill reading',
  skillsReadingHint: 'When off, "Browse skills…" disappears from the folder menu.',
  skillRoots: 'Extra skill directories',
  skillRootsHint: 'One absolute path per line. Empty means the DSH defaults only.',
  maxReadBytes: 'Max file read size',
  maxReadBytesHint: 'Files larger than this cannot be opened in the reader.',
  maxWriteBytes: 'Max file write size',
  maxWriteBytesHint: 'Saves larger than this are rejected.',
  unitMb: 'MB',
  invalidSize: 'Enter a number greater than 0 (in MB).',
  advanced: 'Advanced',
  advancedHint: 'File size caps and custom skill directories. Most setups never need these.',
  advancedShow: 'Show',
  advancedHide: 'Hide',
  advancedChanged: 'Some values in this group are customized',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  readOnly: 'This deployment does not accept configuration edits; the current values are shown below.',
  loadFailed: 'Could not read the configuration',
  saveFailed: 'Could not save',
  invalidNumber: 'Enter a positive whole number.',
  retry: 'Retry',
  loading: 'Reading configuration…',
};

/** 与宿主 schema 里的默认值保持一致（收起时用来判断「改过没有」）。 */
const DEFAULT_CAPS = { maxReadBytes: 8 * 1024 * 1024, maxWriteBytes: 8 * 1024 * 1024 };

/** 宿主返回的配置值。 */
interface ConfigValues {
  skillsReading: boolean;
  skillRoots: string[];
  maxReadBytes: number;
  maxWriteBytes: number;
}

/** 配置页的属性（由 `inject` 提供）。 */
export interface NotesConfigProps {
  /** 语言读取器。 */
  t: (key: string) => string;
  /** `view` 为 `summary` 时只要一行摘要（包列表里的简述）。 */
  view?: string;
}

/**
 * 配置路由的路径。
 *
 * 与 `api.ts` 的写法保持一致：**文档相对**、不带前导斜杠。DSH 用
 * `<base href="./">` 提供 GUI，子路径部署下根绝对路径会逃出前缀而 404。
 */
const CONFIG_PATH = 'api/dsh-notes/config';

/** 一次读写的返回形状。 */
interface ConfigReply {
  ok?: boolean;
  values?: ConfigValues;
  writable?: boolean;
  error?: string;
}

/**
 * 调配置路由。
 * @param init - 传了就按 POST 发，否则 GET。
 * @returns 解析后的回复。
 */
async function callConfig(init?: { values: Partial<ConfigValues> }): Promise<ConfigReply> {
  const response = await fetch(CONFIG_PATH, {
    method: init === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    ...(init === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init) }),
  });
  const body = (await response.json().catch(() => ({}))) as ConfigReply;
  if (!response.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`);
  }
  return body;
}

/**
 * 插件页里的配置面板。
 *
 * 自带读取、编辑、保存三态：DSH 的插件页只负责把这块地方让出来，
 * 不提供任何表单框架，所以这里全部自理（与官方 workbuddy 插件一致）。
 *
 * @param props - 语言与视图模式。
 * @returns 配置面板；`summary` 模式下只有一行摘要。
 */
export function NotesConfigCard(props: NotesConfigProps): JSX.Element {
  const { t } = props;

  /** 已经生效的值（保存成功后以服务端回读为准）。 */
  const [saved, setSaved] = useState<ConfigValues | null>(null);
  /** 用户正在编辑的草稿。 */
  const [draft, setDraft] = useState<ConfigValues | null>(null);
  /** 目录草稿：用户敲到一半时不能立刻拆行，否则换行会被吃掉。 */
  const [rootsText, setRootsText] = useState<string>('');
  /** 宿主是否接受写入。 */
  const [writable, setWritable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  /**
   * 高级区是否展开。
   *
   * 不持久化：每次打开插件页都从收起开始。这几个值改过一次之后就再也不动，
   * 记住「上次展开过」只会让它下次又占满屏幕。
   */
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const reply = await callConfig();
      const values = reply.values ?? null;
      setSaved(values);
      setDraft(values);
      setRootsText(values === null ? '' : values.skillRoots.join('\n'));
      setWritable(reply.writable === true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async (): Promise<void> => {
    if (draft === null) return;
    setSaving(true);
    setError(null);
    try {
      const roots = rootsText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      const reply = await callConfig({
        values: {
          skillsReading: draft.skillsReading,
          skillRoots: roots,
          maxReadBytes: draft.maxReadBytes,
          maxWriteBytes: draft.maxWriteBytes,
        },
      });
      const values = reply.values ?? null;
      if (values !== null) {
        setSaved(values);
        setDraft(values);
        setRootsText(values.skillRoots.join('\n'));
      }
      setFlash(t('saved'));
      // 提示两秒后自己消失，不打断下一次编辑。
      setTimeout(() => setFlash((current) => (current === t('saved') ? null : current)), 2000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [draft, rootsText, t]);

  // summary 模式：包列表里只要一句说明，不渲染整个表单。
  if (props.view === 'summary') return <>{t('intro')}</>;

  if (loading) return <p className="dsh-notes__confignote">{t('loading')}</p>;
  if (error !== null && draft === null) {
    return (
      <p className="dsh-notes__confignote">
        {t('loadFailed')}：{error}
        <button type="button" className="dsh-notes__configbtn" onClick={() => void load()}>
          {t('retry')}
        </button>
      </p>
    );
  }
  if (draft === null || saved === null) return <p className="dsh-notes__confignote">{t('loadFailed')}</p>;

  /**
   * 高级区里是否有值偏离默认。
   *
   * 收起时用一个圆点提示「这里改过东西」，否则用户改完上限、折叠起来，
   * 下次就再也想不起来自己动过哪一项。
   */
  const advancedTouched =
    draft.maxReadBytes !== DEFAULT_CAPS.maxReadBytes ||
    draft.maxWriteBytes !== DEFAULT_CAPS.maxWriteBytes ||
    saved.skillRoots.length > 0;

  const dirty =
    draft.skillsReading !== saved.skillsReading ||
    draft.maxReadBytes !== saved.maxReadBytes ||
    draft.maxWriteBytes !== saved.maxWriteBytes ||
    rootsText !== saved.skillRoots.join('\n');

  return (
    <div className="dsh-notes__config">
      <p className="dsh-notes__configintro">{t('intro')}</p>
      {writable ? null : <p className="dsh-notes__confignote">{t('readOnly')}</p>}

      {/* 技能开关：本面板唯一需要常态可见的设置。 */}
      <div className="dsh-notes__configfield dsh-notes__configfield--lead">
        <div className="dsh-notes__configfield-head">
          <div className="dsh-notes__configfield-labels">
            <span className="dsh-notes__configfield-label">{t('skillsReading')}</span>
            <span className="dsh-notes__configfield-hint">{t('skillsReadingHint')}</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={draft.skillsReading}
            aria-label={t('skillsReading')}
            disabled={!writable || saving}
            className={`dsh-notes__configswitch${draft.skillsReading ? ' dsh-notes__configswitch--on' : ''}`}
            onClick={() => setDraft({ ...draft, skillsReading: !draft.skillsReading })}
          >
            <span className="dsh-notes__configswitch-thumb" />
          </button>
        </div>
      </div>

      {/*
        高级区：文件大小上限与自定义技能目录。
        这几项 90% 的人一辈子不会碰，常态展开只会把上面那个开关淹掉。
        默认收起，但**不隐藏** —— 需要的人找得到，不需要的人看不见。
        收起时若其中某项与默认值不同，标题上会带一个圆点，避免「改过却忘了」。
      */}
      {/*
        高级区：文件大小上限与自定义技能目录。
        这几项 90% 的人一辈子不会碰，常态展开只会把上面那个开关淹掉。
        默认收起，但**不隐藏** —— 需要的人找得到，不需要的人看不见。

        整条都是按钮（不是只有「高级」两个字可点）：这是之前最容易踩的地方，
        文案是标签、只有词可点，用户会以为整条都能点，点旁边没反应。
        视觉上做成一颗有边框的胶囊，和上面的设置项区分开，明确是「可展开的东西」。
      */}
      <div className="dsh-notes__advanced">
        <button
          type="button"
          className={`dsh-notes__advanced-toggle${advancedOpen ? ' dsh-notes__advanced-toggle--open' : ''}`}
          aria-expanded={advancedOpen}
          aria-controls="notes-advanced-body"
          onClick={() => setAdvancedOpen(!advancedOpen)}
        >
          <span className="dsh-notes__advanced-caret" aria-hidden="true">
            {advancedOpen ? '▾' : '▸'}
          </span>
          <span className="dsh-notes__advanced-title">{t('advanced')}</span>
          {advancedTouched ? (
            <span className="dsh-notes__advanced-dot" title={t('advancedChanged')} aria-hidden="true" />
          ) : null}
          <span className="dsh-notes__advanced-hint">{t('advancedHint')}</span>
          <span className="dsh-notes__advanced-action">
            {advancedOpen ? t('advancedHide') : t('advancedShow')}
          </span>
        </button>

        {advancedOpen ? (
          <div className="dsh-notes__advanced-body" id="notes-advanced-body">
            <SizeField
              id="notes-max-read"
              label={t('maxReadBytes')}
              hint={t('maxReadBytesHint')}
              bytes={draft.maxReadBytes}
              unit={t('unitMb')}
              disabled={!writable || saving}
              invalidLabel={t('invalidSize')}
              onChange={(bytes) => setDraft({ ...draft, maxReadBytes: bytes })}
            />
            <SizeField
              id="notes-max-write"
              label={t('maxWriteBytes')}
              hint={t('maxWriteBytesHint')}
              bytes={draft.maxWriteBytes}
              unit={t('unitMb')}
              disabled={!writable || saving}
              invalidLabel={t('invalidSize')}
              onChange={(bytes) => setDraft({ ...draft, maxWriteBytes: bytes })}
            />
            <div className="dsh-notes__configfield">
              <div className="dsh-notes__configfield-labels">
                <label className="dsh-notes__configfield-label" htmlFor="notes-skill-roots">
                  {t('skillRoots')}
                </label>
                <span className="dsh-notes__configfield-hint">{t('skillRootsHint')}</span>
              </div>
              <textarea
                id="notes-skill-roots"
                className="dsh-notes__configtextarea"
                rows={3}
                value={rootsText}
                disabled={!writable || saving}
                onChange={(event) => setRootsText(event.target.value)}
              />
            </div>
          </div>
        ) : null}
      </div>

      {error === null ? null : (
        <p className="dsh-notes__configerror" role="alert">
          {t('saveFailed')}：{error}
        </p>
      )}

      <div className="dsh-notes__configactions">
        <button
          type="button"
          className="dsh-notes__configbtn dsh-notes__configbtn--primary"
          disabled={!writable || saving || !dirty}
          onClick={() => void save()}
        >
          {saving ? t('saving') : t('save')}
        </button>
        {flash === null ? null : <span className="dsh-notes__configsaved">{flash}</span>}
      </div>
    </div>
  );
}

/**
 * 一个带单位的数字字段。
 *
 * 界面上按 **MB** 填（8 就是 8 MB），存的是**字节** —— 宿主 schema 与所有
 * 路由判断都用字节，换算只在显示/解析这一层做，不改变存储语义。
 *
 * 为什么不做成「直接填字节」：8388608 这种数字对用户没有意义，而且数错一位
 * 就差三个数量级。8 MB 是人人能判断的量。
 *
 * 小数按 1 MB 精度处理：0.5 → 524288 字节。不取整到 1024 的倍数，
 * 因为那会让用户填的 1.5 变成 1.5 MB 的近似值，反而更难解释。
 */
const BYTES_PER_MB = 1024 * 1024;

/** 字节 → 界面上的 MB 数字（能整除就显示整数，否则保留两位）。 */
function bytesToMb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / BYTES_PER_MB;
  // 8 → "8"，1.5 → "1.5"，0.25 → "0.25"；多余的小数位去掉。
  return String(Number(mb.toFixed(2)));
}

/** 界面上的 MB → 字节。 */
function mbToBytes(mb: number): number {
  return Math.round(mb * BYTES_PER_MB);
}

function SizeField(props: {
  id: string;
  label: string;
  hint: string;
  /** 当前值，单位字节。 */
  bytes: number;
  unit: string;
  disabled: boolean;
  invalidLabel: string;
  /** 回传字节。 */
  onChange: (bytes: number) => void;
}): JSX.Element {
  const [text, setText] = useState(bytesToMb(props.bytes));
  const [invalid, setInvalid] = useState(false);
  /*
   * 注意这里**只在用户输入时**才 `props.onChange`。
   *
   * 这是为了防止「悄悄改值」：界面上按 MB 显示并保留两位小数，若原值是
   * 1000000 字节，会显示成 "0.95" MB；一旦把显示值反解回字节，就变成 996147，
   * 用户明明只改了旁边另一个字段，这个上限却被动了，而且他不会知道。
   *
   * 所以：没编辑过就不上报，原字节原样留在草稿里，dirty 判断也不会误判。
   */

  // 外部值变了（保存后回读）就同步回来。
  useEffect(() => {
    setText(bytesToMb(props.bytes));
    setInvalid(false);
  }, [props.bytes]);

  return (
    <div className="dsh-notes__configfield">
      <div className="dsh-notes__configfield-labels">
        <label className="dsh-notes__configfield-label" htmlFor={props.id}>
          {props.label}
        </label>
        <span className="dsh-notes__configfield-hint">{props.hint}</span>
      </div>
      <div className="dsh-notes__configunit">
        <input
          id={props.id}
          type="text"
          inputMode="decimal"
          className="dsh-notes__configinput dsh-notes__configinput--unit"
          value={text}
          disabled={props.disabled}
          aria-invalid={invalid || undefined}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            const parsed = Number(next.trim());
            // 非法值只标红，不改草稿 —— 否则用户敲到一半就被吞掉。
            const usable = next.trim() !== '' && Number.isFinite(parsed) && parsed > 0;
            setInvalid(!usable);
            if (usable) props.onChange(mbToBytes(parsed));
          }}
          // 清空即放弃编辑：把框恢复成当前生效值，原字节保持不动。
          onBlur={() => {
            if (text.trim() === '') {
              setText(bytesToMb(props.bytes));
              setInvalid(false);
            }
          }}
        />
        <span className="dsh-notes__configunit-suffix">{props.unit}</span>
      </div>
      {invalid ? <p className="dsh-notes__configerror">{props.invalidLabel}</p> : null}
    </div>
  );
}

export { NS, zh, en };
