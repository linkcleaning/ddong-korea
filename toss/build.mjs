// 웹판(저장소 루트)을 그대로 복사해 토스 미니앱용 dist/ 를 만들어요.
// 화장실 데이터(public/data)는 넣지 않고 GitHub Pages 에서 받아요 (매일 갱신 반영).
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url).pathname;
const OUT = new URL("./dist/", import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const p of ["css", "js", "icons", "fonts", "ddong.mp3", "favicon.ico", "privacy.html"]) {
  cpSync(ROOT + p, OUT + p, { recursive: true });
}

await build({
  entryPoints: [new URL("./bridge.js", import.meta.url).pathname],
  outfile: OUT + "js/ait-bridge.js",
  bundle: true, format: "iife", minify: true, target: "es2019",
});

let html = readFileSync(ROOT + "index.html", "utf8");
html = html
  .replace(/\s*<link rel="manifest"[^>]*>/, "")
  .replace(/\s*<script>\s*\/\/ 서비스워커[\s\S]*?<\/script>/, "")
  .replace('<script type="module" src="js/app.js"></script>',
    '<script src="js/ait-bridge.js"></script>\n  <script type="module" src="js/app.js"></script>');
if (!html.includes("ait-bridge.js")) throw new Error("index.html 에 app.js 스크립트 줄을 못 찾았어요");
if (html.includes("serviceWorker")) throw new Error("서비스워커 등록 코드가 남아 있어요");
writeFileSync(OUT + "index.html", html);
console.log("dist/ 준비 완료");
