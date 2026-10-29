import { abilityMod, profBonus, rollExpr, formatRoll } from './lib/dice.js';
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
  return null;
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
      '1. 骰子、检定、伤害、先攻、HP 一律由工具计算，禁止自己编数字；要随机就调 dnd_roll / dnd_check。',
      '2. 玩家说“我要……”→ 先判是否需要检定：有明显失败代价才掷骰，小事直接叙述。',
      '3. 每次掷骰后不要复述骰子数字，用一句话叙述结果（“你一脚踹开，门后是……/差一点，刀锋擦着耳朵过去”）。',
      '4. 输赢都有戏：失败推进剧情，不给死胡同；NPC 有目标与恐惧，不是任务发放机。',
      '5. 每场战斗的 XP 按标准预算（5e DMG）：单人 1 级遇 3~4 只弱怪；每幕结束调 dnd_scene 写 200 字内摘要。',
      '6. 血线 0 不是死，是倒地与死亡豁免；给玩家“还能赌一把”的选项。',
      '7. 群里多人时：当前行动者才行动，其他人可以支招但不是行动；行动顺序靠 dnd_combat。'
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
