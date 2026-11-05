/**
 * 发版前的打包自检：**入口引用的文件必须真的在 tarball 里**。
 *
 * 【为什么需要它】`package.json` 的 `files` 曾经是手写白名单，0.1.15 新增
 * `src/globalInstructions.ts` 后没人同步，于是从那之后的每一个 npm 包都缺
 * `lib/globalInstructions.js`；而 `lib/index.js` 又 import 了它，任何机器
 * 全新安装都会在插件加载时抛 ERR_MODULE_NOT_FOUND，插件直接起不来。
 *
 * 这个 bug 难被发现的原因：本地开发用的是 `link:`（整个目录挂进 profile），
 * 文件永远都在，只有真正从 npm 安装的机器才会踩到。
 *
 * 所以这里不猜、不读 glob：直接问 npm「你这次到底会打包哪些文件」，
 * 再逐个核对入口的相对导入。任何一处对不上就退出码非 0，`npm publish`
 * 会被 `prepublishOnly` 拦下来。
 *
 * 用法：node scripts/check-package.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** 报错并退出。 */
function fail(message) {
  console.error(`\n✗ 打包自检未通过：${message}\n`);
  process.exit(1);
}

/**
 * 问 npm 这次会打包哪些文件。
 *
 * 用 `--dry-run --json` 而不是自己套 glob：`files` 的匹配规则、`.npmignore`
 * 与默认排除项都由 npm 决定，只有它的答案是真的。
 *
 * @returns 包内相对路径（以 `lib/...` 形式，不带 `package/` 前缀）。
 */
function packedFiles() {
  let raw;
  try {
    raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    fail(`执行 npm pack --dry-run 失败：${String(error)}`);
  }
  const report = JSON.parse(raw);
  const entry = Array.isArray(report) ? report[0] : report;
  const files = entry?.files;
  if (!Array.isArray(files)) fail('npm pack --dry-run --json 没有返回文件清单');
  return new Set(files.map((file) => file.path));
}

/**
 * 找出一个模块里所有相对导入/导出的目标路径。
 *
 * 覆盖 `import … from './x.js'`、`export … from './x.js'`、动态
 * `import('./x.js')` 三种写法；只关心以 `./` 或 `../` 开头的（第三方包
 * 不在本包内，无需核对）。
 *
 * @param source - 模块源码。
 * @returns 出现过的相对路径（可能重复）。
 */
function relativeTargets(source) {
  const pattern = /(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g;
  const found = [];
  for (const match of source.matchAll(pattern)) found.push(match[1]);
  return found;
}

const packed = packedFiles();

/*
 * 待核对的本包模块：lib 下**所有**顶层 js。
 *
 * 不写死成 index.js / client.js：以后新增宿主侧模块（例如 agentInstructions.js
 * 这种按需加载的模块）会自动纳入核对，不会再出现「新模块的依赖没打进去」。
 */
const entries = readdirSync(join(root, 'lib'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => `lib/${name}`)
  .sort();
const missing = [];

for (const entry of entries) {
  let source;
  try {
    source = readFileSync(join(root, entry), 'utf8');
  } catch {
    fail(`缺少构建产物 ${entry}，请先执行 tsc 与 build-client.mjs`);
  }
  for (const target of relativeTargets(source)) {
    // 相对导入按所在文件所在目录解析，再换算成包内路径。
    const absolute = resolve(root, dirname(entry), target);
    const relative = absolute.slice(root.length + 1).split('\\').join('/');
    if (!packed.has(relative)) missing.push(`${entry} → ${target}（包内应有 ${relative}）`);
  }
}

if (missing.length > 0) {
  fail(
    `以下被引用的文件没有打进包，安装后会 ERR_MODULE_NOT_FOUND：\n  ` +
      `${missing.join('\n  ')}\n\n请检查 package.json 的 files 是否覆盖了这些产物。`,
  );
}

const jsCount = [...packed].filter((file) => file.endsWith('.js')).length;
console.log(`✓ 打包自检通过：${packed.size} 个文件，其中 ${jsCount} 个 js；入口相对导入全部在包内`);
