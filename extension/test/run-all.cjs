/*
 * 跑全部单测：node test/run-all.cjs （或 npm test）
 *
 * 每个 test/*.test.cjs 都是自带断言计数的独立脚本，可以单独跑。这里负责把它们
 * 串起来并汇总：任何一个失败就让进程非 0 退出，方便接到 CI 或 pre-commit 上。
 *
 * 为什么不用 `node --test test/`：那个参数会把目录当模块去 require，直接
 * MODULE_NOT_FOUND；`node --test test/*.test.cjs` 能跑，但会把每个文件当成一个
 * 用例、把自己的断言计数吞掉，看不出"一共多少条断言"。
 */
var fs = require("fs");
var path = require("path");
var { spawnSync } = require("child_process");

var dir = __dirname;
var files = fs.readdirSync(dir)
  .filter(function (f) { return /\.test\.cjs$/.test(f); })
  .sort();

var totalPass = 0, totalFail = 0, failedFiles = [];

files.forEach(function (f) {
  var r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: "utf8" });
  var out = (r.stdout || "") + (r.stderr || "");
  var m = /(\d+)\s+passed,\s*(\d+)\s+failed/.exec(out);
  var p = m ? +m[1] : 0, q = m ? +m[2] : (r.status === 0 ? 0 : 1);
  totalPass += p; totalFail += q;
  var bad = q > 0 || r.status !== 0;
  if (bad) failedFiles.push(f);
  console.log((bad ? "FAIL " : "ok   ") + pad(f, 28) + p + " passed, " + q + " failed");
  if (bad && !m) console.log(out.trim().split("\n").slice(0, 8).join("\n"));
});

function pad(s, n) { while (s.length < n) s += " "; return s; }

console.log("\n" + totalPass + " passed, " + totalFail + " failed  (" + files.length + " 个文件)");
if (totalFail || failedFiles.length) {
  console.log("失败文件：" + failedFiles.join(", "));
  process.exit(1);
}
