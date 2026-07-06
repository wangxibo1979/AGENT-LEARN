#!/usr/bin/env node
// s17 免 key 演示 —— 自进化复盘环，三笔账算给你看。
//   账一：跑多勤 —— 记忆按「用户轮数」、技能按「工具迭代数」，两条独立节奏各自到点
//   账二：谁来蒸馏 —— 同模型全量重放（吃热缓存） vs 换便宜模型 digest 重放（省冷写）
//   账三：不污染 —— fork 共享 session 写回主对话（中毒） vs 持久化隔离后干净
//
// 运行：node s17_self_evolution/demo.mjs

const tok = (s) => Math.round(s.length / 4); // 字符近似 token（够算相对账）
const ser = (msgs) => JSON.stringify(msgs);

// ─── 账一：两条独立节奏 ──────────────────────────────────────────────────
// 复盘不是「每轮都跑」，而是两个不同计数器各自到点：
//   记忆复盘：按 USER 轮数（_turns_since_memory），到 N 轮触发一次
//   技能复盘：按本次 TOOL 迭代数（_iters_since_skill），累计到 N 次触发一次
// 不对称是刻意的：一轮里跑了很多工具 = 干了真活 = 大概率产出了值得记的技术；
// 而「用户是谁」这种记忆信号随对话深度累积，按轮更合理。
// 真实默认都是 10/10；演示用小值 4/6 把节奏缩短到一屏看得见。
const MEM_EVERY = 4; // 每 4 个用户轮 → 一次记忆复盘
const SKILL_EVERY = 6; // 累计 6 次工具迭代 → 一次技能复盘

// 一个会话：每个用户轮用掉不同数量的工具迭代（有的轻问答，有的重改代码）
const SESSION = [1, 0, 5, 1, 0, 3, 8, 0, 1, 2, 4, 1]; // 每轮的工具迭代数

console.log("━━━ 账一：两条独立节奏（记忆按轮 · 技能按工具迭代） ━━━");
let sinceMem = 0;
let sinceSkill = 0;
let memFires = 0;
let skillFires = 0;
const trace = [];
SESSION.forEach((iters, idx) => {
  const turn = idx + 1;
  sinceMem += 1;
  sinceSkill += iters;
  const fired = [];
  if (sinceMem >= MEM_EVERY) {
    memFires += 1;
    sinceMem = 0;
    fired.push("记忆");
  }
  if (sinceSkill >= SKILL_EVERY) {
    skillFires += 1;
    sinceSkill = 0;
    fired.push("技能");
  }
  trace.push(`  轮${String(turn).padStart(2)} · ${iters}次工具  ${fired.length ? "→ 复盘[" + fired.join("+") + "]" : ""}`);
});
trace.forEach((l) => console.log(l));
console.log(`  ${SESSION.length} 个用户轮、${SESSION.reduce((a, b) => a + b, 0)} 次工具迭代 → 记忆复盘 ${memFires} 次、技能复盘 ${skillFires} 次`);
console.log("  → 重工具轮（轮7 的 8 次）单轮就把技能计数器顶过阈值；记忆则只认轮数，与工具量无关。\n");

// ─── 账二：谁来蒸馏 —— 同模型热缓存 vs 换便宜模型 digest ─────────────────
// 复盘 = fork 一个 agent 重放对话，把跨会话仍成立的东西写进记忆/技能。
// 默认 fork 用「同一个模型」：主对话刚跑完，整段 transcript 还在 prompt cache 里
// 是热的，全量重放 = 廉价的 cache 读，不是冷写。
// 只有换「不同（更便宜）的模型」时缓存才凉——这时改走 digest：最近 24 条原文保留，
// 更早的每条塌成一行摘要（USER:≤300 / ASSISTANT[tools]/ ASSISTANT:≤200），少写冷 token。
const TAIL = 24;

function buildLongTranscript(turns) {
  const msgs = [{ role: "system", content: "coding agent 系统提示".padEnd(8000, "。") }];
  for (let i = 1; i <= turns; i++) {
    msgs.push({ role: "user", content: `第 ${i} 个请求：改一下 x`.padEnd(120, "。") });
    msgs.push({
      role: "assistant",
      content: `第 ${i} 步分析。`,
      tool_calls: [{ function: { name: "read_file", arguments: `{"path":"s${i}.ts"}` } }],
    });
    msgs.push({ role: "tool", content: `// s${i}.ts`.padEnd(3000, "x") }); // 3k 工具结果
  }
  return msgs;
}

