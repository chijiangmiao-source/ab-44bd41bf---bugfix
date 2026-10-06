'use strict';

/**
 * 构建检查（零依赖、零编译步骤）：
 *  1) 对所有 JS 源文件执行 `node --check` 语法校验；
 *  2) 校验页面引用的静态资源齐备；
 *  3) 产出 dist/（运行时所需文件），供精简运行镜像使用。
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const JS_TARGETS = [
  'src/engine.js', 'src/server.js', 'public/app.js',
  'scripts/build.cjs', 'scripts/verify.cjs',
];
const COPY_TARGETS = ['src', 'public', 'package.json'];
const REQUIRED_IN_HTML = ['/style.css', '/engine.js', '/app.js'];

let failed = false;
function fail(msg) { console.error('✗ ' + msg); failed = true; }
function ok(msg) { console.log('✓ ' + msg); }

// 1) 语法检查
for (const rel of JS_TARGETS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { fail(`源文件缺失：${rel}`); continue; }
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    ok(`语法检查通过：${rel}`);
  } catch (e) {
    fail(`语法错误：${rel}\n${e.stderr ? e.stderr.toString() : e.message}`);
  }
}

// 2) 页面资源完整性
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
for (const asset of REQUIRED_IN_HTML) {
  const file = path.join(ROOT, 'public', asset === '/engine.js' ? '../src/engine.js' : asset);
  if (!fs.existsSync(file)) fail(`页面引用资源缺失：${asset}`);
  else if (!html.includes(asset)) fail(`页面未引用资源：${asset}`);
  else ok(`页面资源齐备：${asset}`);
}

// 3) 产出 dist/
if (!failed) {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  for (const rel of COPY_TARGETS) {
    fs.cpSync(path.join(ROOT, rel), path.join(DIST, rel), { recursive: true });
  }
  ok(`构建产物已输出：dist/（${COPY_TARGETS.join(', ')}）`);
}

if (failed) {
  console.error('\n构建检查失败。');
  process.exit(1);
}
console.log('\n构建检查通过。');
