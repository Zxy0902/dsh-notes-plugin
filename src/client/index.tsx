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
import { NotesUpdateAction, type UpdateActionProps } from './UpdateAction';
import {
  NS as CONFIG_NS,
  NotesConfigCard,
  type NotesConfigProps as ConfigCardProps,
  en as configEn,
  zh as configZh,
} from './ConfigCard';

/** 面板 id：同时作为 sidebar.panellist 的 id 与 main 的 key，两者必须一致。 */
const PANEL_ID = 'notes';

/** 本插件在 profile 里的包名（配置页的 key 用它拼）。 */
const PACKAGE_NAME = 'dsh-client-ui-notes';

/** 本插件在 cordis.patch.yml 里的行 id（配置页的 key 用它拼）。 */
const ROW_ID = 'ui-notes';

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
 * 目录选择器 Remote 命名空间的**最小面**。
 *
 * 刻意不走 `remote.directoryPicker` 属性访问：那会被 inject 门控（未声明即抛
 * `cannot get property "remote.directoryPicker" without inject`）。改为
 * `ctx.get('remote.directoryPicker')` 可选获取，缺失时安静降级。
 */
/**
 * Electron preload 注入的桌面目录桥（`globalThis.__DSH_DIRECTORY_PICKER__`）。
 *
 * 不是 cordis 服务，是桌面壳的 preload 脚本写进页面的普通对象；底层走
 * `dsh-desktop:directory-pick` 的 IPC。DSH 官方的系统目录选择器就用它
 * （见 `dsh-client-ui-directory-picker-native` 的 `client.js`）。
 *
 * 只声明本插件用到的 `pick`：桥的具体实现属于桌面壳，接口越窄越不容易随
 * 版本变化而失效。
 */
interface DesktopDirectoryPicker {
  pick(): Promise<string | null>;
}

interface PickDirectoryFacade {
  /** 弹系统目录选择框；用户取消时返回 null（个别版本回 { ok, value } 信封）。 */
  pick?(): Promise<string | null | { ok: boolean; value?: string }>;
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
    /** 取某个命名空间里的键（配置面板用来读自己的字典）。 */
    bind?(namespace: string): (key: string) => string;
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
      // 配置面板的字典用独立的命名空间（`notes.config`），与主面板的 `notes` 分开：
    // 两者的键都叫 description 之类，合在一起会互相覆盖。
    const main = ctx.locale?.register(NS, { zh, en }) ?? (() => {});
    const config = ctx.locale?.register(CONFIG_NS, { zh: configZh, en: configEn }) ?? (() => {});
    return () => {
      main();
      config();
    };
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

  /**
   * 插件管理服务快照（插件页的更新控件用）。
   *
   * 【刻意不写进 inject】inject 是**加载期硬依赖**：声明了 `remote.pluginManager`
   * 之后，cordis 会等这个服务出现才加载本插件 —— 万一某个 DSH 版本或精简 profile
   * 没有插件管理器，本插件就会整个不加载（正是要避免的耦合）。
   * 改用 `ctx.get()` 可选获取：拿不到就只是不显示更新按钮，其余功能照旧。
   */
  let pluginManager: UpdateActionProps['manager'] = null;
  try {
    pluginManager =
      (ctx.get?.('remote.pluginManager') as UpdateActionProps['manager']) ?? null;
  } catch {
    pluginManager = null;
  }
  if (pluginManager === null) {
    // 兜底一：直接问 remote 门面（若某版本把命名空间收进 fiber 作用域，
    // 这条可能有效；未声明 inject 时会抛，已包住）。
    try {
      const facade = ctx.remote as unknown as
        | { pluginManager?: UpdateActionProps['manager'] }
        | undefined;
      pluginManager = facade?.pluginManager ?? null;
    } catch {
      pluginManager = null;
    }
  }
  if (pluginManager === null) {
    // 兜底二：留一行诊断，避免「更新入口为什么没出现」变成无从判断的问题。
    // 只提示一次，且不进 UI —— 缺这个服务是旧版/精简环境下的正常降级。
    try {
      console.info(
        '[notes] 未取到 remote.pluginManager，插件详情页的更新入口将不显示（其余功能不受影响）',
      );
    } catch {
      // 控制台不可用就算了。
    }
  }

