/**
 * 插件页上的「检查更新 / 更新」控件。
 *
 * 注册在 DSH 官方席位 `plugins.detail.actions` 上：宿主把每个插件详情页的主体
 * （subject）交给每条注册项，我们只认自己的 bundle，其余一律返回 null —— 所以
 * 别人的插件页不会多出这个按钮。
 *
 * 检查与更新分工明确：
 * - **检查**走本插件自己的宿主半边（`checkLatest`）去问 npm 的 `latest` dist-tag。
 *   不用插件管理服务的 `inspect`：那是**安装前校验**，包一旦装进 profile 就会被
 *   它以 `already-installed` 拒绝，拿它当「检查更新」必然一进页面就失败。
 * - **更新**走官方 `installBundle('<包名>@<版本>')`，让 DSH 用它自己的安装流程升级
 *   （对已安装的包就是升级）—— 与用户在插件页手动安装同一条路径，本插件
 *   **不自己跑包管理器、不碰 profile 文件**，因此不会对 DSH 自身产生副作用。
 *
 * 两处刻意保守：
 * 1. 拿不到 `pluginManager`（老版本 DSH、精简 profile、服务改名）时**整个控件
 *    不渲染**，只当没有这个功能，绝不报错；
 * 2. 安装脚本需要批准时**不代为批准**（不传 `approvedBuilds`），只提示去哪里确认。
 */
import { useCallback, useEffect, useState } from 'react';

/** 本插件的 npm 包名：更新只针对自己，别的 bundle 页返回 null。 */
const SELF_PACKAGE = 'dsh-client-ui-notes';

/** 插件详情页的主体（只声明本控件用得到的字段）。 */
interface UpdateSubject {
  kind?: string;
  pkg?: {
    name?: string;
    version?: string;
    enabled?: boolean;
    installed?: boolean;
  };
}

/** `installBundle` 的变更结果（只声明用到的字段）。 */
interface InstallChange {
  changed?: boolean;
  application?: string;
  stage?: string;
  target?: string;
  error?: { code?: string; message?: string; diagnostic?: string };
  pendingBuilds?: string[];
}

/** Remote 调用的统一信封。 */
interface RemoteAnswer<T> {
  ok?: boolean;
  value?: T;
  error?: { code?: string; message?: string };
}

/**
 * `remote.pluginManager` 的最小面：只需要安装能力，缺失即降级。
 *
 * 注意参数个数：gateway 会按 descriptor 严格校验，`installBundle` 是
 * `(spec, options)` 两个业务参数（第三个才是可选 AbortSignal），少传会抛
 * `client api: ... expected 2 business argument(s) ... got 1`。
 */
interface PluginManagerFacade {
  installBundle?(
    spec: string,
    options?: { enabled?: boolean; requestId?: string },
  ): Promise<RemoteAnswer<InstallChange> | null>;
}

/** 宿主注册进来的依赖。 */
export interface UpdateActionProps {
  /** 详情页主体（宿主给的 owner props）。 */
  subject?: UpdateSubject;
  /** `remote.pluginManager` 快照；拿不到时为 null（控件不渲染）。 */
  manager?: PluginManagerFacade | null;
  /**
   * 查 npm 上的最新版本（由本插件宿主半边提供）。
   *
   * 返回宿主自己读出来的**包名**一并带上：插件被改名/复刻后，规格仍指向它自己。
   *
   * @param fresh - true 时绕过宿主端缓存。
   * @returns 包名、最新版本号，以及该版本的 tarball 直链（宿主 0.1.7 起提供；
   *          缺省时退回 `包名@精确版本` 的规格）；失败时抛出带可读原因的异常。
   */
  checkLatest?: (fresh: boolean) => Promise<{
    name: string;
    version: string;
    tarball?: string;
  }>;
  /** 问宿主：当前是不是本地链接安装。 */
  probeLocalInstall?: () => Promise<boolean>;
}

/** 控件状态机。 */
type Phase =
  | { name: 'idle' }
  | { name: 'checking' }
  | { name: 'latest'; version: string | null }
  | { name: 'outdated'; version: string }
  | { name: 'confirm'; version: string }
  | { name: 'updating'; version: string }
  | { name: 'done'; version: string | null; restart: boolean; blocked: boolean }
  | { name: 'error'; message: string };

