// 拼出两个壳：src/core.js 原样放进 src/manager.js 和 src/window.js 里 `/*CORE*/` 那一行。
//   node userscript/build.mjs          写出 usuyo-xhs-saved.user.js（脚本管理器）和 usuyo-xhs-window.js（usuyo 的站点窗口）
//   node userscript/build.mjs --check  只核对写好的和源文件拼出来的一样，不一样时退出码 1
// 测试（test/userscript.test.mjs）也调 build()，写好的文件过时了就不过。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => new URL(p, import.meta.url);

export const OUTPUTS = {
  'usuyo-xhs-saved.user.js': './src/manager.js',
  'usuyo-xhs-window.js': './src/window.js',
};

/** 文件名 → 拼好的全文。 */
export function build() {
  const core = readFileSync(here('./src/core.js'), 'utf8').replace(/\n$/, '');
  const out = {};
  for (const [name, shell] of Object.entries(OUTPUTS)) {
    const text = readFileSync(here(shell), 'utf8');
    if (text.split('/*CORE*/').length !== 2) throw new Error(shell + ' needs exactly one /*CORE*/ line');
    // 用函数换：核心里有 `$`，字符串的替换写法会把它当成特殊记号
    out[name] = text.replace('/*CORE*/', () => core);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let stale = false;
  for (const [name, text] of Object.entries(build())) {
    const path = here('./' + name);
    if (check) {
      if (readFileSync(path, 'utf8') !== text) {
        console.error(name + ' is out of date: run node userscript/build.mjs');
        stale = true;
      }
    } else {
      writeFileSync(path, text);
      console.log('wrote ' + name);
    }
  }
  process.exit(stale ? 1 : 0);
}