  // 页面卸载或切到后台前，把未落盘的改动补写一次，保证「记忆」不丢。
  ctx.effect(() => store.attachFlushOnUnload(), 'notes: persist flush');

  /**
   * 目录选择器 Remote 命名空间的快照。
   *
   * 【为什么单独取而不经过 remote 门面】`remote` 是 cordis 的 Service 代理，
   * 对 `remote.<命名空间>` 的**属性访问**会被 inject 门控：只要该命名空间没写进
   * `dsh.client.inject`，读取就会抛
   * `cannot get property "remote.directoryPicker" without inject`。
   * 之前 `pickDirectory` 把 `typeof remote?.directoryPicker?.pick === 'function'`
   * 当作能力探测，这行在 workspace 拿不到时就会**炸掉**（探测本身即抛错）——
   * 用户看到的就是这句 cordis 内部错误。
   *
   * 改成与 pluginManager 相同的策略：用 `ctx.get()` 可选获取（不受 inject 门控，
   * 缺失时返回 undefined），拿不到只是「选择文件夹」不可用，其余功能照旧，
   * 也不会因版本差异在加载期崩溃。
   */
  let directoryPicker: PickDirectoryFacade | null = null;
  try {
    directoryPicker =
      (ctx.get?.('remote.directoryPicker') as PickDirectoryFacade | undefined) ?? null;
  } catch {
    directoryPicker = null;
  }

  /**
   * 调用时刻再取一次可选服务。
   *
   * 服务就绪的时机不受本插件控制：`uiWorkspace` 由官方 ui-workspace 注册，
   * 本插件的 apply 完全可能在它之前执行，于是快照是 null。所以除了快照，
   * 每次真正要用时再 `get` 一次 —— 抛错就当作没有（fiber 上下文变化时 cordis
   * 可能拒绝查找），绝不让查找本身把功能路径炸掉。
   */
  const readService = <T,>(name: string): T | null => {
    if (typeof ctx.get !== 'function') return null;
    try {
      return (ctx.get(name) as T | undefined) ?? null;
    } catch {
      return null;
    }
  };

  /**
   * 读 Electron preload 注入的桌面目录桥。
   *
   * 必须用 `ctx.get` 之外的方式：它不是 cordis 服务，而是一个挂在 `globalThis`
   * 上的普通对象，由桌面壳的 preload 脚本写入。Web 部署下不存在。
   *
   * @returns 桥；不存在或形状不对时为 null。
   */
  const readDesktopPicker = (): DesktopDirectoryPicker | null => {
    try {
      const candidate = (globalThis as Record<string, unknown>)['__DSH_DIRECTORY_PICKER__'];
      if (typeof candidate !== 'object' || candidate === null) return null;
      const pick = (candidate as { pick?: unknown }).pick;
      return typeof pick === 'function' ? (candidate as DesktopDirectoryPicker) : null;
    } catch {
      return null;
    }
  };

