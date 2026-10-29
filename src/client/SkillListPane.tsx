/**
 * 技能目录页：列出当前可用的 skill。
 *
 * 两个刻意的设计：
 * 1. **只读**。本插件不启用/禁用 skill、不改任何文件 —— 那是 skill 管理插件的事，
 *    这里只回答「它写了什么」，避免两套开关互相打架。
 * 2. **不自己解析文件**。列表来自 DSH 官方 skill 注册表（宿主半边去问），
 *    正文复用本插件现成的文件读取，所以看到的内容与 Agent 实际加载的完全一致。
 *
 * 点一条技能不会在这里展开任何东西：右侧读 `SKILL.md`，左侧整栏换成这条技能的
 * 文件夹树（见 `SkillTreePane`）。列表只负责「挑一条」。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NotesApi, SkillListing, SkillSummary } from './api';
import { IconClose, IconRefresh, IconSkill } from './icons';
import { dirnameOf, messageOf } from './paths';

/** 技能目录页属性。 */
export interface SkillListPaneProps {
  api: NotesApi;
  /**
   * 点某条技能时调用：进入技能详情页（正文 + 文件切页）。
   *
   * 列表里一行只有一个入口，所以不再需要「点文件」这种第二个回调 ——
   * 文件都在详情页里点。
   */
  onOpen: (skill: SkillSummary) => void;
  /** 在面板顶部做成一次性提示。 */
  onNotice: (message: string) => void;
  /** 重新读一遍技能目录（在外部新建了技能后点）。 */
  onRefresh: () => void;
  /** 重新读取进行中（转圈反馈）。 */
  refreshing: boolean;
  /** 关掉技能页、回到刚才的笔记（右上角 ×）。 */
  onClose: () => void;
}

/**
 * 技能目录页：列出当前可用的 skill，点一条在阅读器里看它的 SKILL.md 全文。
 *
 * 两个刻意的设计：
 * 1. **只读**。本插件不启用/禁用 skill、不改任何文件 —— 那是 skill 管理插件的事，
 *    这里只回答「它写了什么」，避免两套开关互相打架。
 * 2. **不自己解析文件**。列表来自 DSH 官方 skill 注册表（宿主半边去问），
 *    正文复用本插件现成的文件读取，所以看到的内容与 Agent 实际加载的完全一致。
 */