/**
 * 判断 latest 是否比 current 新（只用来决定要不要提示更新）。
 *
 * 按 semver 的比较规则实现，但**不做完整解析**（不处理 build 元数据 `+xxx`，
 * 也不做版本范围匹配）：主次修订号逐段数值比较；主版本相同时按预发布段比较 ——
 * 无预发布标记的更新（`0.2.0` > `0.2.0-rc.1`），同为预发布则逐段比（数字段按
 * 数值、数字段小于字母段、段数多的更大），所以 `0.2.0-rc.2` > `0.2.0-rc.1`。
 *
 * @param latest - 远端版本号。
 * @param current - 本地已装版本号。
 * @returns latest 是否更新。
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const split = (value: string): { core: number[]; pre: string } => {
    const [core = '', pre = ''] = value.split('-');
    return { core: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const a = split(latest);
  const b = split(current);

  for (let i = 0; i < 3; i += 1) {
    const x = a.core[i] ?? 0;
    const y = b.core[i] ?? 0;
    if (x !== y) return x > y;
  }

  // 主版本相同：有预发布标记的更旧。
  if (a.pre === '') return b.pre !== '';
  if (b.pre === '') return false;

  const pa = a.pre.split('.');
  const pb = b.pre.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return false;
    if (y === undefined) return true;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff > 0;
      continue;
    }
    // semver：数字标识符优先级低于字母标识符。
    if (xNumeric !== yNumeric) return yNumeric;
    if (x !== y) return x > y;
  }
  return false;
}

/** 把官方错误码翻成中文（只覆盖插件管理文档里列出的那些，其余给通用文案）。 */
function codeText(code: string | undefined): string | null {
  switch (code) {
    case 'network':
      return '网络不可用，无法访问包仓库';
    case 'not-found':
      return '包仓库里找不到这个版本';
    case 'no-matching-version':
      return '没有匹配的版本';
    case 'disk-full':
      return '磁盘空间不足';
    case 'permission':
      return '没有写入权限';
    case 'integrity':
      return '包完整性校验失败';
    case 'build-blocked':
      return '安装脚本需要先在插件页批准';
    case 'already-installed':
      return '宿主拒绝覆盖安装已安装的同名包（带 HMR 的宿主有此限制），请在侧栏「插件」页或插件市场里更新';
    case 'management-required':
      return '当前 profile 不允许由插件管理安装';
    case 'unaddressable':
      return '这个 profile 无法被定位，无法安装';
    case 'invalid-spec':
      return '版本规格无效';
    case 'not-bundle':
      return '这个包不是 DSH bundle，无法作为插件安装';
    case 'unknown':
      return '安装失败（原因未知）';
    default:
      return null;
  }
}

/** 从信封里取失败原因（优先错误码的中文，其次后端消息）。 */
function failureText(answer: { error?: { code?: string; message?: string } } | null): string {
  const byCode = codeText(answer?.error?.code);
  if (byCode !== null) return byCode;
  const message = answer?.error?.message;
  return typeof message === 'string' && message !== '' ? message : '操作失败';
}

/**
 * 把捕获到的异常转成可展示的一句话。
 *
 * **必须带上原始消息**：这套 Remote 是**严格校验参数个数**的，参数个数不对时
 * 抛的是 `client api: <命名空间>/<方法> expected N business argument(s) ...,
 * got M` —— 这种信息只有原文才看得出问题；之前只显示「检查更新失败」，
 * 把真实原因吞掉了，排查只能靠猜。
 */
function errorText(error: unknown, label: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message === '' ? label : `${label}：${message}`;
}

/**
 * 插件页详情页头部控件。
 * @param props - 宿主给的 subject + 本插件注入的 manager / probeLocalInstall。
 */
