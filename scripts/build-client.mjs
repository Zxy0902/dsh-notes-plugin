/**
 * 极简客户端打包脚本。
 *
 * DSH 的客户端 bundle 必须是一个 `window.__ModuleLoader__.load({ id, factory })`
 * 包装，其中 `require` 只解析平台基线（React 等）——因为宿主冻结了一张模块表，
 * 只允许基线模块和自己声明的 external。
 *
 * 本插件刻意零三方运行时依赖，所以这里不需要真的打包器：
 * 依次读取各模块源码、剥掉 import/export 语法、拼进一个 factory 里即可。
 * 这样构建产物只有我们自己写的代码，升级 DSH 不会因为依赖漂移而崩。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** 参与打包的模块，顺序即依赖顺序（被依赖者在前）。 */
const MODULES = [
  'lib/client/api.js',
  'lib/client/store.js',
  'lib/client/styles.js',
  'lib/client/treeOps.js',
  'lib/client/useScrollSync.js',
  'lib/client/useElementWidth.js',
  // 大纲：纯逻辑与 UI 拆成两个模块，都要登记 —— 漏登记就是运行时
  // `__mod_Outline is not defined`（这个坑踩过两次了）。
  'lib/client/Outline.js',
  'lib/client/OutlinePane.js',
  'lib/client/NotesPanel.js',
  // 插件页里的配置面板：不登记的话打包产物里没有它，
  // 运行时 `__mod_ConfigCard is not defined`（与 UpdateAction 同一个坑）。
  'lib/client/ConfigCard.js',
  // 插件页上的更新控件：必须登记，否则打包产物里缺少该模块的表项，
  // 运行时会报 `__mod_UpdateAction is not defined`（新增客户端模块时都要加这里）。
  'lib/client/UpdateAction.js',
  'lib/client/index.js',
];

/**
 * 平台基线模块：DSH 冻结模块表（PLATFORM_MODULES）里提供的，可以直接 require，
 * 也不需要写进 dsh.client.inject。
 *
 * 依据：官方包（如 dsh-client-ui-sidebar-right、dsh-client-ui-sidebar-files）
 * 都直接 require 这些包，且没有把它们列进 dsh.client.inject —— 因为它们是
 * 「静态 UI 库」，属于基线的一部分。只有非基线的动态包才需要 inject 声明。
 *
 * 除了这些，任何第三方 npm 库都不能 require，否则 bundle 加载会失败。
 */
const PLATFORM_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
]);

/**
 * 平台模块 → factory 内局部变量名。
 * 生成 require 与重写 import 必须用同一个映射，否则绑定会对不上。
 * react 与 react/jsx-runtime 是两个独立模块，名字不能撞。
 */
function mangleModuleId(spec) {
  if (spec === 'react') return 'react';
  if (spec === 'react/jsx-runtime') return 'react_jsx_runtime';
  return spec.replace(/[^a-zA-Z0-9]/g, '_');
}

/**
 * 把一份 TS/TSX 源码转成可以塞进 factory 的纯 JS。
 *
 * 因为源码写的是 ESM，而 factory 是 CommonJS 风格，这里做最小转换：
 * - import 语句记录到「需要用到的平台模块」集合，本身删除
 * - export 关键字删除（导出改为统一在末尾导出）
 * 类型注解已经由 tsc 的产物负责，这里处理的是 tsc 输出的 JS。
 */
