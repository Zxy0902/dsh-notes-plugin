/**
 * notes — 客户端（浏览器）半边：插件入口。
 *
 * 做了三件事：
 * 1. 在左侧会话栏的全局面板按钮区注册「笔记」按钮（sidebar.panellist）。
 * 2. 在中间主面板注册同 id 的面板（main）——点按钮即把主面板切到笔记。
 * 3. 挂载时注入样式、接上目录选择与状态仓库。
 *
 * 注册全部走 ctx.slots.inject(...)：只有宿主真的声明了该席位，回调才执行。
 * 所以即使 DSH 未来删掉某个席位，插件也只是不显示，不会让启动失败。
 */
import { NotesApi } from './api';
import { NotesPanel } from './NotesPanel';
import { NotesStore } from './store';
import { injectStyles } from './styles';

/** 面板 id：同时作为 sidebar.panellist 的 id 与 main 的 key，两者必须一致。 */
const PANEL_ID = 'notes';

/** 笔记按钮在左侧栏的排序（排在靠前位置）。 */
const PANEL_ORDER = 30;

/**
 * 客户端半边需要的服务。
 *
 * **`remote.session` 必须显式声明**，这不是可选项：
 * gateway 把每个 Remote 命名空间注册成**独立的 cordis 服务**，服务名就是
 * `remote.` + 命名空间名（见 gateway 的 `remoteServiceKey`）。而 cordis 的服务
 * **可见性按 fiber 隔离** —— 只有同样声明了该依赖的 fiber 才能读到它。
 * 因此即使 `remote` 已声明，`ctx.remote.session` 仍会抛
 * `cannot get property "remote.session" without inject`。
 * 官方 ui-open-in-app 的 inject 里同样写了 `"remote.session"`，就是这个原因。
 *
 * 关于「未来版本重构会不会崩」：inject 确实是加载期硬依赖，但这是**唯一**能让
 * 功能工作的方式（实测不声明则永远读不到）。风险用运行时探测兜住：取值一律走
 * try/catch + `typeof` 判断，能力缺失只降级成一句可读提示，不影响插件其余部分。
 */
export const inject = ['slots', 'locale', 'remote', 'remote.session'];

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

/** 本插件的语言命名空间。 */
const NS = 'notes';

/** 中文字典。 */
const zh = {
  'entry.label': '笔记',
};

/** 英文字典。 */
const en = {
  'entry.label': 'Notes',
};

// ---------------------------------------------------------------------------
// 图标
// ---------------------------------------------------------------------------

/**
 * 左侧栏的笔记图标。
 * @param props - 宿主给的面板图标属性（尺寸 + 是否选中）。
 */