export function NotesUpdateAction(props: UpdateActionProps): JSX.Element | null {
  const subject = props.subject;
  const pkg = subject?.pkg;
  const manager = props.manager ?? null;

  /**
   * 本次会话里我们**亲手装成**的版本。
   *
   * 为什么需要它：`pkg.version` 是 DSH 插件页那份包快照，只有它自己的 store
   * 刷新才会变；本控件是通过 `remote.pluginManager.installBundle` 装的，拿不到
   * 那个 store，也没有公开的刷新入口。于是升级成功后 `pkg.version` 仍是旧值，
   * `check()` 一比较又判定「有新版本」，按钮继续可点 —— 再点一次必然撞上
   * 宿主的 `already-installed`。
   *
   * 我们比页面更清楚「这次装成了什么」：`change.application === 'applied'`
   * 就是权威信号。用它覆盖掉可能过期的 `pkg.version`，界面立刻自洽。
   *
   * 失效边界很自然：重新进入页面时组件会重新挂载，这里归零，回到以
   * `pkg.version` 为准 —— 那时 DSH 的快照已经刷新过了。
   */
  const [appliedVersion, setAppliedVersion] = useState<string | null>(null);

  const pageVersion = typeof pkg?.version === 'string' ? pkg.version : null;
  /** 当前实际安装的版本：本次会话装成过就以它为准，否则以页面快照为准。 */
  const installed = appliedVersion ?? pageVersion;

  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  /** 是否本地链接安装（探测失败按否处理）。 */
  const [local, setLocal] = useState(false);
  /**
   * 宿主报出来的本插件包名（检查更新时一并返回）。
   *
   * 用它而不是写死的常量去拼安装规格：插件被改名/复刻后依然指向自己。
   */
  const [remoteName, setRemoteName] = useState<string | null>(null);
  /**
   * 最新版本的 tarball 直链（宿主 0.1.7 起随查版本一起返回）。
   *
   * 升级**优先**用它而不是 `包名@版本`：宿主装了 HMR 之后，`installBundle` 会在
   * 跑 pnpm 之前就对「spec 指明已安装包」的请求抛 `already-installed`
   * （0.2.1-rc.2 起）—— 用它去覆盖安装**自己**，必然 100% 失败。
   * tarball 规格解析不出包名，那道检查不触发；pnpm 的 `minimumReleaseAge`
   * 也只按 registry 版本判定，不作用于 URL 依赖。
   */
  const [remoteTarball, setRemoteTarball] = useState<string | null>(null);

  const check = useCallback(
    async (fresh = false) => {
      if (typeof props.checkLatest !== 'function') return;
      setPhase({ name: 'checking' });
      try {
        const latest = await props.checkLatest(fresh);
        setRemoteName(latest.name);
        setRemoteTarball(latest.tarball ?? null);
        if (installed !== null && isNewerVersion(latest.version, installed)) {
          setPhase({ name: 'outdated', version: latest.version });
          return;
        }
        setPhase({ name: 'latest', version: latest.version });
      } catch (error) {
        // 带上原始消息：真实原因（网络、包名读不到、不是 bundle 等）必须可见。
        setPhase({ name: 'error', message: errorText(error, '检查更新失败') });
      }
    },
    // `installed` 是 `appliedVersion ?? pageVersion` 的派生值，把它俩都列出来，
    // 让「本次装成过的版本」一变，check 就拿到新值。
    [props, installed, appliedVersion, pageVersion],
  );

  const runUpdate = useCallback(
    async (version: string) => {
      if (typeof manager?.installBundle !== 'function') return;
      setPhase({ name: 'updating', version });
      try {
        // 【必须显式传满 2 个业务参数】gateway 按 descriptor 严格校验个数：
        // `installBundle(spec, options)`，第三个参数才是可选 AbortSignal。
        //
        // 【规格怎么选】优先用宿主给的 **tarball 直链**：宿主一旦装了 HMR，
        // 指向已安装包的 `包名@版本` 会在跑 pnpm 之前就被 `already-installed`
        // 拒掉；tarball 解析不出包名，那道检查不触发。只有在宿主还没升级到
        // 会返回 tarball 的版本时才退回 `包名@精确版本`（那种旧宿主上没有那道检查）。
        // 用精确版本而不是 `@latest`：用户确认的是界面上那个版本号，万一确认与
        // 执行之间又发了新版，也不该装一个他没见过的版本。
        const name = remoteName ?? pkg?.name ?? SELF_PACKAGE;
        const spec = remoteTarball ?? `${name}@${version}`;
        // enabled: true —— 本插件正在运行（说明它本来就是启用状态），升级后保持启用。
        // 不传 approvedBuilds：安装脚本是否放行交给用户在插件页自己决定。
        const requestId = `notes-update-${Date.now().toString(36)}`;
        const answer = await manager.installBundle(spec, {
          enabled: true,
          requestId,
        });
        if (answer?.ok !== true) {
          setPhase({ name: 'error', message: failureText(answer) });
          return;
        }
        const change = answer.value;
        const blocked = (change?.pendingBuilds?.length ?? 0) > 0;
        if (change?.application === 'applied' || change?.application === 'restart-required') {
          // 记下「已经装上的是这个版本」：`check()` 之后用它比较，
          // 而不是用 DSH 页面那份可能还没刷新的 `pkg.version`。
          // 否则升级成功后按钮仍显示可升级，再点一次会撞上 already-installed。
          setAppliedVersion(version);
          setPhase({
            name: 'done',
            version,
            restart: change.application === 'restart-required',
            blocked,
          });
          return;
        }
        if (change?.application === 'failed') {
          setPhase({
            name: 'error',
            message: blocked
              ? '安装脚本需要先在插件页批准'
              : (codeText(change.error?.code) ?? change.error?.message ?? '更新失败'),
          });
          return;
        }
        if (change?.application === 'overridden') {
          setPhase({ name: 'error', message: '这个版本被 profile 的补丁覆盖，未生效' });
          return;
        }
        // cancelled / 其它：按未变更处理，允许重试。
        setPhase({ name: 'error', message: '更新未完成' });
      } catch (error) {
        setPhase({ name: 'error', message: errorText(error, '更新失败') });
      }
    },
    [manager, remoteName, remoteTarball, pkg?.name],
  );

  // 只在属于自己的页面、且两项能力都在时才工作：
  // 「能查最新版本」（本插件宿主半边）+「能装」（官方 pluginManager）。
  // 任一缺失都按不可用处理：宁可不显示入口，也不留一个点了没反应的按钮。
  const ours =
    subject?.kind === 'bundle' &&
    pkg?.name === SELF_PACKAGE &&
    typeof props.checkLatest === 'function' &&
    typeof manager?.installBundle === 'function';

  // 进页面自动查一次；同时问宿主是不是本地链接安装（只为提示，失败不影响功能）。
  useEffect(() => {
    if (!ours) return undefined;
    let alive = true;
    void check();
    void props
      .probeLocalInstall?.()
      .then((value) => {
        if (alive) setLocal(value === true);
      })
      .catch(() => {
        // 探测失败按「不是本地」处理，只少一条提示。
      });
    return () => {
      alive = false;
    };
    // 只在首次进入自己的页面时跑一次；check 的依赖变化不需要重跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ours]);

  if (!ours) return null;

  return (
    <div className="dsh-notes-update">
      {phase.name === 'idle' && (
        <button type="button" className="dsh-notes-update__btn" onClick={() => void check()}>
          检查更新
        </button>
      )}

      {phase.name === 'checking' && <span className="dsh-notes-update__note">检查中…</span>}

      {phase.name === 'latest' && (
        <>
          <span className="dsh-notes-update__note">
            已是最新版本{phase.version === null ? '' : ` ${phase.version}`}
          </span>
          {/* 手动重查要绕过宿主端缓存，否则刚发布的新版本查不到 */}
          <button
            type="button"
            className="dsh-notes-update__btn"
            onClick={() => void check(true)}
          >
            重新检查
          </button>
        </>
      )}

      {phase.name === 'outdated' && (
        <>
          <span className="dsh-notes-update__note">
            发现新版本 {phase.version}
            {installed === null ? '' : `（当前 ${installed}）`}
          </span>
          <button
            type="button"
            className="dsh-notes-update__btn dsh-notes-update__btn--primary"
            onClick={() => setPhase({ name: 'confirm', version: phase.version })}
          >
            更新
          </button>
        </>
      )}

      {phase.name === 'confirm' && (
        <>
          <span className="dsh-notes-update__note">
            从 npm 更新到 {phase.version}
            {installed === null ? '' : `（当前 ${installed}）`}
            {local ? '。注意：当前是本地目录链接安装，更新后本插件将改为从 npm 安装，本地改动不再自动生效' : ''}
          </span>
          <button
            type="button"
            className={`dsh-notes-update__btn ${local ? 'dsh-notes-update__btn--danger' : 'dsh-notes-update__btn--primary'}`}
            onClick={() => void runUpdate(phase.version)}
          >
            {local ? '仍要更新' : '确认更新'}
          </button>
          <button
            type="button"
            className="dsh-notes-update__btn"
            onClick={() => setPhase({ name: 'outdated', version: phase.version })}
          >
            取消
          </button>
        </>
      )}

      {phase.name === 'updating' && <span className="dsh-notes-update__note">更新中…</span>}

      {phase.name === 'done' && (
        <>
          <span className="dsh-notes-update__note">
            已更新{phase.version === null ? '' : `到 ${phase.version}`}
            {phase.restart ? '，重启 DSH 后生效' : ''}
            {phase.blocked ? '；安装脚本需在插件页批准后才会执行' : ''}
          </span>
          <button type="button" className="dsh-notes-update__btn" onClick={() => void check(true)}>
            再查一次
          </button>
        </>
      )}

      {phase.name === 'error' && (
        <>
          <span className="dsh-notes-update__note">检查/更新失败：{phase.message}</span>
          {/* 重试也绕过缓存：失败常常是刚发布/刚恢复网络，读缓存没意义 */}
          <button
            type="button"
            className="dsh-notes-update__btn"
            onClick={() => void check(true)}
          >
            重试
          </button>
        </>
      )}
    </div>
  );
}