function transform(code, file) {
  const required = new Set();
  let out = code;

  /**
   * 把一条 import 语句换成等价的解构绑定。
   *
   * factory 是 CommonJS 风格，每个平台模块在顶部统一 require 成
   * `var <mangled> = require("...")`，所以这里只需把导入名绑定到那个变量上：
   *   import { a, b as c } from 'x'   →  const { a, b: c } = <mangled_x>;
   *   import d from 'x'               →  const d = <mangled_x>.default ?? <mangled_x>;
   *   import * as e from 'x'          →  const e = <mangled_x>;
   *
   * 相对导入（同包内模块）已被内联进同一个 factory，所以整条删掉即可，
   * 这些模块的顶层 const/function 声明在 factory 作用域里本来就可见。
   */
  const mangled = mangleModuleId;

  const rewriteImport = (clause, spec) => {
    const trimmed = clause.trim();

    // 相对导入：模块已内联，无需绑定。
    if (spec.startsWith('./') || spec.startsWith('../')) return '';

    required.add(spec);
    const src = mangled(spec);

    // 纯副作用导入
    if (trimmed === '') return '';

    // 命名空间导入：import * as ns from 'x'
    const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
    if (ns !== null) return `const ${ns[1]} = ${src};`;

    // 默认导入（可能带命名成员）：import d, { a } from 'x'
    const both = /^([A-Za-z_$][\w$]*)\s*,\s*\{([^}]*)\}$/.exec(trimmed);
    if (both !== null) {
      const pairs = namedPairs(both[2]);
      return `const ${both[1]} = ${src}.default ?? ${src};\nconst { ${pairs} } = ${src};`;
    }

    // 单独默认导入：import d from 'x'（仅当不是 {…} 时）
    if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
      return `const ${trimmed} = ${src}.default ?? ${src};`;
    }

    // 具名导入：import { a, b as c } from 'x'
    const named = /^\{([^}]*)\}$/.exec(trimmed);
    if (named !== null) {
      const pairs = namedPairs(named[1]);
      return pairs === '' ? '' : `const { ${pairs} } = ${src};`;
    }

    throw new Error(`${file}: 无法识别的 import 子句：import ${trimmed} from '${spec}'`);
  };

  /** 把 `a, b as c` 转成解构用的 `a, b: c`。 */
  function namedPairs(list) {
    return list
      .split(',')
      .map((piece) => piece.trim())
      .filter((piece) => piece !== '')
      .map((piece) => {
        const alias = piece.split(/\s+as\s+/);
        return alias.length === 2 ? `${alias[0].trim()}: ${alias[1].trim()}` : piece;
      })
      .join(', ');
  }

  // import ... from 'x'（含具名、默认、命名空间、混合）
  out = out.replace(
    /^\s*import\s+([^;]*?)\s+from\s*['"]([^'"]+)['"];?\s*$/gm,
    (_m, clause, spec) => rewriteImport(clause, spec),
  );
  // 纯副作用 import 'x'
  out = out.replace(/^\s*import\s*['"]([^'"]+)['"];?\s*$/gm, (_m, spec) => rewriteImport('', spec));
  // import type ... （编译后通常已被擦除，这里兜底）
  out = out.replace(/^\s*import\s+type\s+[^;]*;?\s*$/gm, '');

  // export 关键字：声明式导出改为普通声明，并记录导出名
  const exported = [];
  out = out.replace(
    /^\s*export\s+((?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/gm,
    (match, _decl, fnName, varName) => {
      exported.push(fnName ?? varName);
      return match.replace(/^(\s*)export\s+/, '$1');
    },
  );

  // export { a, b as c };  →  收集导出名后删除
  out = out.replace(/^\s*export\s*\{([^}]*)\};?\s*$/gm, (_m, names) => {
    for (const raw of names.split(',')) {
      const piece = raw.trim();
      if (piece === '') continue;
      const alias = piece.split(/\s+as\s+/);
      exported.push(alias.length === 2 ? `${alias[1].trim()}: ${alias[0].trim()}` : piece);
    }
    return '';
  });
  // export default
  out = out.replace(/^\s*export\s+default\s+/gm, 'const __default__ = ');

  // 检查残留的 import/export（说明转换没覆盖到，宁可报错也不要产出坏包）
  if (/^\s*(import|export)\b/m.test(out)) {
    const line = out.split('\n').find((l) => /^\s*(import|export)\b/.test(l));
    throw new Error(`${file}: 仍有未处理的 ESM 语法：${line.trim().slice(0, 80)}`);
  }

  return { code: out, required, exported };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const parts = [];
const allRequired = new Set();
const allExported = [];

for (const relative of MODULES) {
  const absolute = join(root, relative);
  let source;
  try {
    source = readFileSync(absolute, 'utf8');
  } catch {
    throw new Error(`缺少编译产物：${relative}（请先运行 tsc）`);
  }

  const { code, required, exported } = transform(source, relative);
  for (const spec of required) allRequired.add(spec);
  for (const name of exported) allExported.push(name);

  // 每个模块各自包一层 IIFE，拥有独立作用域。
  //
  // 为什么必须这么做：多个模块都会从 react 解构出同名绑定（_jsx / _jsxs 等），
  // 平铺进同一个 factory 作用域会直接抛 "Identifier has already been declared"。
  // 各模块的顶层 const/function 声明彼此不可见，跨模块引用一律通过 import/export，
  // 所以隔离作用域不会丢东西。
  //
  // 模块内部的具名导出挂到各自的 module.exports 上，供后续模块引用。
  const local = moduleLocalName(relative);
  const ns = `__mod_${local}`;

  // 本模块对外导出的名字（声明式 + export {} 两种形式）。
  const exportAssign = exported
    .map((entry) => {
      const trimmed = entry.trim();
      if (trimmed.includes(':')) {
        const [alias, localName] = trimmed.split(':').map((p) => p.trim());
        return `    __exports.${alias} = ${localName};`;
      }
      return `    __exports.${trimmed} = ${trimmed};`;
    })
    .join('\n');

  // 注入「相对导入解析」：transform 把相对 import 整条删了，这里补回绑定，
  // 指向被内联模块的命名空间。
  const relativeBindings = collectRelativeBindings(source, relative)
    .map(({ names, from }) => `    const { ${names} } = __mod_${moduleLocalName(from)};`)
    .join('\n');

  parts.push(
    `// ---- ${relative} ----\n` +
      `const ${ns} = (() => {\n` +
      `    const __exports = {};\n` +
      `${relativeBindings}\n` +
      `${code}\n` +
      `${exportAssign}\n` +
      `    return __exports;\n` +
      `})();`,
  );
}

/**
 * 模块路径 → 局部变量后缀（api.js → api，NotesPanel.js → NotesPanel）。
 * @param relative - 相对仓库根的模块路径。
 * @returns 合法标识符后缀。
 */
function moduleLocalName(relative) {
  const base = relative.split('/').pop().replace(/\.js$/, '');
  return base.replace(/[^a-zA-Z0-9_$]/g, '_');
}

/**
 * 收集一个模块里的相对导入绑定，用于在内联后恢复这些引用。
 *
 * transform 把 `import { A, B } from './x'` 整条删了（因为 ./x 已被内联），
 * 但模块体里仍在用 A、B，所以这里把绑定补回去，指向那个模块的命名空间。
 *
 * @param source - 模块源码（tsc 产物）。
 * @param file - 模块路径，用于报错。
 * @returns 每条相对导入的 { names, from }。
 */
function collectRelativeBindings(source, file) {
  const out = [];
  const re = /^\s*import\s+([^;]*?)\s+from\s*['"](\.[^'"]+)['"];?\s*$/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    const clause = m[1].trim();
    const spec = m[2];

    // 解析成 ./api → lib/client/api.js
    const dir = file.split('/').slice(0, -1).join('/');
    const target = new URL(spec, `file:///${dir}/`).pathname.replace(/^\//, '');
    const from = `${target}.js`;

    const named = /^\{([^}]*)\}$/.exec(clause);
    if (named !== null) {
      const names = named[1]
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== '')
        .map((p) => {
          const alias = p.split(/\s+as\s+/);
          return alias.length === 2 ? `${alias[0].trim()}: ${alias[1].trim()}` : p;
        })
        .join(', ');
      if (names !== '') out.push({ names, from });
      continue;
    }

    // 默认导入 / 混合导入：用命名空间兜底
    const both = /^([A-Za-z_$][\w$]*)\s*,\s*\{([^}]*)\}$/.exec(clause);
    if (both !== null) {
      const names = both[2]
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== '')
        .map((p) => {
          const alias = p.split(/\s+as\s+/);
          return alias.length === 2 ? `${alias[0].trim()}: ${alias[1].trim()}` : p;
        })
        .join(', ');
      out.push({ names: `${both[1]}: __default__, ${names}`, from });
      continue;
    }

    if (/^[A-Za-z_$][\w$]*$/.test(clause)) {
      out.push({ names: `${clause}: __default__`, from });
      continue;
    }

    const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause);
    if (ns !== null) {
      out.push({ names: `__ns: ${ns[1]}`, from });
      continue;
    }

    throw new Error(`${file}: 无法解析相对导入：import ${clause} from '${spec}'`);
  }
  return out;
}