function NotesIcon({ size, active }: { size: number; active: boolean }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 1.7 : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 2.2h6.2L13 5v8.8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.2a1 1 0 0 1 1-1Z" />
      <path d="M10 2.2V5h3" />
      <path d="M5.4 8h5.2M5.4 10.6h3.6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 客户端上下文（只声明本插件真正调用的成员）
// ---------------------------------------------------------------------------

/** 槽位注册选项。 */
interface SlotRegistrationOptions {
  name: string;
  [key: string]: unknown;
}

/** 系统里一个可用来打开文件的应用程序（host 返回的关联信息）。 */
interface RemoteApplication {
  /** 应用标识，回传给 `openWorkspacePath` 的 `application` 字段。 */
  id: string;
  /** 展示名。 */
  name?: string;
  /** 是否为该系统上的默认打开方式。 */
  default?: boolean;
}

/**
 * DSH 生成的 Remote 客户端服务的**最小面**。
 *
 * 只声明本插件真正用到的两个命名空间，且方法全部可选：这样即使未来版本改名或
 * 移除某个命名空间，也只是对应能力失效（调用处会给出可读提示），不会因类型或
 * inject 硬依赖而在加载期崩溃。
 *
 * 注意：`remote` 服务由 `@deepseek-ai/dsh-api-gateway` 提供（`super(ctx, "remote")`），
 * `@deepseek-ai/dsh-api-remotes` 只是往它上面挂载各命名空间，两个包都要在
 * `dsh.client.inject` 里声明。而 `remote.session` 本身是一个**独立的服务名**，
 * 必须单独写进 inject（详见 apply 上方注释）。
 */
interface RemoteFacade {
  /** 目录选择器：用户挑一个笔记根目录。 */
  directoryPicker?: { pick?(): Promise<string | null> };
  /** 会话相关：交给系统程序打开文件。 */
  session?: {
    canOpenWorkspacePath?(): Promise<{ ok: boolean; value?: boolean }>;
    workspacePathApplications?(request: {
      path: string;
    }): Promise<{ ok: boolean; value?: readonly RemoteApplication[] }>;
    openWorkspacePath?(request: {
      path: string;
      action?: 'reveal';
      application?: string;
    }): Promise<{ ok: boolean; error?: unknown }>;
  };
}

/**
 * DSH 工作区服务的**最小面**（官方 `@deepseek-ai/dsh-client-ui-workspace` 提供）。
 * 同样只在 apply 期间取快照。
 */
interface WorkspaceFacade {
  /** 调起目录选择器；用户取消返回 null。 */
  pickDirectory?(): Promise<string | null>;
}

/** 布局服务的**最小面**：只需能切换当前主面板。 */
interface LayoutFacade {
  /** 把主面板切到指定 id。 */
  selectPanel?(id: string): void;
}

/** 客户端插件上下文。 */
interface ClientContext {
  /** 槽位服务。 */
  slots: {
    /** 等宿主声明某席位后再注册，返回释放函数。 */
    inject(key: string, callback: () => () => void): () => void;
    /** 注册一个席位占用者，返回释放函数。 */
    register(options: SlotRegistrationOptions, component: unknown): () => void;
  };
  /** 语言注册。 */
  locale: {
    register(namespace: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): () => void;
  } | null;
  /** 副作用注册：回调立即执行，返回值在卸载时调用。 */
  effect(callback: () => () => void, label?: string): void;
  /** 读取可选服务。 */
  get?(name: string): unknown;
  /**
   * Remote 服务。只在 apply 期间读一次并存成快照 —— 回调阶段现场读会因 fiber
   * 上下文变化而抛 `cannot get property "remote" without inject`。
   */
  remote?: RemoteFacade;
}

/**
 * 插件入口。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  // 1) 文案
  ctx.effect(() => {
    try {
      return ctx.locale?.register(NS, { zh, en }) ?? (() => {});
    } catch {
      // 语言服务不可用不影响功能。
      return () => {};
    }
  }, 'notes: dictionaries');

  // 2) 样式
  ctx.effect(() => injectStyles(), 'notes: styles');

  // 3) 共享的仓库与 API 客户端（面板与按钮共用一个实例，状态才连贯）
  const api = new NotesApi();
  const store = new NotesStore();

  /**
   * 【关键】在 apply 期间**立即**把 Remote 服务取出来存成快照。
   *
   * 不能等到用户点击时才读 `ctx.remote`。cordis 的服务查找沿 fiber 链进行，
   * 并带 isolate（隔离）校验：apply 阶段能取到的服务，在**异步回调执行的时刻**
   * 可能因 fiber 上下文变化而取不到，报 `cannot get property "remote" without inject`。
   * 官方 ui-open-in-app 正是这么做的 —— 它在 apply 里 `new Controller(ctx.remote)`
   * 就把服务存下来，此后回调只碰这个已持有的引用，不再回头读 ctx。
   *
   * 用 try/catch 包住：拿不到也只是本次调用失败，不会让插件加载崩掉。
   */
  let remote: RemoteFacade | null = null;
  try {
    remote = (ctx.remote ?? null) as RemoteFacade | null;
  } catch {
    // 服务不可用（平台没有 Remote 体系）时保持 null，由调用处给出可读提示。
    remote = null;
  }

  /**
   * 同理，`uiWorkspace` 也要在 apply 期间取好快照。
   *
   * 它同样不能在回调阶段现场读：`ctx.get('uiWorkspace')` 走的是同一条服务查找
   * 路径，回调期 fiber 上下文变化时会抛 `cannot get property "uiWorkspace"
   * without inject`。之前文件夹选择偶尔「没反应」就是这个原因。
   */
  let workspace: WorkspaceFacade | null = null;
  try {
    workspace = (ctx.get?.('uiWorkspace') as WorkspaceFacade | undefined) ?? null;
  } catch {
    workspace = null;
  }

  /** 布局服务快照（点「笔记」按钮时切换主面板用）。 */
  let layout: LayoutFacade | null = null;
  try {
    layout = (ctx.get?.('layout') as LayoutFacade | undefined) ?? null;
  } catch {
    layout = null;
  }

  // 页面卸载或切到后台前，把未落盘的改动补写一次，保证「记忆」不丢。
  ctx.effect(() => store.attachFlushOnUnload(), 'notes: persist flush');

  /**
   * 调起 DSH 的目录选择器。
   *
   * 首选注入的 `ctx.uiWorkspace.pickDirectory()`（官方 ui-workspace 提供；
   * 本包必须把它写进 dsh.client.inject，否则运行时 ctx.get 拿不到）。
   * 再退到生成的 Remote 客户端 `remote.directoryPicker.pick()`。
   *
   * 注意不要用裸 fetch 打路由：DSH 的 Remote 走的是带信封的 RPC，裸请求会被
   * 判成 gateway/bad-request，所以两处都走官方入口。
   */
  const pickDirectory = async (): Promise<string | null> => {
    if (typeof workspace?.pickDirectory === 'function') {
      return workspace.pickDirectory();
    }

    if (typeof remote?.directoryPicker?.pick === 'function') {
      return remote.directoryPicker.pick();
    }

    throw new Error('当前环境不支持选择文件夹');
  };

  /**
   * 切到笔记面板。
   *
   * `layout` 同样取快照：这是点侧栏「笔记」按钮的主路径，回调期现场读同样会抛。
   */
  const openPanel = (): void => {
    layout?.selectPanel?.(PANEL_ID);
  };

  /**
   * 用系统程序打开一个文件，或列出可用来打开它的应用。
   *
   * 走官方 Session Remote 的 `session.*` —— 这正是 DSH 自带的 ui-open-in-app
   * 内部使用的同一组入口，所以不需要本插件自建 host 路由、也不必自己拼各平台的
   * open 命令。三个能力：
   * - `canOpen`：这台机器的宿主是否支持交给桌面程序打开
   * - `applications`：系统里注册来打开该文件的应用列表（含默认项）
   * - `open`：用默认程序打开，或指定某个应用、或只显示文件位置
   *
   * 为什么它能打开笔记根目录（用户自选、通常在会话工作区之外）的文件：
   * host 侧只要求路径能通过 `fs.processPathFromHostPath` 得到映射，而 fs-local
   * 的实现对任意绝对路径都返回 resolve(hostPath)，fs-sandbox 也只围栏写入、
   * 继承同一映射，因此不限制在会话工作区内。
   *
   * 一切都走 apply 期间取好的快照 `remote`，**不在回调里回头读 `ctx`**。
   * 能力缺失时返回可读原因而不是抛异常，插件其余部分照常可用。
   */
  const sessionRemote = remote?.session;

  /** 是否具备「交给系统程序打开」的能力。 */
  const canOpenExternal = async (): Promise<boolean> => {
    if (typeof sessionRemote?.openWorkspacePath !== 'function') return false;
    try {
      if (typeof sessionRemote.canOpenWorkspacePath === 'function') {
        const can = await sessionRemote.canOpenWorkspacePath();
        // 明确返回 false 才算不支持；读失败时按支持处理，让真正调用去报错。
        if (can?.ok === true && can.value === false) return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  /**
   * 列出系统里能打开该文件的应用。
   * @param path - 文件绝对路径。
   * @returns 应用列表；查询失败返回 null（调用处显示「无法获取应用列表」）。
   */
  const listApplications = async (
    path: string,
  ): Promise<RemoteApplication[] | null> => {
    if (typeof sessionRemote?.workspacePathApplications !== 'function') return null;
    try {
      const result = await sessionRemote.workspacePathApplications({ path });
      if (!result?.ok) return null;
      const value = result.value;
      return Array.isArray(value) ? (value as RemoteApplication[]) : null;
    } catch {
      return null;
    }
  };

  /**
   * 打开文件、用指定应用打开，或只显示文件位置。
   * @param path - 文件绝对路径。
   * @param options - `application` 指定应用；`reveal` 为 true 时只显示位置。
   * @returns 失败原因文本；成功返回 null。
   */
  const openExternal = async (
    path: string,
    options?: { application?: string; reveal?: boolean },
  ): Promise<string | null> => {
    if (typeof sessionRemote?.openWorkspacePath !== 'function') {
      return '当前环境不支持用系统程序打开文件';
    }

    const request: { path: string; action?: 'reveal'; application?: string } = { path };
    if (options?.reveal === true) request.action = 'reveal';
    else if (options?.application !== undefined) request.application = options.application;

    try {
      const result = await sessionRemote.openWorkspacePath(request);
      if (!result?.ok) {
        return options?.reveal === true
          ? '无法显示文件位置，请重试'
          : '打开失败，请重试';
      }
      return null;
    } catch {
      return options?.reveal === true
        ? '无法显示文件位置，请重试'
        : '打开失败，请重试';
    }
  };

  // 4) 左侧栏按钮
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: () => '笔记',
          },
          NotesIcon,
        ),
      ),
    'notes: sidebar entry',
  );

  // 5) 中间主面板
  ctx.effect(
    () =>
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            inject: () => ({
              store,
              api,
              pickDirectory,
              openPanel,
              openExternal,
              canOpenExternal,
              listApplications,
            }),
          },
          NotesPanel,
        ),
      ),
    'notes: main panel',
  );
}

/** 便于测试与排查的导出。 */
export { PANEL_ID, NotesPanel, NotesStore, NotesApi };
