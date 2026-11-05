/**
 * 「agent 指令文件」那一组纯函数的**按需加载器**。
 *
 * 【为什么不用静态 import】宿主入口只要有一个静态依赖缺失，**整个插件条目就会
 * 激活失败**。这在真实安装里踩过一次：发布包漏打了 globalInstructions.js，
 * 于是 lib/index.js 一 import 就 ERR_MODULE_NOT_FOUND，插件完全起不来 ——
 * 连插件页上那个「更新」按钮也一起消失了（按钮是本插件客户端半边注册的），
 * 用户被锁死：插件坏了，修它的唯一入口也没了，只能开终端手动装。
 *
 * 改成动态 import + 缓存之后：缺这一个文件只影响「agent 指令」相关接口
 * （返回一条明确的不可用提示），插件的笔记、文件树、染色、更新入口全部照常。
 *
 * 【为什么把错误也缓存】缺文件是安装包的问题，本次进程生命周期内不会自愈；
 * 每次都重新尝试一遍 import 只是反复产生失败的模块解析。
 */

/** agent 指令模块对外暴露的三个纯函数。 */
export interface AgentInstructionHelpers {
  /** DSH 默认会加载的那条指令文件的绝对路径。 */
  defaultAgentFilePath: () => string;
  /** 校验并规范化一个用户给出的指令文件路径。 */
  validateAgentFilePath: (raw: unknown) => string;
  /** 该路径是否为 DSH 自己那一条默认指令文件。 */
  isDefaultAgentFile: (target: string) => boolean;
}

/** 已成功加载的模块（成功后就一直复用）。 */
let helpers: AgentInstructionHelpers | null = null;

/** 加载失败的原因（失败后不再重复尝试）。 */
let loadError: string | null = null;

/**
 * 取 agent 指令模块，失败时抛出可直接展示给用户的原因。
 *
 * @returns 该模块的三个纯函数。
 * @throws Error 模块缺失或加载失败时抛出，消息里带修复建议。
 */
export async function loadAgentInstructions(): Promise<AgentInstructionHelpers> {
  if (helpers !== null) return helpers;
  if (loadError !== null) throw new Error(loadError);
  try {
    const loaded = (await import('./globalInstructions.js')) as AgentInstructionHelpers;
    helpers = loaded;
    return loaded;
  } catch (error) {
    // 只把原因记下来，不让它变成未处理的异常 —— 本插件其余功能不应受影响。
    loadError =
      '「agent 指令文件」功能不可用：安装包缺少 globalInstructions 模块' +
      `（${error instanceof Error ? error.message : String(error)}）。` +
      '这通常是插件安装不完整，请重新安装或更新本插件。';
    throw new Error(loadError);
  }
}