function digestHistory(msgs, tail = TAIL) {
  if (msgs.length <= tail) return msgs;
  const keep = msgs.slice(-tail);
  const old = msgs.slice(0, -tail);
  const lines = [];
  for (const m of old) {
    if (m.role === "user") lines.push(`USER: ${m.content.slice(0, 300)}`);
    else if (m.role === "assistant") {
      const names = (m.tool_calls ?? []).map((c) => c.function.name);
      if (names.length) lines.push(`ASSISTANT[tools: ${names.join(", ")}]`);
      if (m.content) lines.push(`ASSISTANT: ${m.content.slice(0, 200)}`);
    }
    // tool 角色不进摘要——它的信息已折在对应的 assistant 行里
  }
  return [{ role: "user", content: "[早期对话摘要]\n" + lines.join("\n") }, ...keep];
}

const long = buildLongTranscript(30); // 30 轮 → 91 条消息
const full = long;
const dig = digestHistory(long);
console.log("━━━ 账二：谁来蒸馏 —— 同模型全量重放 vs 换便宜模型 digest 重放 ━━━");
console.log(`  完整对话：${full.length} 条 · ${tok(ser(full))} tok`);
console.log(`  同模型（默认，routed=false）：全量重放 ${tok(ser(full))} tok —— 但全在热缓存里，≈按 0.1 折的 cache 读`);
console.log(`  换便宜模型（routed=true）：缓存凉了，改 digest —— 尾 ${TAIL} 条原文 + 更早 ${full.length - TAIL} 条塌成摘要`);
console.log(`    digest 冷写：${tok(ser(dig))} tok（vs 全量冷写 ${tok(ser(full))} tok，省 ${(100 - tok(ser(dig)) / tok(ser(full)) * 100).toFixed(0)}%）`);
console.log("  → 关键：默认根本不换模型。省钱的前提是缓存热，换模型丢了热缓存，digest 只是把丢掉的冷写压小。\n");

// ─── 账三：不污染 —— fork 共享 session_id，靠隔离防止写回主对话 ───────────
// fork 为了吃热缓存，共享父的 session_id。代价：若不禁持久化，fork 会把
// 「复盘上面的对话」这句 harness 指令 + 自己的回复写进用户真实 session。
// 下一轮主 agent 读到这条 user 消息，把它当成站着的指令 → 直接「变身」成复盘器，
// 拒绝干用户真正要的活（hermes-agent 真实事故 #38727）。
const REVIEW_PROMPT = { role: "user", content: "复盘上面的对话，把跨会话仍成立的学习写进记忆/技能。" };
const REVIEW_REPLY = { role: "assistant", content: "已保存：用户偏好中文回复。" };

function parentSession() {
  return [
    { role: "system", content: "sys" },
    { role: "user", content: "帮我修复登录 bug" }, // 用户真正的活
    { role: "assistant", content: "好的，我看下 auth.ts。" },
  ];
}
const lastUserAsk = (msgs) => [...msgs].reverse().find((m) => m.role === "user")?.content;

const poisoned = parentSession();
poisoned.push(REVIEW_PROMPT, REVIEW_REPLY); // fork 未隔离 → 写回共享 session
const clean = parentSession(); // fork 持久化隔离（_persist_disabled）→ 主 session 不动

console.log("━━━ 账三：fork 共享 session —— 未隔离（中毒） vs 持久化隔离（干净） ━━━");
console.log(`  未隔离：主 session ${poisoned.length} 条，下一轮 agent 以为用户最后说的是：`);
console.log(`          “${lastUserAsk(poisoned)}” ❌ 于是变身复盘器，丢下登录 bug`);
console.log(`  隔离后：主 session ${clean.length} 条，下一轮 agent 看到的仍是：`);
console.log(`          “${lastUserAsk(clean)}” ✅ 复盘只写记忆/技能文件，一个字都不进主对话`);
console.log("  → 隔离不是可选优化，是共享 session_id 换热缓存后的必付账单：_persist_disabled + 独立 messages。");
