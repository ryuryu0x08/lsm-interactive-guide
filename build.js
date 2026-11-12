// 把 src/ 下的文件内联成单个页面。
//   dist/artifact.html  不带 <html>/<head>/<body> 的片段
//   index.html          可直接用浏览器打开的完整页面
const fs = require('fs'), path = require('path');
const rd = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
const js = ['engine.js', 'ui.js', 'viz-skiplist.js', 'viz-wal.js', 'chapters-a.js', 'chapter-1.js', 'chapter-3.js', 'chapters-b.js', 'glossary.js', 'main.js'].map((f) => `<script>\n${rd(f).replace(/<\/script/g, '<\\/script')}\n</script>`).join('\n');
const head = `<title>RocksDB LSM 交互教程</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;600&display=swap">
<style>\n${rd('style.css')}\n</style>`;
const body = `<div class="app"><nav class="toc" id="toc" aria-label="章节"></nav><main id="main"></main></div>\n${js}`;
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'artifact.html'), head + '\n' + body + '\n');
fs.writeFileSync(path.join(__dirname, 'index.html'), `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${head}\n<style>body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`);
console.log('built', fs.statSync(path.join(__dirname, 'index.html')).size, 'bytes');