// 校验：相对导入是同包内模块，已被内联进同一个 factory，应忽略；
// 其余必须命中平台基线，否则 bundle 在浏览器里加载会失败。
for (const spec of allRequired) {
  if (spec.startsWith('./') || spec.startsWith('../')) continue;
  if (!PLATFORM_MODULES.has(spec)) {
    throw new Error(
      `客户端引用了非平台基线模块 "${spec}"。DSH 冻结的模块表只提供 React 和静态 UI 库，` +
        `引入其他第三方库会导致 bundle 加载失败。`,
    );
  }
}

// 只对真正的平台模块生成 require。
const externalModules = [...allRequired].filter(
  (spec) => !spec.startsWith('./') && !spec.startsWith('../'),
);

const requires = externalModules
  .sort()
  .map((spec) => `\t\tvar ${mangleModuleId(spec)} = require(${JSON.stringify(spec)});`)
  .join('\n');

// 导出：把真正对外的名字挂到 module.exports 上。
// 内部符号不导出，避免跨模块同名冲突。
// 对外导出：取自入口模块的命名空间。
// 每个模块都有独立作用域，同名符号（如各模块解构出的 _jsx）不再冲突，
// 所以这里只从入口模块取，语义最清晰。
const ENTRY = 'lib/client/index.js';
const ENTRY_NS = `__mod_${moduleLocalName(ENTRY)}`;
const PUBLIC_NAMES = ['apply', 'inject', 'PANEL_ID', 'NotesPanel', 'NotesStore', 'NotesApi'];
const exportLines = PUBLIC_NAMES.map((name) => `\t\texports.${name} = ${ENTRY_NS}.${name};`);

const bundle = `/**
 * dsh-client-ui-notes — 客户端(浏览器)半边构建产物。
 *
 * 由 scripts/build-client.mjs 生成，请勿手改。
 * 零三方运行时依赖：只使用 DSH 冻结模块表里的平台基线模块。
 */
window.__ModuleLoader__.load({
\tid: "dsh-client-ui-notes",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${requires}

${parts.join('\n\n')}

${exportLines.join('\n')}
\t\treturn module.exports;
\t}
});
`;

mkdirSync(join(root, 'lib'), { recursive: true });
writeFileSync(join(root, 'lib/client.js'), bundle, 'utf8');

const bytes = Buffer.byteLength(bundle, 'utf8');
console.log(`已生成 lib/client.js（${(bytes / 1024).toFixed(1)} KB）`);
console.log(`平台模块：${externalModules.join(', ') || '（无）'}`);
