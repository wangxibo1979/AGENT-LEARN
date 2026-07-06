#!/usr/bin/env node
// s16 免 key 演示 —— MoA 顾问团塞进 agent 循环，三笔账算给你看。
//   账一：顾问看什么 —— 对话扁平化成纯文本咨询视图（工具轨迹保留，结果截断）
//   账二：建议放哪 —— 追加在消息末尾（前缀稳定） vs 合并进任务消息（前缀击穿）
//   账三：跑多勤 —— 每次工具迭代都问一遍顾问团，账单是几倍
//
// 运行：node s16_moa/demo.mjs

const tok = (s) => Math.round(s.length / 4); // 字符近似 token（够算相对账）

// ─── 造一个真实形状的 turn：系统提示 + 任务 + 6 次工具迭代 ─────────────────
const SYSTEM = "你是一个 coding agent……（8000 字符的系统提示）".padEnd(8000, "。");
const TASK = { role: "user", content: "帮我修复 engine.ts 里的流式中断 bug" + "，细节……".padEnd(500, "。") };

function buildTranscript(iterations) {
  const msgs = [{ role: "system", content: SYSTEM }, TASK];
  for (let i = 1; i <= iterations; i++) {
    msgs.push({
      role: "assistant",
      content: `第 ${i} 步：我先看下相关代码。`,
      tool_calls: [{ function: { name: "read_file", arguments: `{"path":"src/step${i}.ts"}` } }],
    });
    msgs.push({ role: "tool", content: `// step${i}.ts 的内容`.padEnd(9000, "x") }); // 9k 字符的工具结果
  }
  return msgs;
}

// ─── 账一：顾问的咨询视图 —— 扁平化 + 截断 + 末尾补 user ──────────────────
// 顾问是参谋不是替身：没有工具，也不能收 tool 角色消息（strict provider 会 400）。
// 所以把整段对话压成纯 user/assistant 文本：工具调用渲染成一行字，工具结果
// head+tail 截断后折进上一条 assistant；最后补一条合成 user（Anthropic 要求
// 末尾是 user，否则当成 prefill 拒掉）。
const RESULT_BUDGET = 4000;
const ADVISORY_ASK = "[以上是任务现状。给出你的判断：发生了什么、下一步该做什么、有什么风险。]";

const truncate = (s) =>
  s.length <= RESULT_BUDGET
    ? s
    : `${s.slice(0, RESULT_BUDGET / 2)}\n[... ${s.length - RESULT_BUDGET} chars omitted ...]\n${s.slice(-RESULT_BUDGET / 2)}`;

function flattenForAdvisor(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "system") continue; // 8k 系统提示不是咨询信号，扔掉
    if (m.role === "user") out.push({ role: "user", content: m.content });
    if (m.role === "assistant") {
      const calls = (m.tool_calls ?? [])
        .map((c) => `[called tool: ${c.function.name}(${c.function.arguments})]`)
        .join("\n");
      out.push({ role: "assistant", content: [m.content, calls].filter(Boolean).join("\n") });
    }
    if (m.role === "tool") out.at(-1).content += `\n[tool result: ${truncate(m.content)}]`;
  }
  if (out.at(-1)?.role === "assistant") out.push({ role: "user", content: ADVISORY_ASK });
  return out;
}

const full = buildTranscript(6);
const flat = flattenForAdvisor(full);
const bytes = (msgs) => msgs.reduce((n, m) => n + m.content.length, 0);
console.log("━━━ 账一：顾问的咨询视图（扁平化） ━━━");
console.log(`  完整 transcript：${full.length} 条消息（含 system/tool 角色）· ${bytes(full)} 字符`);
console.log(`  咨询视图　　　：${flat.length} 条消息（只有 user/assistant）· ${bytes(flat)} 字符`);
console.log(`  末尾角色：${flat.at(-1).role} ✅（不补这条合成 user，Anthropic 直接 400）`);
console.log(`  工具轨迹保留：${flat.filter((m) => m.content.includes("[called tool:")).length}/6 · 工具结果截断：9000 → ≤${RESULT_BUDGET} 字符\n`);

// ─── 账二：聚合器拿到建议，放哪 —— 前缀稳定性（s07 的老朋友） ─────────────
const commonPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};
const ser = (msgs) => JSON.stringify(msgs);
console.log("━━━ 账二：建议注入位置 vs prompt cache 前缀 ━━━");
for (const [label, inject] of [
  ["合并进任务 user 消息（前部）", (msgs, g) => { const c = msgs.map((m) => ({ ...m })); c[1].content += "\n\n" + g; return c; }],
  ["追加在消息末尾（尾部）　　　", (msgs, g) => [...msgs, { role: "user", content: g }]],
]) {
  const turn1 = inject(buildTranscript(5), "[顾问团建议 · 第 5 步版]");
  const turn2 = inject(buildTranscript(6), "[顾问团建议 · 第 6 步版]");
  const reuse = commonPrefix(ser(turn1), ser(turn2));
  const pct = ((reuse / ser(turn1).length) * 100).toFixed(1);
  console.log(`  ${label}：迭代间前缀复用 ${pct}% ${pct > 99 ? "✅ 只重算新增部分" : "❌ 建议每步都变 → 任务消息每步都变 → 后面全价重算"}`);
}
console.log();

// ─── 账三：跑多勤 —— 3 个顾问 × 6 次迭代，账单是几倍 ─────────────────────
// 计费模型（沿 s07）：命中缓存的前缀按 1 折，新增部分全价。
const N_ADVISORS = 3;
const ITERS = 6;
const CACHED = 0.1;

function bill(scheme) {
  let total = 0;
  let advisorPrev = 0; // 顾问视图上一轮的可复用前缀（token）
  for (let i = 1; i <= ITERS; i++) {
    const acting = buildTranscript(i);
    const actingTok = tok(ser(acting));
    const prevTok = i === 1 ? 0 : tok(ser(buildTranscript(i - 1)));
    total += prevTok * CACHED + (actingTok - prevTok); // 聚合器永远在场且吃缓存
    const advisorRuns =
      scheme.cadence === "none" ? 0 : scheme.cadence === "user_turn" ? (i === 1 ? 1 : 0) : 1;
    if (advisorRuns) {
      const viewTok = tok(ser(flattenForAdvisor(acting)));
      const cachedPart = scheme.advisorCache ? Math.min(advisorPrev, viewTok) : 0;
      total += N_ADVISORS * (cachedPart * CACHED + (viewTok - cachedPart));
      advisorPrev = viewTok;
    }
  }
  return Math.round(total);
}

console.log(`━━━ 账三：fan-out 节奏 ×（${N_ADVISORS} 个顾问 · ${ITERS} 次工具迭代，计费输入 token） ━━━`);
const solo = bill({ cadence: "none" });
for (const [label, scheme] of [
  ["单模型（没有 MoA）　　　　　　　　", { cadence: "none" }],
  ["每步问顾问团 · 顾问不打 cache 标记", { cadence: "per_iteration", advisorCache: false }],
  ["每步问顾问团 · 顾问也吃缓存　　　", { cadence: "per_iteration", advisorCache: true }],
  ["每个 user turn 只问一次（user_turn）", { cadence: "user_turn", advisorCache: true }],
]) {
  const t = bill(scheme);
  console.log(`  ${label}：${String(t).padStart(7)} tok · ${(t / solo).toFixed(1)}×`);
}
console.log("\n  → 最直觉的实现（每步 fan-out、忘打缓存标记）就是最贵的那行。");
console.log("  → hermes-agent 实测同款事故：advisor 全程 0/1227 次缓存命中，11.5M token 重计费。");
