/**
 * DSH 的全局 agent 指令文件（`AGENTS.md`）的定位与围栏。
 *
 * 【这些文件是什么】DSH 的 `dsh-agent-instructions` 插件在每次会话开头把若干
 * `AGENTS.md` 拼成一段上下文注入给模型 —— 「所有回复用中文」「每行不超过 100 列」
 * 这类规则就写在那里面。**它约束的是模型怎么做事，不是 DSH 程序怎么跑。**
 *
 * 【为什么默认只给一条】本插件是通用的，不该替用户假设「你一定只用 DSH 的
 * 那几个约定路径」。所以预置项只有 DSH 自己那一条，其余走「用户自己添加」：
 * 谁有别的需求（比如用 `~/.agents/AGENTS.md` 跟 Claude Code 共用，或某个项目
 * 的指令文件），自己把路径加进来即可。
 *
 * 【信任模型】与「用户选中的笔记文件夹」同一层 —— **用户亲手加进来的路径**
 * 就是授权来源。插件不扫描、不遍历、不猜测任何目录。
 */
import { homedir } from 'node:os';
import { extname, isAbsolute, join, normalize, resolve } from 'node:path';

/** DSH 专属 home 目录名。 */
const DSH_HOME_DIR = '.dsh';

/**
 * DSH 的全局 agent 指令文件里，只给这一个做预置。
 *
 * 目录跟随 `$DSH_HOME`（DSH 自己的 `dsh-home-paths` 就是这么解析的），
 * 没设才落到 `~/.dsh`。这样用户改过 home 位置时，这里指的仍是 DSH 真正
 * 会加载的那份。
 *
 * @returns 绝对路径。
 */
export function defaultAgentFilePath(): string {
  const env = process.env.DSH_HOME;
  const root =
    typeof env === 'string' && env.trim() !== '' ? resolve(env.trim()) : join(homedir(), DSH_HOME_DIR);
  return join(root, 'AGENTS.md');
}

/**
 * 允许当作「agent 指令文件」的扩展名。
 *
 * 收窄到文本类扩展名有两个作用：① 这类文件本来就只可能是文本（指令文件
 * 是给模型读的）；② 万一有人加了个二进制路径进来，读出来是乱码、写回去
 * 会毁掉原文件 —— 直接拒绝比事后解释便宜。
 */
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.mdown', '.mkd']);

/** 无扩展名时允许的常见文件名（大小写不敏感）。 */
const TEXT_BASENAMES = new Set(['agents', 'claude', 'readme', 'license', 'makefile']);

/**
 * 校验一个路径能不能当作 agent 指令文件。
 *
 * 三重检查，缺一不可：
 * 1. 必须是绝对路径、不含 NUL；
 * 2. 必须是文本类扩展名（或常见无扩展名文本文件）；
 * 3. 不能是根目录 / 家目录本身这种明显是目录的路径。
 *
 * @param raw - 客户端给的路径。
 * @returns 规范化后的绝对路径。
 * @throws Error - 不合规时抛错（调用方转成 400）。
 */
export function validateAgentFilePath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('path is required');
  }
  const trimmed = raw.trim();
  if (!isAbsolute(trimmed)) throw new Error('path must be absolute');
  if (trimmed.includes('\0')) throw new Error('invalid path');

  const target = normalize(trimmed);
  const ext = extname(target).toLowerCase();
  if (ext !== '') {
    if (!TEXT_EXTENSIONS.has(ext)) {
      throw new Error(`only text instruction files may be opened (got ${ext})`);
    }
    return target;
  }

  const base = target.slice(target.lastIndexOf('/') + 1).toLowerCase();
  if (base === '') throw new Error('path must point to a file');
  if (!TEXT_BASENAMES.has(base)) {
    throw new Error(`only text instruction files may be opened (got ${base || 'no extension'})`);
  }
  return target;
}

/**
 * 这个路径是不是 DSH 预置的那条。
 *
 * 预置项允许**文件尚不存在**（用户可能还没建过），所以它有单独的「读不到就
 * 返回空内容」的处理。自定义项也一样允许不存在（用户可能想新建），因此这个
 * 判断只用于界面上标「DSH 默认」，不参与围栏。
 *
 * @param target - 规范化的绝对路径。
 * @returns 是预置项则为 true。
 */
export function isDefaultAgentFile(target: string): boolean {
  return resolve(target) === resolve(defaultAgentFilePath());
}