export function SkillListPane(props: SkillListPaneProps): JSX.Element {
  const { api, onOpen, onNotice, onRefresh, refreshing, onClose } = props;
  const [listing, setListing] = useState<SkillListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  /** 首次读取未完成时先不渲染列表，避免「空 → 有内容」闪一下。 */
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (fresh: boolean): void => {
      setLoading(true);
      api
        .skills()
        .then((result) => {
          setListing(result);
          setError(null);
          if (fresh) {
            const count = result.skills.length;
            onNotice(count === 0 ? '没有发现技能' : `已读取 ${count} 个技能`);
          }
        })
        .catch((err: unknown) => {
          setError(messageOf(err));
          if (fresh) onNotice(`读取技能失败：${messageOf(err)}`);
        })
        .finally(() => setLoading(false));
    },
    [api, onNotice],
  );

  // 进页面读一次；宿主那边有注册表就一定有结果，不需要轮询。
  useEffect(() => {
    load(false);
  }, [load]);

  const skills = listing?.skills ?? [];
  const icons = listing?.icons ?? {};

  /** 按名称/描述过滤（本地过滤，不必再打一次宿主）。 */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return skills;
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q),
    );
  }, [skills, query]);

  /**
   * 分成「系统内置」与「我的」两组。
   *
   * 内置技能是随 DSH 或其插件自带的（Office 三件套等），数量固定、用户改不了；
   * 用户自己的才是他真正关心的。混在一起时，内置的往往按字母排在前面，
   * 把自己写的挤到看不见的地方。
   */
  const groups = useMemo(() => {
    const bundled = shown.filter((skill) => skill.source === 'bundled');
    const mine = shown.filter((skill) => skill.source !== 'bundled');
    return { bundled, mine };
  }, [shown]);

  /**
   * 取某条技能自带的图标（宿主按「目录 + 相对路径」索引）。
   *
   * 目录优先用 `resourceBase`（内置技能只有它），再退到 SKILL.md 所在目录。
   */
  const iconFor = (skill: SkillSummary): string | null => {
    const dirs: string[] = [];
    if (skill.resourceDir !== undefined) dirs.push(skill.resourceDir);
    if (skill.path !== undefined) {
      const dir = dirnameOf(skill.path);
      if (!dirs.includes(dir)) dirs.push(dir);
    }
    for (const dir of dirs) {
      for (const rel of ['assets/icon.svg', 'assets/icon.png', 'icon.svg', 'icon.png']) {
        const found = icons[`${dir}\u0000${rel}`];
        if (found !== undefined) return found;
      }
    }
    return null;
  };

  /**
   * 渲染一条技能。
   *
   * 一行一个入口：点整行 = 读这条技能的 `SKILL.md`，并把**左侧文件栏**换成
   * 这条技能的文件夹树。之后再点左侧任意文件，就接着在右侧读它。
   *
   * 不在行内展开文件树：技能常把正文拆进多个子目录，塞在这一行里会把列表
   * 撑得很长、也很挤；左侧本来就是「文件导航」的位置，放那儿才对。
   *
   * @param skill - 技能摘要。
   * @returns 技能行。
   */
  const renderItem = (skill: SkillSummary): JSX.Element => {
    const icon = iconFor(skill);
    // 「内置」= 插件提供的技能，磁盘上没有 SKILL.md，正文由宿主从注册表取。
    const builtin = skill.path === undefined;
    return (
      <button
        type="button"
        className="dsh-notes__skillitem"
        title={skill.path ?? `${skill.name}（插件内置，正文由 DSH 提供）`}
        onClick={() => onOpen(skill)}
      >
        <span className="dsh-notes__skillicon">
          {icon === null ? <IconSkill size={15} /> : <img src={icon} alt="" width={16} height={16} />}
        </span>
        <span className="dsh-notes__skilltext">
          <span className="dsh-notes__skillname">
            <code>/{skill.name}</code>
            {!skill.modelInvocable && (
              <span className="dsh-notes__skilltag" title="只允许用户手动调用">
                仅手动
              </span>
            )}
            {builtin && (
              <span className="dsh-notes__skilltag" title="由插件内置，没有独立文件；正文仍可在这里查看">
                内置
              </span>
            )}
          </span>
          <span className="dsh-notes__skilldesc">{skill.description}</span>
        </span>
      </button>
    );
  };

  return (
    <div className="dsh-notes__skillpane">
      <div className="dsh-notes__skillhead">
        <div className="dsh-notes__skilltitle">
          <IconSkill size={14} />
          技能
          {listing !== null && <span className="dsh-notes__skillcount">{skills.length}</span>}
        </div>
        <div className="dsh-notes__skillsearch">
          <input
            className="dsh-notes__skillinput"
            type="search"
            placeholder="按名称或说明筛选"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="筛选技能"
          />
        </div>
        {/* 技能目录在磁盘上、由 DSH 热监听；但清单是「进页面时读一次」的，
            外部刚加了技能文件时点这里重读，免得用户以为没生效。 */}
        <button
          type="button"
          className={refreshing ? 'dsh-notes__treebtn dsh-notes__treebtn--spin' : 'dsh-notes__treebtn'}
          title="重新读取技能目录"
          aria-label="重新读取技能目录"
          onClick={onRefresh}
        >
          <IconRefresh />
        </button>
        <button
          type="button"
          className="dsh-notes__treebtn"
          title="关闭技能，回到刚才的笔记"
          aria-label="关闭技能"
          onClick={onClose}
        >
          <IconClose size={11} />
        </button>
      </div>

      <div className="dsh-notes__skillbody">
        {loading && listing === null && <div className="dsh-notes__hint">正在读取技能…</div>}

        {error !== null && (
          <div className="dsh-notes__skillerror">
            读取技能失败：{error}
            <button type="button" className="dsh-notes__btn" onClick={() => load(false)}>
              重试
            </button>
          </div>
        )}

        {listing !== null && !listing.available && (
          <div className="dsh-notes__skillempty">
            <h3>当前环境没有安装技能功能</h3>
            <p>
              技能列表由 DSH 的技能插件提供。这个环境没有加载它，所以这里暂时看不到内容；
              笔记本身的读写不受影响。
            </p>
          </div>
        )}

        {listing !== null && listing.available && shown.length === 0 && (
          <div className="dsh-notes__skillempty">
            <h3>{query.trim() === '' ? '还没有技能' : '没有匹配的技能'}</h3>
            <p>
              {query.trim() === ''
                ? '把技能写成 ~/.dsh/skills/<名称>/SKILL.md，或放进项目的 .dsh/skills/ 下，这里就会出现。'
                : '换个关键词试试。'}
            </p>
          </div>
        )}

        {/* 两组分开：内置在上（数量固定、不可改），自己的在下（用户真正关心的）。 */}
        {groups.bundled.length > 0 && (
          <div className="dsh-notes__skillgroup">
            <div className="dsh-notes__skillgroup-head">
              系统内置
              <span className="dsh-notes__skillgroup-count">{groups.bundled.length}</span>
            </div>
            <ul className="dsh-notes__skilllist">
              {groups.bundled.map((skill) => (
                <li key={skill.name}>{renderItem(skill)}</li>
              ))}
            </ul>
          </div>
        )}

        {groups.mine.length > 0 && (
          <div className="dsh-notes__skillgroup">
            <div className="dsh-notes__skillgroup-head">
              我的技能
              <span className="dsh-notes__skillgroup-count">{groups.mine.length}</span>
            </div>
            <ul className="dsh-notes__skilllist">
              {groups.mine.map((skill) => (
                <li key={skill.name}>{renderItem(skill)}</li>
              ))}
            </ul>
          </div>
        )}

        {/* 诊断行：只回答「这些技能是哪来的、按哪个目录找的」。
            真实环境里出现过「只列出内置技能」的报障，而本地用同一个注册表能全列出来，
            把来源摆出来比让人猜快得多。 */}
        {listing !== null && listing.available && (
          <div className="dsh-notes__skillfoot">
            {listing.skills.length} 条 · 供出 {listing.providers?.length ? listing.providers.join('、') : '未知'}
            {' · 登记 '}
            {listing.registeredProviders?.length ? listing.registeredProviders.join('、') : '无'}
            {listing.askedCwd !== undefined && ` · 工作目录 ${listing.askedCwd}`}
            {listing.complete === false && ' · 部分来源读取失败，列表可能不全'}
          </div>
        )}
      </div>
    </div>
  );
}

