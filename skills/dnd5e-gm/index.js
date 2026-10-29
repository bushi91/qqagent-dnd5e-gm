import { abilityMod, profBonus, rollExpr, formatRoll } from './lib/dice.js';
import { lookup, normalizeKind } from './lib/srd.js';
import { load, save, update, remove, pushLog } from './lib/store.js';

// ─────────────────────────────────────────────────────────────
// dnd5e-gm：让机器人在群里当 D&D 5e 的 DM
//
// 设计边界（很重要）：
//   · 所有随机量（骰子、检定、伤害、先攻）都由这里算，模型只负责叙述。
//     模型自己报数字 = 跑团最常见的事故来源，所以提示词里明令禁止。
//   · 状态全部落在 <项目根>/data/dnd/<chatKey>.json，重启不丢团。
//   · 公开骰用 ctx.sender 发到群里（玩家看得见，才有跑团的信任感）；
//     暗骰不发群，只回给模型。
// ─────────────────────────────────────────────────────────────

let cfg = () => ({});

const ABIL_CN = { str: '力量', dex: '敏捷', con: '体质', int: '智力', wis: '感知', cha: '魅力' };
const ABIL_KEYS = Object.keys(ABIL_CN);

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(num(v, fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** 从存档里取角色（按昵称/角色名/QQ 号都能找）。 */
function findPc(camp, ref) {
  const s = String(ref ?? '').trim();
  if (!s) return null;
  return (camp.party || []).find((m) => m.userId === s || m.name === s || m.nick === s) || null;
}

/** 从当前战斗里取敌人（按名字）。 */
function findFoe(camp, ref) {
  const s = String(ref ?? '').trim();
  if (!s) return null;
  return (camp.combat?.order || []).find((e) => e.kind === 'foe' && e.name === s) || null;
}

/** 找到可以被伤害/治疗的目标：先找 PC，再找战场上的敌人。 */
function findTarget(camp, ref) {
  const pc = findPc(camp, ref);
  if (pc) return { kind: 'pc', ref: pc, name: pc.name, hp: pc.hp, maxHp: pc.maxHp, ac: pc.ac };
  const foe = findFoe(camp, ref);
  if (foe) return { kind: 'foe', ref: foe, name: foe.name, hp: foe.hp, maxHp: foe.maxHp, ac: foe.ac };
  const name = String(ref ?? '').trim();
  if (name && camp.combat?.active) {
    const entry = autoFoe(camp, name);
    if (entry) return { kind: 'foe', ref: entry, name, hp: entry.hp, maxHp: entry.maxHp, ac: entry.ac };
  }
  return null;
}

// ── v1.1 助手：地形网格 / 行动经济 ───────────────────────────────

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function ensureGrid(camp) {
  if (!camp.map) {
    const w = 12;
    const h = 9;
    const cols = Array.from({ length: w }, () => Array.from({ length: h }, () => '.'));
    let seed = hashStr(camp.chatKey + (camp.title || ''));
    const pick = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const pillars = 2 + (pick() % 3);
    for (let i = 0; i < pillars; i++) {
      const x = 2 + (pick() % (w - 4));
      const y = 1 + (pick() % (h - 2));
      cols[x][y] = '#';
    }
    camp.map = { w, h, cols };
  }
  return camp.map;
}

function gridCell(grid, x, y) {
  const col = grid.cols[x];
  return col ? col[y] || '#' : '#';
}

function dist(a, b) {
  if (!a || !b) return null;
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function syncOrder(camp) {
  const order = camp.combat?.order || [];
  for (const e of order) {
    if (e.kind === 'pc') {
      const pc = findPc(camp, e.name);
      if (pc) {
        e.hp = pc.hp;
        e.maxHp = pc.maxHp;
        e.ac = pc.ac;
        e.conditions = pc.conditions || [];
      }
    } else {
      const foe = findFoe(camp, e.name);
      if (foe) {
        e.hp = foe.hp;
        e.maxHp = foe.maxHp;
        e.ac = foe.ac;
      }
    }
  }
}

function findOrderEntry(camp, name) {
  const n = String(name ?? '').trim();
  if (!n) return null;
  return (camp.combat?.order || []).find((e) => e.name === n) || null;
}

function autoFoe(camp, name) {
  const n = String(name ?? '').trim().slice(0, 20);
  if (!n) return null;
  if (!Array.isArray(camp.enemies)) camp.enemies = [];
  let foe = findFoe(camp, n);
  if (!foe) {
    foe = { name: n, hp: 13, maxHp: 13, ac: 13 };
    camp.enemies.push(foe);
  }
  if (camp.combat?.active && !findOrderEntry(camp, n)) {
    camp.combat.order.push({ key: `foe:${n}`, name: n, kind: 'foe', init: 5, hp: foe.hp, maxHp: foe.maxHp, ac: foe.ac });
    camp.combat.order.sort((a, b) => b.init - a.init);
    ensureGrid(camp);
    placeTokens(camp, camp.combat.order);
  }
  return foe;
}

function placeTokens(camp, order) {
  if (!camp.map) ensureGrid(camp);
  const g = camp.map;
  camp.combat.tokens = camp.combat.tokens || {};
  const used = new Set(Object.values(camp.combat.tokens).map((t) => `${t.x},${t.y}`));
  const free = (x, y) => x >= 0 && x < g.w && y >= 0 && y < g.h && gridCell(g, x, y) !== '#' && !used.has(`${x},${y}`);
  let pcs = 0;
  let foes = 0;
  for (const e of order) {
    if (camp.combat.tokens[e.key]) {
      used.add(`${camp.combat.tokens[e.key].x},${camp.combat.tokens[e.key].y}`);
      continue;
    }
    let spot = null;
    const isPc = e.kind === 'pc';
    const x0 = isPc ? 2 + (pcs % 4) : 8 - (foes % 3);
    const y0 = isPc ? 6 + (pcs % 2) : 2 + (foes % 3);
    for (let d = 0; d < 6 && !spot; d++) {
      for (let dx = -d; dx <= d && !spot; dx++) {
        for (let dy = -d; dy <= d && !spot; dy++) {
          const x = x0 + dx;
          const y = y0 + dy;
          if (free(x, y)) spot = { x, y };
        }
      }
    }
    if (!spot) spot = { x: x0, y: y0 };
    camp.combat.tokens[e.key] = { x: spot.x, y: spot.y };
    used.add(`${spot.x},${spot.y}`);
    if (isPc) pcs++;
    else foes++;
  }
}

function tokenOf(camp, key) {
  return camp.combat?.tokens?.[key] || null;
}

function locationOf(camp, name) {
  const e = findOrderEntry(camp, name);
  return e ? tokenOf(camp, e.key) : null;
}

function renderGrid(camp, highlightKey) {
  const g = ensureGrid(camp);
  const order = camp.combat?.order || [];
  const tokens = camp.combat?.tokens || {};
  const byCell = {};
  for (const e of order) {
    const t = tokens[e.key];
    if (t) byCell[`${t.x},${t.y}`] = e.name;
  }
  const lines = [];
  for (let y = 0; y < g.h; y++) {
    let line = '';
    for (let x = 0; x < g.w; x++) {
      const cell = gridCell(g, x, y);
      const who = byCell[`${x},${y}`];
      if (who) {
        const e = order.find((i) => i.name === who);
        line += e?.key === highlightKey ? '@' : String(who).slice(0, 1);
      } else {
        line += cell;
      }
    }
    lines.push(line);
  }
  const legend = order
    .map((e) => `${String(e.name).slice(0, 1)}=${e.name}${e.hp != null ? `(${e.hp}/${e.maxHp})` : ''}`)
    .join(' ');
  return `地图 ${g.w}x${g.h}（每格 5 尺，斜向算 1 格）：\n${lines.join('\n')}\n${legend}\n@=当前回合者`;
}

function currentEntry(camp) {
  const c = camp.combat;
  if (!c?.active || !c.order?.length) return null;
  return c.order[c.index % c.order.length];
}

function turnOf(camp, entry) {
  const round = camp.combat?.round ?? 1;
  if (!entry.turn || entry.turn.round !== round) {
    entry.turn = { round, action: true, bonus: true, reaction: true, move: 6 };
  }
  return entry.turn;
}

function costText(turn) {
  if (!turn) return '资源未知';
  return `动作${turn.action ? '可用' : '已用'} / 附赠${turn.bonus ? '可用' : '已用'} / 反应${turn.reaction ? '可用' : '已用'} / 移动剩 ${turn.move} 格`;
}

function mustCampaign(chatKey) {
  const camp = load(chatKey);
  if (!camp) {
    return {
      error:
        '这个会话还没有跑团存档。玩家是在开新团就先调用 dnd_new（需要标题和队伍等级）；只是普通聊天就什么都别做。'
    };
  }
  return { camp };
}

function partyLines(camp) {
  if (!camp.party?.length) return '（还没有角色卡：玩家要先建卡，或从预制卡里选）';
  return camp.party
    .map((m) => {
      const tags = [];
      if (m.hp <= 0) tags.push('倒地');
      if (m.conditions?.length) tags.push(m.conditions.join('/'));
      const extra = tags.length ? ` [${tags.join(' ')}]` : '';
      return `${m.name}（${m.cls || '冒险者'} ${m.level || 1} 级，HP ${m.hp}/${m.maxHp}，AC ${m.ac ?? 10}）${extra}`;
    })
    .join('；');
}

function combatLines(camp) {
  const c = camp.combat || {};
  if (!c.active) return '当前没有战斗';
  const order = (c.order || []).map((e, i) => {
    const mark = i === c.index ? '▶' : '·';
    return `${mark}${e.name}（先攻 ${e.init}，HP ${e.hp}/${e.maxHp}）`;
  });
  const cur = c.order?.[c.index];
  return `战斗第 ${c.round || 1} 轮，${order.join(' ')}${cur ? `；轮到 ${cur.name}` : ''}`;
}

function summary(camp) {
  const scene = camp.scene || {};
  const bits = [
    `《${camp.title}》第 ${camp.act || 1} 幕`,
    camp.objective ? `目标：${camp.objective}` : '',
    scene.name ? `场景：${scene.name}` : '',
    scene.summary ? `回顾：${scene.summary}` : '',
    partyLines(camp),
    combatLines(camp)
  ].filter(Boolean);
  return bits.join('\n').slice(0, 900);
}

/** 公开骰发到群里；失败也不影响工具返回，模型仍能看到结果。 */
async function announce(ctx, text) {
  try {
    if (ctx?.sender?.sendTextBatch) {
      await ctx.sender.sendTextBatch(ctx.chatKey, [text]);
      return true;
    }
  } catch {
    /* 发送失败就只回给模型 */
  }
  return false;
}

function parseAbilities(text) {
  const out = {};
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  if (raw.includes(':')) {
    for (const part of raw.split(/[,，;；\s]+/)) {
      const [k, v] = part.split(':');
      const key = String(k || '').trim().toLowerCase();
      const short = key.slice(0, 3);
      if (ABIL_KEYS.includes(short)) out[short] = clampInt(v, 1, 30, 10);
    }
  } else {
    const nums = raw.split(/[,，;；\s]+/).map((x) => clampInt(x, 1, 30, 10));
    ABIL_KEYS.forEach((k, i) => {
      out[k] = nums[i] ?? 10;
    });
  }
  return Object.keys(out).length ? out : null;
}

function rollInitiative(member) {
  const dex = abilityMod(member.abilities?.dex ?? 10);
  const r = rollExpr('1d20');
  return (r.total ?? 10) + dex;
}

/** 解析 "哥布林A:12:7,哥布林B:9" → 敌人条目（名:先攻[:HP[:AC]]）。 */
function parseFoes(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  return raw
    .split(/[,，;；]+/)
    .map((part) => {
      const [name, init, hp, ac] = part.split(':').map((x) => String(x || '').trim());
      if (!name) return null;
      return {
        key: `foe:${name}`,
        name,
        kind: 'foe',
        init: clampInt(init, -10, 60, 10),
        hp: clampInt(hp, 1, 2000, 7),
        maxHp: clampInt(hp, 1, 2000, 7),
        ac: clampInt(ac, 1, 40, 12)
      };
    })
    .filter(Boolean);
}

export function setup(api) {
  cfg = api.config;

  // ── 开团 / 读档 ────────────────────────────────────────────
  api.registerTool({
    id: 'dnd_new',
    name: '开团',
    description:
      '为当前会话新建一场 D&D 5e 跑团（存档到 data/dnd）。当玩家说"开个团/跑团/当 DM/来一场 D&D"并且已经确认人数与等级时使用。已有存档时会报错并提示先结束旧团。',
    category: 'utility',
    icon: '🐉',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '团的标题，如"盐沼下的钟"' },
        level: { type: 'integer', description: '队伍等级 1~20，默认 3' },
        mode: { type: 'string', description: 'oneshot（一次性短团）或 campaign（长期战役），默认 oneshot' }
      },
      required: ['title']
    },
    async execute(ctx, args) {
      try {
        const chatKey = ctx.chatKey;
        const old = load(chatKey);
        if (old) return { content: `这个群已经有一个团《${old.title}》了。要重开请先调 dnd_combat end 收尾，再确认玩家确实要换团。`, isError: true };

        const title = String(args?.title || '').trim().slice(0, 40);
        if (!title) return { content: '缺少团的标题', isError: true };

        const level = clampInt(args?.level, 1, 20, 3);
        const mode = ['oneshot', 'campaign'].includes(args?.mode) ? args.mode : 'oneshot';
        const camp = {
          version: 1,
          chatKey,
          title,
          mode,
          act: 1,
          scene: { name: '序幕', summary: '' },
          party: [],
          combat: { active: false, round: 1, index: 0, order: [] },
          log: [],
          createdAt: new Date().toISOString()
        };
        save(chatKey, camp);
        return {
          content: `已开团《${title}》（${mode === 'oneshot' ? '一次性短团' : '长期战役'}，${level} 级）。现在：1) 让玩家建角色卡（dnd_sheet set，或给 4 张预制卡选）；2) 用 dnd_scene 设定开场场景。开团前先问清风格与禁用内容。`
        };
      } catch (error) {
        return { content: `开团失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'dnd_state',
    name: '看团况',
    description:
      '读取当前会话的跑团存档：标题、幕数、场景、队伍角色卡、战斗回合。玩家问"现在什么情况/该谁了/我们剩多少血"或你需要恢复上下文时使用。',
    category: 'query',
    icon: '📜',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        const { camp, error } = mustCampaign(ctx.chatKey);
        if (error) return { content: error, isError: true };
        return { content: summary(camp) };
      } catch (error) {
        return { content: `读取失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 角色卡 ────────────────────────────────────────────────
  api.registerTool({
    id: 'dnd_sheet',
    name: '角色卡',
    description:
      '管理跑团角色卡：get 查看，set 新建或修改（HP/AC/等级/属性），rest 长休回满。玩家建卡、升级、改血、休息时使用。',
    category: 'utility',
    icon: '🧙',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'get / set / rest，默认 get' },
        userId: { type: 'string', description: '玩家 QQ 号（建卡时用来绑定）' },
        name: { type: 'string', description: '角色名，如"老陈"' },
        cls: { type: 'string', description: '职业，如 fighter / wizard / rogue / cleric' },
        level: { type: 'integer', description: '等级 1~20' },
        maxHp: { type: 'integer', description: '最大生命值' },
        ac: { type: 'integer', description: '护甲等级' },
        abilities: { type: 'string', description: '六项属性，如 "str:16,dex:14,con:13,int:8,wis:10,cha:12"' },
        prof: { type: 'string', description: '熟练技能，逗号分隔，如 "athletics,intimidation"' }
      }
    },
    async execute(ctx, args) {
      try {
        const { camp, error } = mustCampaign(ctx.chatKey);
        if (error) return { content: error, isError: true };
        const action = String(args?.action || 'get').toLowerCase();

        if (action === 'get') {
          return { content: partyLines(camp) };
        }

        if (action === 'rest') {
          for (const m of camp.party || []) {
            m.hp = m.maxHp;
            m.conditions = [];
          }
          save(camp.chatKey, camp);
          return { content: `长休完成：${partyLines(camp)}` };
        }

        const name = String(args?.name || '').trim().slice(0, 20);
        const userId = String(args?.userId || '').trim();
        const existing = findPc(camp, userId || name);
        const level = clampInt(args?.level, 1, 20, existing?.level ?? 1);
        const maxHp = clampInt(args?.maxHp, 1, 999, existing?.maxHp ?? Math.max(6, 8 + abilityMod(12) * 0 + level * 6));
        const ac = clampInt(args?.ac, 1, 30, existing?.ac ?? 12);
        const abilities = parseAbilities(args?.abilities) || existing?.abilities || { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
        const prof = String(args?.prof || '').trim()
          ? String(args.prof).split(/[,，;；\s]+/).filter(Boolean)
          : existing?.prof || [];

        if (!name && !userId) return { content: '建卡至少要有 name 或 userId', isError: true };

        if (existing) {
          Object.assign(existing, { level, maxHp, ac, abilities, prof });
          if (existing.hp === undefined || existing.hp > maxHp) existing.hp = maxHp;
          if (args?.cls) existing.cls = String(args.cls).slice(0, 20);
        } else {
          camp.party = camp.party || [];
          camp.party.push({
            userId: userId || `local:${name}`,
            name: name || userId,
            nick: name || userId,
            cls: String(args?.cls || 'adventurer').slice(0, 20),
            level,
            maxHp,
            hp: maxHp,
            ac,
            abilities,
            prof,
            conditions: []
          });
        }
        save(camp.chatKey, camp);
        return { content: `角色卡已更新：${partyLines(camp)}` };
      } catch (error) {
        return { content: `角色卡操作失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 掷骰 / 检定 ───────────────────────────────────────────
  api.registerTool({
    id: 'dnd_roll',
    name: '掷骰',
    description:
      '按 NdM±K 掷骰（如 3d6+2、1d20+5），支持优势/劣势与暗骰。任何需要随机数的场合都必须用这个工具，禁止自己编数字。公开骰会自动发到群里。',
    category: 'utility',
    icon: '🎲',
    parameters: {
      type: 'object',
      properties: {
        expr: { type: 'string', description: '骰子表达式，如 "1d20+3"、"2d6+4"' },
        advantage: { type: 'string', description: 'normal / adv（优势）/ dis（劣势），只对单个 d20 生效' },
        secret: { type: 'boolean', description: 'true = 暗骰，结果不公开，只回给你' },
        reason: { type: 'string', description: '这次掷骰的原因，如"力量检定"' }
      },
      required: ['expr']
    },
    async execute(ctx, args) {
      try {
        const expr = String(args?.expr || '').trim();
        if (!expr) return { content: '缺少骰子表达式', isError: true };
        const r = rollExpr(expr, args?.advantage);
        if (r.error) return { content: r.error, isError: true };

        const reason = String(args?.reason || '').trim();
        const who = String(args?.who || '').trim();
        const line = formatRoll(r, expr);
        const label = [who, reason].filter(Boolean).join(' ');
        const text = label ? `${label}：${line}` : line;
        const isSecret = args?.secret === true;

        const { camp } = mustCampaign(ctx.chatKey);
        if (camp) {
          pushLog(camp, { kind: 'roll', public: !isSecret, text });
          save(camp.chatKey, camp);
        }

        if (isSecret) return { content: `暗骰结果（不要念出数字，只叙述结果）：${text}` };

        const sent = await announce(ctx, `🎲 ${text}`);
        return {
          content: sent ? `已把骰子结果发到群里：${text}。不要复述数字，直接叙述结果。` : `骰子结果：${text}（发送到群里失败，请用 send_message 播报）`
        };
      } catch (error) {
        return { content: `掷骰失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'dnd_check',
    name: '检定',
    description:
      '做一次 d20 检定/豁免：自动加属性调整值（可再加 bonus），对比 DC 给出成功等级。玩家"我要...""我想试试..."需要判定时使用。',
    category: 'utility',
    icon: '⚔️',
    parameters: {
      type: 'object',
      properties: {
        actor: { type: 'string', description: '谁在检定（角色名）' },
        ability: { type: 'string', description: 'str/dex/con/int/wis/cha，默认 str' },
        dc: { type: 'integer', description: '难度值 DC，默认 15' },
        bonus: { type: 'integer', description: '额外加值（熟练/专长），默认 0' },
        advantage: { type: 'string', description: 'normal / adv / dis' },
        secret: { type: 'boolean', description: 'true = 暗骰（对抗感知、NPC 隐匿等）' },
        reason: { type: 'string', description: '检定原因，如"推开石门"' }
      },
      required: ['actor']
    },
    async execute(ctx, args) {
      try {
        const { camp, error } = mustCampaign(ctx.chatKey);
        if (error) return { content: error, isError: true };

        const actorName = String(args?.actor || '').trim();
        if (!actorName) return { content: '缺少 actor', isError: true };

        const pc = findPc(camp, actorName);
        const abil = ABIL_KEYS.includes(String(args?.ability || '').toLowerCase())
          ? String(args.ability).toLowerCase()
          : 'str';
        const abilityScore = pc?.abilities?.[abil] ?? 10;
        const bonus = clampInt(args?.bonus, -20, 30, 0);
        const totalBonus = abilityMod(abilityScore) + bonus;
        const dc = clampInt(args?.dc, 1, 40, 15);
        const reason = String(args?.reason || '').trim();
        const isSecret = args?.secret === true;

        const r = rollExpr('1d20', args?.advantage);
        if (r.error) return { content: r.error, isError: true };
        const nat = r.kept?.[0] ?? 0;
        const total = r.total + totalBonus;
        let outcome = total >= dc ? '成功' : '失败';
        if (nat === 20) outcome = '大成功（自然 20）';
        else if (nat === 1) outcome = '大失败（自然 1）';

        const diceText = formatRoll(r, '1d20').replace(`= ${r.total}`, '').trim();
        const modText = totalBonus ? (totalBonus > 0 ? `+${totalBonus}` : `${totalBonus}`) : '±0';
        const text = `${actorName} ${ABIL_CN[abil]}检定${reason ? `（${reason}）` : ''}：${diceText} ${modText} = ${total} vs DC ${dc} → ${outcome}`;

        pushLog(camp, { kind: 'check', public: !isSecret, text });
        save(camp.chatKey, camp);

        if (isSecret) return { content: `暗骰结果（不要念数字，只叙述结果）：${text}` };
        const sent = await announce(ctx, `🎲 ${text}`);
        return {
          content: sent
            ? `检定结果已发群：${outcome}。不要复述数字，直接叙述发生了什么。`
            : `检定结果：${text}（发群失败，请用 send_message 播报）`
        };
      } catch (error) {
        return { content: `检定失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 伤害 / 治疗 ───────────────────────────────────────────
  api.registerTool({
    id: 'dnd_damage',
    name: '造成伤害',
    description: '对角色或战场上的敌人扣血（会处理倒地与死亡）。攻击命中、陷阱、法术命中后使用。伤害数字应由 dnd_roll 掷出。',
    category: 'utility',
    icon: '💥',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标名（角色名或敌人名）' },
        amount: { type: 'integer', description: '伤害值' },
        type: { type: 'string', description: '伤害类型，如 slashing/fire/poison，可选' },
        crit: { type: 'boolean', description: '是否暴击（仅用于日志标记）' }
      },
      required: ['target', 'amount']
    },
    async execute(ctx, args) {
      try {
        const { camp, error } = mustCampaign(ctx.chatKey);
        if (error) return { content: error, isError: true };

        const target = findTarget(camp, args?.target);
        if (!target) return { content: `找不到目标「${args?.target}」，先确认它是否在队伍或当前战斗里`, isError: true };

        const amount = clampInt(args?.amount, 0, 9999, 0);
        if (amount <= 0) return { content: '伤害值必须大于 0', isError: true };

        target.ref.hp = Math.max(0, target.ref.hp - amount);
        let note = '';
        if (target.ref.hp === 0) {
          target.ref.conditions = target.ref.conditions || [];
          if (!target.ref.conditions.includes('倒地')) target.ref.conditions.push('倒地');
          note = target.kind === 'pc' ? '（倒地，需要急救/稳定）' : '（被击倒）';
        }

        const typeText = args?.type ? ` ${args.type}` : '';
        const critText = args?.crit === true ? '（暴击）' : '';
        const text = `${target.name} 受到 ${amount} 点${typeText}伤害${critText}，剩 HP ${target.ref.hp}/${target.ref.maxHp}${note}`;

        syncOrder(camp);
        pushLog(camp, { kind: 'damage', public: true, text });
        save(camp.chatKey, camp);
        const sent = await announce(ctx, `💥 ${text}`);
        return { content: sent ? `已播报：${text}。不要复述数字，直接叙述。` : text };
      } catch (error) {
        return { content: `伤害结算失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'dnd_heal',
    name: '治疗',
    description: '给角色或敌人回血（不超过上限），用于治疗术、药水、长休以外的恢复。',
    category: 'utility',
    icon: '💚',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标名' },
        amount: { type: 'integer', description: '恢复量' }
      },
      required: ['target', 'amount']
    },
    async execute(ctx, args) {
      try {
        const { camp, error } = mustCampaign(ctx.chatKey);
        if (error) return { content: error, isError: true };
        const target = findTarget(camp, args?.target);
        if (!target) return { content: `找不到目标「${args?.target}」`, isError: true };
        const amount = clampInt(args?.amount, 1, 9999, 1);

        target.ref.hp = Math.min(target.ref.maxHp, target.ref.hp + amount);
        if (target.ref.hp > 0) target.ref.conditions = (target.ref.conditions || []).filter((c) => c !== '倒地');

        const text = `${target.name} 恢复 ${amount} 点生命，现在 HP ${target.ref.hp}/${target.ref.maxHp}`;
        pushLog(camp, { kind: 'heal', public: true, text });
        save(camp.chatKey, camp);
        const sent = await announce(ctx, `💚 ${text}`);
        return { content: sent ? `已播报：${text}。` : text };
      } catch (error) {
        return { content: `治疗结算失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 战斗 ─────────────────────────────────────────────────
  api.registerTool({
    id: 'dnd_combat',
    name: '战斗轮次',
    description:
      '管理战斗：start 掷先攻开战（敌人用 foes 传入，格式"哥布林A:12:7"=名:先攻:HP），next 交给下一位，status 看当前顺序，end 结束战斗。战斗开始后只有当前行动者能行动。',
    category: 'utility',
    icon: '🛡️',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'start / next / status / end' },
        foes: { type: 'string', description: '敌人列表，如 "哥布林A:12:7,哥布林B:9:7"（名:先攻:HP[:AC]）' },
        round: { type: 'integer', description: '可选：起始轮次' }
      },
      required: ['action']
    },
    async execute(ctx, args) {
      try {
        const { camp, error } = mustCampaign(ctx.chatKey);
        if (error) return { content: error, isError: true };
        const action = String(args?.action || '').toLowerCase();
        camp.combat = camp.combat || { active: false, round: 1, index: 0, order: [] };

        if (action === 'status') return { content: combatLines(camp) };

        if (action === 'end') {
          camp.combat = { active: false, round: 1, index: 0, order: [] };
          save(camp.chatKey, camp);
          return { content: '战斗已结束。记得给经验/战利品，并推进剧情。' };
        }

        if (action === 'start') {
          const foes = parseFoes(args?.foes);
          const order = [];
          for (const m of camp.party || []) {
            order.push({ key: `pc:${m.userId}`, name: m.name, kind: 'pc', init: rollInitiative(m), hp: m.hp, maxHp: m.maxHp, ac: m.ac });
          }
          order.push(...foes);
          ensureGrid(camp);
          placeTokens(camp, order);
          if (order.length === 0) return { content: '场上没有任何人，无法开始战斗', isError: true };
          order.sort((a, b) => b.init - a.init);
          camp.combat = { active: true, round: Math.max(1, clampInt(args?.round, 1, 99, 1)), index: 0, order };
          save(camp.chatKey, camp);
          const first = order[0];
          const text = `⚔️ 战斗开始！先攻顺序：${order.map((e) => `${e.name}(${e.init})`).join(' → ')}。轮到 ${first.name}。`;
          const sent = await announce(ctx, text);
          return { content: sent ? `已开战并播报先攻。现在是 ${first.name} 的回合，只处理他的行动。` : `${text}（发群失败，请播报）` };
        }

        if (action === 'next') {
          if (!camp.combat.active) return { content: '当前没有进行中的战斗，先 start', isError: true };
          const order = camp.combat.order || [];
          if (!order.length) return { content: '先攻列表是空的，重新 start', isError: true };

          const alive = order.filter((e) => e.hp > 0);
          if (alive.length === 0) {
            camp.combat = { active: false, round: 1, index: 0, order: [] };
            save(camp.chatKey, camp);
            return { content: '全员倒下，战斗结束。' };
          }

          let idx = camp.combat.index;
          for (let step = 0; step < order.length * 2; step += 1) {
            idx = (idx + 1) % order.length;
            if (idx === 0) camp.combat.round = (camp.combat.round || 1) + 1;
            if (order[idx].hp > 0) break;
          }
          camp.combat.index = idx;
          save(camp.chatKey, camp);
          const cur = order[idx];
          const text = `🛡️ 第 ${camp.combat.round} 轮，轮到 ${cur.name}（HP ${cur.hp}/${cur.maxHp}）`;
          const sent = await announce(ctx, text);
          return { content: sent ? `${text}。只处理他的行动，其他人说话不算行动。` : text };
        }

        return { content: `不认识的 action：${action}（可用 start/next/status/end）`, isError: true };
      } catch (error) {
        return { content: `战斗操作失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 场景 ─────────────────────────────────────────────────
  api.registerTool({
    id: 'dnd_scene',
    name: '场景与摘要',
    description:
      '切换场景或写下这一幕的剧情摘要（每幕结束必须调用一次，200 字以内）。摘要会替代整段对话进入后续上下文，是长团不爆上下文的关键。',
    category: 'utility',
    icon: '🗺️',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '场景名，如"雾港酒馆"' },
        summary: { type: 'string', description: '这一幕发生了什么、玩家知道了什么、欠下什么账，200 字内' },
        act: { type: 'integer', description: '可选：推进到第几幕' }
      }
    },
    async execute(ctx, args) {
      try {
        const { camp, error } = mustCampaign(ctx.chatKey);
        if (error) return { content: error, isError: true };
        camp.scene = camp.scene || { name: '', summary: '' };
        const name = String(args?.name || '').trim().slice(0, 30);
        const text = String(args?.summary || '').trim().slice(0, 600);
        if (!name && !text) return { content: 'name 和 summary 至少要给一个', isError: true };
        if (name) camp.scene.name = name;
        camp.scene.summary = text;
        if (args?.act) camp.act = clampInt(args.act, 1, 99, camp.act || 1);
        pushLog(camp, { kind: 'scene', public: false, text: `场景：${camp.scene.name}；${text}` });
        save(camp.chatKey, camp);
        return { content: `已更新场景：「${camp.scene.name}」。摘要已存档，后续上下文会带上它。` };
      } catch (error) {
        return { content: `场景更新失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── v1.1 新增：攻击 / 移动 / 地图 / 行动经济 / 开局确认 / 目标 ────────
  api.registerTool({
    id: 'dnd_attack',
    name: '攻击结算',
    description:
      '一次攻击的完整结算：掷攻击骰对 AC、掷伤害、扣血、检查射程与地形、扣动作。战斗中玩家的攻击、武技、法术命中都必须用它；不要用 dnd_roll 代替。',
    category: 'utility',
    icon: '⚔️',
    parameters: {
      type: 'object',
      properties: {
        actor: { type: 'string', description: '攻击者（角色名或敌人名），省略=当前回合者' },
        target: { type: 'string', description: '目标名，未登记的敌人会自动加入战斗' },
        bonus: { type: 'integer', description: '攻击加值，默认 5' },
        damage: { type: 'string', description: '伤害骰，如 1d8+3；不给则只判命中' },
        ranged: { type: 'boolean', description: '是否远程（近战 1 格 / 远程 12 格）' },
        advantage: { type: 'string', description: 'normal / adv / dis' }
      },
      required: ['target']
    },
    async execute(ctx, args) {
      try {
        const { camp, error } = mustCampaign(ctx.chatKey);
        if (error) return { content: error, isError: true };

        const targetName = String(args?.target || '').trim();
        if (!targetName) return { content: '缺少目标', isError: true };

        if (!camp.combat?.active) {
          const order = (camp.party || []).map((m) => ({
            key: `pc:${m.userId}`,
            name: m.name,
            kind: 'pc',
            init: rollInitiative(m),
            hp: m.hp,
            maxHp: m.maxHp,
            ac: m.ac
          }));
          const foe = { key: `foe:${targetName}`, name: targetName, kind: 'foe', init: 5, hp: 12, maxHp: 12, ac: 13 };
          order.push(foe);
          order.sort((a, b) => b.init - a.init);
          camp.combat = { active: true, round: 1, index: 0, order };
        }

        ensureGrid(camp);
        placeTokens(camp, camp.combat.order);

        const actorName = String(args?.actor || '').trim() || currentEntry(camp)?.name;
        const actor = camp.combat.order.find((e) => e.name === actorName)
          || camp.combat.order.find((e) => e.kind === 'pc' && e.name === actorName)
          || currentEntry(camp);
        if (!actor) return { content: '找不到攻击者，先 dnd_combat start', isError: true };

        const target = findTarget(camp, targetName);
        if (!target) return { content: `找不到目标「${targetName}」`, isError: true };

        const aTok = tokenOf(camp, actor.key);
        const tTok = tokenOf(camp, target.ref.key || `foe:${target.name}`);
        const gap = dist(aTok, tTok);
        const reach = args?.ranged === true ? 12 : 1;
        if (gap != null && gap > reach) {
          return {
            content: `距离不够：${actor.name} 与 ${target.name} 相距 ${gap} 格，${args?.ranged === true ? '远程' : '近战'}射程 ${reach} 格。先 dnd_move 靠近，或换远程/法术。`,
            isError: true
          };
        }

        const turn = turnOf(camp, actor);
        if (!turn.action) {
          return { content: `${actor.name} 这回合的动作已经用掉了（${costText(turn)}）。要等下一位，或用附赠动作的轻武器攻击。`, isError: true };
        }

        const bonus = clampInt(args?.bonus, -10, 30, 5);
        const r = rollExpr('1d20', args?.advantage);
        if (r.error) return { content: r.error, isError: true };
        const nat = r.kept?.[0] ?? 0;
        const total = r.total + bonus;
        const ac = target.ac ?? target.ref.ac ?? 13;
        const crit = nat === 20;
        const hit = crit || total >= ac;

        turn.action = false;
        let dmg = 0;
        let dmgText = '';
        if (hit && args?.damage) {
          const dr = rollExpr(String(args.damage));
          if (!dr.error) {
            dmg = crit ? (dr.total ?? 0) + (dr.total ?? 0) : dr.total ?? 0;
            target.ref.hp = Math.max(0, target.ref.hp - dmg);
            if (target.kind === 'pc' && target.ref.hp === 0) {
              target.ref.conditions = target.ref.conditions || [];
              if (!target.ref.conditions.includes('倒地')) target.ref.conditions.push('倒地');
            }
            syncOrder(camp);
            dmgText = `，${dmg} 点伤害${crit ? '（暴击）' : ''}，${target.name} 剩 ${target.ref.hp}/${target.ref.maxHp}`;
          }
        } else if (!hit) {
          dmgText = '，未命中';
        }

        const text = `${actor.name} 攻击 ${target.name}：1d20(${nat}) ${bonus >= 0 ? '+' + bonus : bonus} = ${total} vs AC ${ac} → ${hit ? '命中' : '未命中'}${dmgText}${hit && !args?.damage ? '（未掷伤害）' : ''}`;
        pushLog(camp, { kind: 'attack', public: true, text });
        save(camp.chatKey, camp);
        const sent = await announce(ctx, `⚔️ ${text}`);
        return {
          content: `${sent ? '已播报。' : ''}${text}。本回合剩余：${costText(turn)}。不要复述数字，直接叙述结果。`,
          isError: false
        };
      } catch (error) {
        return { content: `攻击结算失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'dnd_move',
    name: '移动',
    description: '在地图上移动角色/敌人（切比雪夫距离，每回合 6 格）。超出移动力或撞墙会拒绝。玩家说“我过去/我退到墙边”时使用。',
    category: 'utility',
    icon: '🥾',
    parameters: {
      type: 'object',
      properties: {
        actor: { type: 'string', description: '谁在移动，省略=当前回合者' },
        x: { type: 'integer', description: '目标格 X（0~11）' },
        y: { type: 'integer', description: '目标格 Y（0~8）' }
      },
      required: ['x', 'y']
    },
    async execute(ctx, args) {
      try {
        const { camp, error } = mustCampaign(ctx.chatKey);
        if (error) return { content: error, isError: true };
        const grid = ensureGrid(camp);
        const actor = String(args?.actor || '').trim() || currentEntry(camp)?.name;
        const entry = (camp.combat?.order || []).find((e) => e.name === actor);
        if (!entry) return { content: `找不到「${actor}」，战斗开始后才有位置`, isError: true };
        const t = grid.tokens[entry.key];
        if (!t) return { content: '这名角色还没在地图上，先 dnd_combat start', isError: true };

        const x = clampInt(args?.x, 0, grid.w - 1, t.x);
        const y = clampInt(args?.y, 0, grid.h - 1, t.y);
        if (gridCell(grid, x, y) === '#') return { content: `(${x},${y}) 是柱子/墙，站不上去`, isError: true };
        const steps = dist(t, { x, y });
        const turn = turnOf(camp, entry);
        if (steps > turn.move) return { content: `移动力不够：需要 ${steps} 格，本回合只剩 ${turn.move} 格（每格 5 尺）`, isError: true };

        turn.move -= steps;
        t.x = x;
        t.y = y;
        pushLog(camp, { kind: 'move', public: false, text: `${entry.name} 移动到 (${x},${y})，走了 ${steps} 格` });
        save(camp.chatKey, camp);
        return {
          content: `${entry.name} 移动到 (${x},${y})，消耗 ${steps} 格移动力，本回合剩余 ${turn.move} 格。\n${renderGrid(camp, entry.key)}`
        };
      } catch (error) {
        return { content: `移动失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'dnd_map',
    name: '看地图',
    description: '显示当前战场的简易地形、每个人的位置、以及你与敌人的距离（格）。判断“够不够得到”“往哪走”时使用。',
    category: 'query',
    icon: '🗺️',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        const { camp, error } = mustCampaign(ctx.chatKey);
        if (error) return { content: error, isError: true };
        if (!camp.combat?.active) return { content: '现在没有战斗，没有战场地图。' };
        ensureGrid(camp);
        placeTokens(camp, camp.combat.order);
        const cur = currentEntry(camp);
        save(camp.chatKey, camp);
        return {
          content: `${renderGrid(camp, cur?.key)}\n现在是 ${cur?.name ?? '?'} 的回合（${cur?.turn ? costText(cur.turn) : '满资源'}），目标：${camp.objective || '（未设定，用 dnd_objective 设）'}`
        };
      } catch (error) {
        return { content: `读取地图失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'dnd_action',
    name: '行动消耗',
    description:
      '玩家做“攻击/施法”之外的举动时用它（开门、推人、喝药、躲藏、冲刺、协助、喊话、准备动作……）。工具判定消耗哪类资源并扣除，返回剩余；玩家做超出行动经济的第二件事时会被拒绝。',
    category: 'utility',
    icon: '🎯',
    parameters: {
      type: 'object',
      properties: {
        actor: { type: 'string', description: '行动者，省略=当前回合者' },
        what: { type: 'string', description: '玩家要做的事，原话即可' },
        kind: { type: 'string', description: '可选：action / bonus / reaction / move（不给就按描述推断）' }
      },
      required: ['what']
    },
    async execute(ctx, args) {
      try {
        const { camp, error } = mustCampaign(ctx.chatKey);
        if (error) return { content: error, isError: true };
        const actorName = String(args?.actor || '').trim() || currentEntry(camp)?.name;
        const entry = (camp.combat?.order || []).find((e) => e.name === actorName);
        const what = String(args?.what || '').trim().slice(0, 80);
        if (!what) return { content: '缺少要做的事', isError: true };

        if (!camp.combat?.active) {
          pushLog(camp, { kind: 'action', public: false, text: `${actorName || '玩家'}：${what}（非战斗）` });
          save(camp.chatKey, camp);
          return { content: `非战斗场景，「${what}」不消耗行动经济，直接叙述即可。` };
        }
        if (!entry) return { content: `找不到「${actorName}」`, isError: true };

        let kind = String(args?.kind || '').toLowerCase();
        if (!['action', 'bonus', 'reaction', 'move'].includes(kind)) {
          if (/附赠/.test(what)) kind = 'bonus';
          else if (/借机|反应|护盾|倒伏|反制/.test(what)) kind = 'reaction';
          else if (/冲刺|撤离|闪避|协助|躲藏|搜索|研究|准备|喝药|开门|推|擒抱|撞|喊话|威胁|交涉/.test(what)) kind = 'action';
          else kind = 'action';
        }

        const turn = turnOf(camp, entry);
        const label = { action: '动作', bonus: '附赠动作', reaction: '反应', move: '移动' }[kind];
        if (!turn[kind]) {
          return {
            content: `${entry.name} 的${label}这回合已经用掉了（${costText(turn)}）。这件「${what}」不能算${label}——要么改到下回合，要么降级成不消耗资源的叙述。`,
            isError: true
          };
        }
        turn[kind] = false;
        const text = `${entry.name}「${what}」消耗：${label}。本回合剩余：${costText(turn)}`;
        pushLog(camp, { kind: 'action', public: false, text });
        save(camp.chatKey, camp);
        return { content: `${text}。请在回复里明确告诉玩家消耗了什么。` };
      } catch (error) {
        return { content: `行动结算失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'dnd_ready',
    name: '角色卡确认',
    description: '玩家确认自己的角色卡时调用（“就这样/确认/可以了”）。全员确认后才能 dnd_start 开场。',
    category: 'utility',
    icon: '✅',
    parameters: {
      type: 'object',
      properties: { actor: { type: 'string', description: '确认的角色名' } },
      required: ['actor']
    },
    async execute(ctx, args) {
      try {
        const { camp, error } = mustCampaign(ctx.chatKey);
        if (error) return { content: error, isError: true };
        const actor = String(args?.actor || '').trim();
        const pc = findPc(camp, actor);
        if (!pc) return { content: `队伍里没有「${actor}」，先 dnd_sheet 建卡`, isError: true };
        camp.setup = camp.setup || { confirmed: [] };
        if (!camp.setup.confirmed.includes(pc.userId)) camp.setup.confirmed.push(pc.userId);
        save(camp.chatKey, camp);
        const total = (camp.party || []).length;
        const done = camp.setup.confirmed.length;
        return {
          content: `已记录 ${pc.name} 确认角色卡（${done}/${total}）。${done >= total ? '全员确认完毕，可以 dnd_start 开场。' : '还差：' + (camp.party || []).filter((m) => !camp.setup.confirmed.includes(m.userId)).map((m) => m.name).join('、')}`
        };
      } catch (error) {
        return { content: `记录失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'dnd_start',
    name: '开场',
    description: '全员确认角色卡后开场：写入这一幕的目标并给出开场引导。没确认完会被拒绝。',
    category: 'utility',
    icon: '🎬',
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: '这一幕给玩家的明确目标，一句话' },
        scene: { type: 'string', description: '开场场景名，可选' }
      },
      required: ['objective']
    },
    async execute(ctx, args) {
      try {
        const { camp, error } = mustCampaign(ctx.chatKey);
        if (error) return { content: error, isError: true };
        if (!(camp.party || []).length) return { content: '还没有角色卡，先让玩家建卡', isError: true };
        const confirmed = camp.setup?.confirmed || [];
        const missing = (camp.party || []).filter((m) => !confirmed.includes(m.userId));
        if (missing.length) {
          return {
            content: `还不能开场：${missing.map((m) => m.name).join('、')} 还没确认角色卡。先让他们逐项核对并调 dnd_ready。`,
            isError: true
          };
        }
        const objective = String(args?.objective || '').trim().slice(0, 120);
        if (!objective) return { content: '缺少目标', isError: true };
        camp.objective = objective;
        const scene = String(args?.scene || '').trim().slice(0, 30) || '开场';
        camp.scene = { name: scene, summary: '' };
        camp.act = camp.act || 1;
        pushLog(camp, { kind: 'start', public: true, text: `开场：${scene}；目标：${objective}` });
        save(camp.chatKey, camp);
        return {
          content: `已开场。目标：${objective}。现在用 3~5 条短句给出：地点、眼前发生了什么、玩家能做的 2~3 个方向。把目标原话说给玩家听。`
        };
      } catch (error) {
        return { content: `开场失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'dnd_objective',
    name: '剧情目标',
    description: '设定或查看当前这一幕的目标。换场景、进新幕、玩家迷茫时必须更新并在群里重申。',
    category: 'utility',
    icon: '🎯',
    parameters: {
      type: 'object',
      properties: { objective: { type: 'string', description: '新目标；不填则只查看' } }
    },
    async execute(ctx, args) {
      try {
        const { camp, error } = mustCampaign(ctx.chatKey);
        if (error) return { content: error, isError: true };
        const next = String(args?.objective || '').trim();
        if (next) {
          camp.objective = next.slice(0, 120);
          pushLog(camp, { kind: 'objective', public: false, text: `目标更新：${camp.objective}` });
          save(camp.chatKey, camp);
        }
        return { content: `当前目标：${camp.objective || '（未设定）'}。请在群里用一句话重申给玩家。` };
      } catch (error) {
        return { content: `目标读写失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'dnd_lookup',
    name: '查表',
    description:
      '查 D&D 5e 种族、职业、技能、天赋的规则要点（属性加成、速度、特性、生命骰、主属性、豁免、职业 1~12 级特性路线、40 个子职业、技能对应属性、天赋前置与效果）。建卡前后玩家问“精灵有什么”“法师能用什么武器”“战士 3 级有啥能力”“5 级战士”“狂战士有什么”“战斗大师”时用；不带名字则列出全部清单。',
    category: 'query',
    icon: '📖',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'race / class / skill / feat，或直接写 种族/职业/技能/天赋' },
        query: { type: 'string', description: '名字或关键词，如 精灵、法师、察觉、巨武器大师；也可写“战士 5 级”查某一级；省略则列清单' }
      },
      required: ['kind']
    },
    async execute(ctx, args) {
      try {
        const kind = normalizeKind(args?.kind);
        const text = lookup(kind, args?.query);
        return { content: text };
      } catch (error) {
        return { content: `查表失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 日志 ─────────────────────────────────────────────────
  api.registerTool({
    id: 'dnd_log',
    name: '判定日志',
    description: '回看最近的掷骰、检定、伤害、场景记录。玩家问"刚才那个骰是多少/复盘一下"时使用。',
    category: 'query',
    icon: '📖',
    parameters: {
      type: 'object',
      properties: {
        tail: { type: 'integer', description: '看最近几条，默认 10' },
        includeSecret: { type: 'boolean', description: '是否包含暗骰记录，默认 false' }
      }
    },
    async execute(ctx, args) {
      try {
        const { camp, error } = mustCampaign(ctx.chatKey);
        if (error) return { content: error, isError: true };
        const tail = clampInt(args?.tail, 1, 50, 10);
        const withSecret = args?.includeSecret === true;
        const rows = (camp.log || [])
          .filter((e) => withSecret || e.public)
          .slice(-tail)
          .map((e) => `${new Date(e.t).toLocaleTimeString('zh-CN', { hour12: false })} ${e.text}`);
        return { content: rows.length ? rows.join('\n') : '还没有记录' };
      } catch (error) {
        return { content: `读取日志失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

/**
 * 动态提示词：只要当前会话有跑团存档，就把它压缩成一小段放进上下文。
 * 没有存档时返回空数组 —— 普通聊天完全不受影响。
 */
export function promptSections(ctx) {
  try {
    const camp = load(ctx?.chatKey);
    if (!camp) return [];
    const scene = camp.scene || {};
    const combat = camp.combat?.active
      ? `战斗中：${camp.combat.order?.[camp.combat.index]?.name ?? '?'} 的回合，第 ${camp.combat.round} 轮`
      : '未在战斗';
    const rules = [
      '【跑团主持规则】',
      '1. 一切随机与数值都走工具：dnd_roll / dnd_check / dnd_attack / dnd_damage / dnd_combat。禁止口算、编数字，也禁止用 dnd_roll 代替攻击结算。',
      '2. 开局顺序：dnd_new → 每人 dnd_sheet 建卡 → 玩家逐项确认 dnd_ready → 全员确认后 dnd_start 定目标 → 再给第一个场景。没确认完不许开打。',
      '3. 每一幕都要有明确目标（dnd_objective）。每次换场景、每 3 轮战斗、玩家不知道干嘛时，用一句话重申“你们现在的目标是……”。',
      '4. 禁止卡关：同一个障碍最多两次检定；第二次失败必须换路（线索、代价、时间压力、新敌人），让局面向前走。玩家合理行动即使失败也要产生变化与情报，不许只回“再试试”。',
      '5. 战斗：dnd_combat start 必须登记敌人；每次攻击调 dnd_attack（自动对 AC、扣血、播报）。没有工具结算就不许在叙述里说对方掉血。',
      '6. 地形与距离：dnd_map 看位置，dnd_move 移动（每回合 6 格）。近战 1 格、远程 12 格；够不到必须直说“距离 X 格，够不着”，并要求移动或换手段。',
      '7. 行动经济：攻击/施法之外的举动调 dnd_action，工具给出消耗与剩余。回复里必须说清“这次用了动作/附赠动作/反应/移动 X 格”；用完了就只能等下一轮。',
      '8. 掷骰后不复述数字，改叙述结果；失败也要写出代价与推进。',
      '9. 血线 0 是倒地不是死，给玩家“还能赌一把”的选择。',
      '10. 群里多人时，只有当前行动者能行动，其他人是支招；顺序由 dnd_combat 管理。'
    ].join('\n');

    const body = [
      rules,
      '',
      `《${camp.title}》第 ${camp.act || 1} 幕${scene.name ? `｜场景：${scene.name}` : ''}`,
      scene.summary ? `回顾：${scene.summary}` : '',
      `队伍：${partyLines(camp)}`,
      combat
    ]
      .filter(Boolean)
      .join('\n');
    return [{ id: 'dnd-state', title: '跑团状态', priority: 60, content: body }];
  } catch {
    return [];
  }
}
