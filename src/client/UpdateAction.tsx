/**
 * 插件页上的「检查更新 / 更新」控件。
 *
 * 注册在 DSH 官方席位 `plugins.detail.actions` 上：宿主把每个插件详情页的主体
 * （subject）交给每条注册项，我们只认自己的 bundle，其余一律返回 null —— 所以
 * 别人的插件页不会多出这个按钮。
 *
 * 检查与更新都走官方 `remote.pluginManager`（官方插件页自己用的同一套）：
 * - `inspect('<包名>@latest')` 解析 npm 上的最新版本；
 * - `installBundle('<包名>@latest', ...)` 让 DSH 用它自己的安装流程升级 ——
 *   与用户在插件页手动安装完全同一条路径，本插件**不自己跑包管理器、不碰
 *   profile 文件**，因此不会对 DSH 自身产生副作用。
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

/** `inspect` 的接受分支（只声明用到的字段）。 */
interface SpecAccepted {
  status?: string;
  kind?: string;
  name?: string;
  version?: string;
}

/** `inspect` 的拒绝分支。 */
interface SpecRefused {
  status?: string;
  problem?: string;
  reason?: string;
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

/** `remote.pluginManager` 的最小面：方法全部可选，缺失即降级。 */
interface PluginManagerFacade {
  inspect?(spec: string, options?: { registry?: string | null }): Promise<RemoteAnswer<SpecAccepted | SpecRefused> | null>;
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
 * 插件页详情页头部控件。
 * @param props - 宿主给的 subject + 本插件注入的 manager / probeLocalInstall。
 */
export function NotesUpdateAction(props: UpdateActionProps): JSX.Element | null {
  const subject = props.subject;
  const pkg = subject?.pkg;
  const manager = props.manager ?? null;
  const installed = typeof pkg?.version === 'string' ? pkg.version : null;

  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  /** 是否本地链接安装（探测失败按否处理）。 */
  const [local, setLocal] = useState(false);

  const check = useCallback(async () => {
    if (typeof manager?.inspect !== 'function') return;
    setPhase({ name: 'checking' });
    try {
      const answer = await manager.inspect(`${SELF_PACKAGE}@latest`);
      if (answer?.ok !== true) {
        setPhase({ name: 'error', message: failureText(answer) });
        return;
      }
      const value = answer.value;
      if (value?.status !== 'accepted') {
        const refused = value as SpecRefused | undefined;
        setPhase({
          name: 'error',
          message:
            codeText(refused?.problem) ??
            (typeof refused?.reason === 'string' && refused.reason !== ''
              ? refused.reason
              : '检查更新失败'),
        });
        return;
      }
      const latest = (value as SpecAccepted).version ?? null;
      if (latest !== null && installed !== null && isNewerVersion(latest, installed)) {
        setPhase({ name: 'outdated', version: latest });
        return;
      }
      setPhase({ name: 'latest', version: latest ?? installed });
    } catch {
      setPhase({ name: 'error', message: '检查更新失败' });
    }
  }, [manager, installed]);

  const runUpdate = useCallback(
    async (version: string) => {
      if (typeof manager?.installBundle !== 'function') return;
      setPhase({ name: 'updating', version });
      try {
        // enabled: true —— 本插件正在运行（说明它本来就是启用状态），升级后保持启用。
        // 不传 approvedBuilds：安装脚本是否放行交给用户在插件页自己决定。
        const requestId = `notes-update-${Date.now().toString(36)}`;
        const answer = await manager.installBundle(`${SELF_PACKAGE}@latest`, {
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
      } catch {
        setPhase({ name: 'error', message: '更新失败' });
      }
    },
    [manager],
  );

  // 只在属于自己的页面、且官方服务可用时才工作。
  const ours = subject?.kind === 'bundle' && pkg?.name === SELF_PACKAGE && manager !== null;

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
          <button type="button" className="dsh-notes-update__btn" onClick={() => void check()}>
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
          <button type="button" className="dsh-notes-update__btn" onClick={() => void check()}>
            再查一次
          </button>
        </>
      )}

      {phase.name === 'error' && (
        <>
          <span className="dsh-notes-update__note">检查/更新失败：{phase.message}</span>
          <button type="button" className="dsh-notes-update__btn" onClick={() => void check()}>
            重试
          </button>
        </>
      )}
    </div>
  );
}