  /**
   * 调起 DSH 的目录选择器。
   *
   * 首选官方 `uiWorkspace.pickDirectory()`；再退到 Remote 命名空间的 `pick()`。
   * 两者都是「快照 → 调用时再取」的顺序，避免 apply 时序导致能力凭空消失。
   *
   * 注意不要用裸 fetch 打路由：DSH 的 Remote 走的是带信封的 RPC，裸请求会被
   * 判成 gateway/bad-request，所以两处都走官方入口。
   */
  const pickDirectory = async (): Promise<string | null> => {
    /*
     * **优先走 Electron preload 注入的桌面桥**，这与 DSH 自己的实现完全一致。
     *
     * 为什么不能只用 `uiWorkspace.pickDirectory()`：那是 Remote RPC，调用要在
     * 主进程与渲染进程之间往返一趟；而 DSH 的 macOS 选择器是一段 AppleScript，
     * 里面 `activateIgnoringOtherApps(true)` 之后**立刻** `runModal` 阻塞。
     * 经过 RPC 往返后，面板跑起来时宿主窗口已经不是「刚被点击的前台窗口」，
     * 系统就按非活动窗口渲染它 —— 侧栏文字发灰、Open 按钮发灰。
     *
     * DSH 官方入口之所以正常，就是因为它用了这个桥：
     *   `dsh-client-ui-directory-picker-native/client.js` 里
     *   `const desktop = globalThis.__DSH_DIRECTORY_PICKER__`
     *   `const pick = desktop === void 0 ? () => ctx.uiWorkspace.pickDirectory() : () => desktop.pick()`
     * 桥不存在时（Web 部署、未来版本移除）才退回 RPC，行为与以前一致。
     */
    const desktop = readDesktopPicker();
    if (desktop !== null) {
      try {
        const picked = await desktop.pick();
        return typeof picked === 'string' ? picked : null;
      } catch (error) {
        console.warn('[notes] 桌面目录桥失败，改用 Remote 兜底', error);
      }
    }

    const workspaceNow = workspace ?? readService<WorkspaceFacade>('uiWorkspace');
    if (typeof workspaceNow?.pickDirectory === 'function') {
      try {
        return await workspaceNow.pickDirectory();
      } catch (error) {
        // 官方入口自身失败（服务重组、宿主不支持等）不应把内部错误直接抛给用户，
        // 记一条诊断后走 Remote 兜底。
        console.warn('[notes] uiWorkspace.pickDirectory 失败，改用 Remote 兜底', error);
      }
    }

    const pickerNow =
      directoryPicker ?? readService<PickDirectoryFacade>('remote.directoryPicker');
    if (typeof pickerNow?.pick === 'function') {
      const picked = await pickerNow.pick();
      // Remote 可能返回裸字符串，也可能返回 { ok, value } 信封，两种都兼容。
      if (typeof picked === 'string') return picked;
      if (picked && typeof picked === 'object' && 'value' in picked) {
        const value = (picked as { value?: unknown }).value;
        if (typeof value === 'string') return value;
      }
      return null;
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

  // 3.5) 卸载前清理：让「卸载」真正不留痕迹
  //
  // DSH 的 removeBundle 会 `pnpm remove` + 重新加载组合，**不会**碰浏览器存储。
  // 本插件的 tab、置顶、文件夹历史都在 localStorage（键 `dsh.notes.v1`），
  // 不主动清的话，卸载后它们会一直躺在那里 —— 将来重装会「复活」一批
  // 指向可能已不存在的旧文件。
  //
  // 做法：监听插件管理器的快照，一旦本插件从「已安装」列表里消失就清一次。
  // 只在**确定发生过卸载**时触发；正常启动/禁用/启用都不会误伤。
  ctx.effect(() => {
    const manager = pluginManager as
      | { subscribe?: (fn: () => void) => () => void; getSnapshot?: () => unknown }
      | null;
    if (typeof manager?.getSnapshot !== 'function' || typeof manager.subscribe !== 'function') {
      return () => {};
    }
    let armed = false;
    let disposed = false;
    const check = (): void => {
      if (disposed) return;
      try {
        const snapshot = manager.getSnapshot?.() as
          | { bundles?: readonly unknown[]; installed?: readonly unknown[] }
          | undefined;
        const list = snapshot?.bundles ?? snapshot?.installed;
        if (!Array.isArray(list)) return;
        const present = list.some((item) => {
          const record = item as { name?: unknown; packageName?: unknown };
          return record.name === PACKAGE_NAME || record.packageName === PACKAGE_NAME;
        });
        // 先见到过一次「在」，之后见到「不在」才算卸载 —— 避免列表还没加载时误清。
        if (present) armed = true;
        else if (armed) {
          armed = false;
          store.clearPersistedState();
        }
      } catch {
        // 读不到快照就算了：清理是加分项，不能因此出错。
      }
    };
    const off = manager.subscribe(check);
    check();
    return () => {
      disposed = true;
      off();
    };
  }, 'notes: cleanup on uninstall');

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
              // 技能阅读是否启用：只有宿主明确说「关」才关，读不到按开处理
              // （旧宿主没有这个字段，那时技能功能本来就存在）。
              skillsEnabled: async () => {
                try {
                  const info = await api.health();
                  return info.skillsReading !== false;
                } catch {
                  return true;
                }
              },
            }),
          },
          NotesPanel,
        ),
      ),
    'notes: main panel',
  );

  /**
   * 5.5) 插件页里的**配置面板**。
   *
   * 挂的是 `plugins.bundle.config`，**key 就是包名**（不是 `<包名>#<行id>`）。
   * 这是 DSH 0.1.6+ 的包级配置入口：插件管理页在包详情里直接渲染它，
   * 判定条件是 `configured = ledger.bundles.has(pkg.name)`，不需要点进某一行。
   *
   * 参照官方 `dsh-workbuddy-connect`（`lib/client.js` 的
   * `plugins.bundle.config page` 那段）——它也是这么挂的，而且**不使用**
   * `configForms` / `SettingsFormModel`：页面自己画，值走插件自己的 HTTP 路由。
   * 这正是本插件要的形状：配置页只依赖我们自己的 `api/dsh-notes/config`，
   * DSH 内部表单机制怎么改都影响不到它。
   *
   * 同时也挂一份 `plugins.row.config`：老一点的宿主只认行级入口，
   * 两个都注册，哪边存在就在哪边显示，互不影响。
   */
  ctx.effect(() => {
    const bundleKey = PACKAGE_NAME;
    const rowKey = `${PACKAGE_NAME}#${ROW_ID}`;

    /** 语言读取器：拿不到就退回 key 本身，界面上至少有字。 */
    const translator = (key: string): string => {
      try {
        return ctx.locale?.bind?.(CONFIG_NS)?.(key) ?? key;
      } catch {
        return key;
      }
    };

    /** 包级入口（0.1.6+）。 */
    const bundle = (): (() => void) =>
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            key: bundleKey,
            order: 10,
            label: '笔记设置',
            locale: CONFIG_NS,
            inject: (): Partial<ConfigCardProps> => ({ t: translator }),
          },
          NotesConfigCard,
        ),
      );

    /** 行级入口（老宿主）。 */
    const row = (): (() => void) =>
      ctx.slots.inject('plugins.row.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.row.config',
            key: rowKey,
            order: 10,
            label: '笔记设置',
            locale: CONFIG_NS,
            inject: (): Partial<ConfigCardProps> => ({ t: translator }),
          },
          NotesConfigCard,
        ),
      );

    const disposers = [bundle(), row()];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'notes: config page');

  /**
   * 6) 插件页上的「检查更新 / 更新」控件。
   *
   * 注册在 DSH 官方席位 `plugins.detail.actions` 上（插件详情页头部的控件区）。
   * 该席位由 DSH 的插件管理器声明，只有它挂载时才存在 —— `slots.inject` 会自动
   * 等它就绪；DSH 若删掉这个席位，这里只是不注册，不影响插件其余部分。
   *
   * 控件自己判断 subject：只有本插件的详情页才渲染，别的插件页返回 null。
   */
  ctx.effect(
    () =>
      ctx.slots.inject('plugins.detail.actions', () =>
        ctx.slots.register(
          {
            name: 'plugins.detail.actions',
            id: 'notes.update',
            order: 50,
            label: '笔记更新',
            inject: (): Partial<UpdateActionProps> => ({
              manager: pluginManager,
              // 问宿主是不是本地链接安装：只用于提示，拿不到就当不是。
              probeLocalInstall: async () => {
                try {
                  const info = await api.health();
                  return info.localInstall === true;
                } catch {
                  return false;
                }
              },
              /**
               * 查 npm 上的最新版本 —— 走**本插件自己的宿主半边**，不用插件管理
               * 服务的 `inspect`：后者是安装前校验，已安装的包会被它以
               * `already-installed` 拒绝，当「检查更新」用必然一进页面就失败。
               * 宿主返回它自己读出来的包名，插件改名/复刻也不会查错包。
               */
              checkLatest: async (fresh: boolean) => {
                const result = await api.latestVersion(fresh);
                // tarball 一并透传：升级靠它覆盖安装，`包名@版本` 会被带 HMR 的宿主拒绝。
                return {
                  name: result.name,
                  version: result.version,
                  tarball: result.tarball,
                };
              },
            }),
          },
          NotesUpdateAction,
        ),
      ),
    'notes: update action',
  );
}

/** 便于测试与排查的导出。 */
export { PANEL_ID, NotesPanel, NotesStore, NotesApi };
