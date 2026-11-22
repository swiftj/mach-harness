// Draws the stand-in design mock (a "My loans" screen) that fixture mode has no file for.
import { chromium } from "playwright";
import { join } from "node:path";
const html = `<body style="margin:0;font-family:Helvetica,Arial,sans-serif;background:#f6f4ef;width:960px;height:600px">
<div style="padding:28px 40px;background:#fff;border-bottom:1px solid #ddd;font-size:22px;font-weight:700;color:#222">Central Library <span style="font-weight:400;color:#888;margin-left:18px;font-size:16px">My loans</span></div>
<div style="padding:32px 40px">
${[["The Quiet Reader","Due 3 Dec","Renew"],["Atlas of Small Rivers","Due 9 Dec","Renew"],["Garden Notes","Due 12 Dec","Renewed"]].map(([t,d,b],i)=>`
<div style="display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid #ddd;border-radius:10px;padding:22px 26px;margin-bottom:16px">
<div><div style="font-size:20px;font-weight:600;color:#222">${t}</div><div style="font-size:15px;color:#777;margin-top:6px">${d}</div></div>
<div style="padding:12px 28px;border-radius:8px;font-size:16px;font-weight:600;${i<2?"background:#b5532f;color:#fff":"border:1px solid #bbb;color:#888"}">${b}</div></div>`).join("")}
</div></body>`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 960, height: 600 } });
await p.setContent(html);
await p.screenshot({ path: join(import.meta.dirname, "mock-my-loans.png") });
await b.close();
