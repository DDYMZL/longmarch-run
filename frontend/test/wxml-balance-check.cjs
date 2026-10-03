const fs = require('fs');
const files = ['pages/ticket/ticket.wxml', 'pages/node-detail/node-detail.wxml', 'pages/home/home.wxml'];
const re = /<(\/?)(view|text|image|canvas|block|scroll-view|button|navigator|map|swiper|swiper-item)\b([^>]*)>/g;
let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  let depth = 0, min = 0, m;
  while ((m = re.exec(src))) {
    if (!m[1] && m[3].replace(/\s/g, '').endsWith('/')) continue;
    depth += m[1] ? -1 : 1;
    if (depth < min) min = depth;
  }
  const ok = depth === 0 && min === 0;
  if (!ok) bad++;
  console.log(f, 'depth=' + depth, 'min=' + min, ok ? 'OK' : 'UNBALANCED');
}
process.exit(bad ? 1 : 0);
