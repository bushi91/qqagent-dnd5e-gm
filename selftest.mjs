// 自检：不需要 QQ、不需要跑到 Agent 里，直接 node selftest.mjs 就能验证
// 骰子解析、存档、工具注册与一次完整流程（开团 → 建卡 → 检定 → 受伤 → 开战 → 轮转）。
import { rollExpr, formatRoll, abilityMod } from './skills/dnd5e-gm/lib/dice.js';
import * as skill from './skills/dnd5e-gm/index.js';
import { remove as removeSave } from './skills/dnd5e-gm/lib/store.js';

const fail = [];
function ok(cond, label) {
  if (!cond) fail.push(label);
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`);
}

// ── 骰子 ────────────────────────────────────────────────
console.log('— dice —');
let r = rollExpr('3d6+2');
ok(!r.error && r.kept.length === 3 && r.total >= 5 && r.total <= 20, `3d6+2 => ${formatRoll(r, '3d6+2')}`);
r = rollExpr('1d20', 'adv');
ok(!r.error && r.kept.length === 1 && r.kept[0] >= r.dropped[0], `优势取高 => ${formatRoll(r, '1d20')}`);
r = rollExpr('2d8-1');
ok(!r.error && r.total >= 1, `2d8-1 => ${formatRoll(r, '2d8-1')}`);
ok(rollExpr('d20').error === undefined, '省略数量默认 1 颗');
ok(rollExpr('5x').error !== undefined, '非法表达式报错');
ok(rollExpr('0d6').error !== undefined, '0 颗骰子报错');
ok(rollExpr('1d1').error !== undefined, 'd1 报错');
ok(rollExpr('1d20+5').total >= 6, '加值生效');
ok(abilityMod(16) === 3 && abilityMod(8) === -1, '属性调整值');

// ── 工具注册与流程 ──────────────────────────────────────
console.log('— tools —');
const tools = new Map();
const sent = [];
const api = {
  config: { enabled: true, publicRolls: true, maxLog: 200 },
  registerTool(t) {
    tools.set(t.id, t);
  }
};
skill.setup(api);

ok(tools.size === 10, `注册了 ${tools.size} 个工具`);
for (const id of ['dnd_new', 'dnd_state', 'dnd_sheet', 'dnd_roll', 'dnd_check', 'dnd_damage', 'dnd_heal', 'dnd_combat', 'dnd_scene', 'dnd_log']) {
  ok(tools.has(id), `有 ${id}`);
}

const ctx = {
  chatKey: 'group:selftest-not-a-real-group',
  userId: '10001',
  sender: { sendTextBatch: async (_k, texts) => sent.push(...texts) }
};
const call = async (id, args) => {
  const res = await tools.get(id).execute(ctx, args ?? {});
  return res;
};

console.log('— flow —');
removeSave(ctx.chatKey); // 每次自检都从干净存档开始
let res = await call('dnd_state');
ok(res.isError === true, '未开团时查状态给出引导');

res = await call('dnd_new', { title: '自检团', level: 3 });
ok(!res.isError, `开团 => ${String(res.content).slice(0, 40)}`);

res = await call('dnd_new', { title: '重复团' });
ok(res.isError === true, '重复开团被拒绝');

res = await call('dnd_sheet', { action: 'set', userId: '10001', name: '老陈', cls: 'fighter', level: 3, maxHp: 28, ac: 16, abilities: 'str:16,dex:14,con:14,int:8,wis:10,cha:10', prof: 'athletics' });
ok(!res.isError && res.content.includes('老陈'), `建卡 => ${String(res.content).slice(0, 60)}`);

res = await call('dnd_sheet', { action: 'set', userId: '10002', name: '小鱼', cls: 'wizard', maxHp: 18, ac: 12, abilities: 'str:8,dex:14,con:12,int:16,wis:12,cha:10' });
ok(!res.isError && res.content.includes('小鱼'), '第二张卡');

res = await call('dnd_check', { actor: '老陈', ability: 'str', dc: 12, reason: '推门', bonus: 2 });
ok(!res.isError && /成功|失败/.test(res.content) && /DC 12/.test(sent[sent.length - 1] || ''), `检定 => ${sent[sent.length - 1]}`);

const sentBefore = sent.length;
res = await call('dnd_roll', { expr: '2d6+3', reason: '火球伤害' });
ok(!res.isError && sent.length === sentBefore + 1, `公开骰发群 => ${sent[sent.length - 1]}`);

res = await call('dnd_roll', { expr: '1d20', secret: true });
ok(!res.isError && /暗骰/.test(res.content), '暗骰不发群');

res = await call('dnd_damage', { target: '老陈', amount: 10, type: 'slashing' });
ok(!res.isError && res.content.includes('剩 HP 18/28'), `受伤 => ${String(res.content).slice(0, 60)}`);

res = await call('dnd_heal', { target: '老陈', amount: 4 });
ok(!res.isError && res.content.includes('22/28'), '治疗');

res = await call('dnd_combat', { action: 'start', foes: '哥布林A:12:7,哥布林B:9:7' });
ok(!res.isError && res.content.includes('先攻'), `开战 => ${String(res.content).slice(0, 60)}`);

res = await call('dnd_combat', { action: 'next' });
ok(!res.isError && /轮到/.test(res.content), `轮转 => ${String(res.content).slice(0, 40)}`);

res = await call('dnd_damage', { target: '哥布林A', amount: 99 });
ok(!res.isError && res.content.includes('被击倒'), '敌人被击倒');

res = await call('dnd_combat', { action: 'status' });
ok(res.content.includes('哥布林A'), '战斗状态可见');

res = await call('dnd_scene', { name: '雾港酒馆', summary: '老陈推开了门，酒馆里没人说话。', act: 2 });
ok(!res.isError && res.content.includes('雾港酒馆'), '场景摘要');

res = await call('dnd_log', { tail: 5 });
ok(!res.isError && res.content.split('\n').length > 0, '判定日志');

res = await call('dnd_combat', { action: 'end' });
ok(!res.isError, '结束战斗');

// ── 动态提示词 ──────────────────────────────────────────
console.log('— prompt —');
const sections = skill.promptSections(ctx);
ok(sections.length === 1 && sections[0].content.includes('自检团'), '跑团存档进入提示词');
ok(skill.promptSections({ chatKey: 'group:empty' }).length === 0, '没存档的会话不注入');

// 清理测试存档（removeSave 已是静态导入，不依赖 process.exit 前的异步导入）
removeSave(ctx.chatKey);

console.log(fail.length ? `\n❌ ${fail.length} 项失败：\n - ${fail.join('\n - ')}` : '\n✅ 全部通过');
process.exit(fail.length ? 1 : 0);
