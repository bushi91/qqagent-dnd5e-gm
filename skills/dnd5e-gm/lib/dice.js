import { randomInt } from 'node:crypto';

const MAX_DICE = 50;
const MAX_SIDES = 1000;

/**
 * 解析骰子表达式：支持 2d6、1d20+3、d8-1、纯数字 5（视为固定值）。
 * 返回 { count, sides, mod, raw } 或 { error }。
 */
export function parseExpr(expr) {
  const raw = String(expr ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!raw) return { error: '表达式为空，请用 NdM 形式，如 1d20+3' };

  const plain = raw.match(/^([+-]?\d{1,3})$/);
  if (plain) {
    const v = Number(plain[1]);
    if (!Number.isFinite(v)) return { error: `看不懂这个表达式：${expr}` };
    return { count: 0, sides: 0, mod: v, raw };
  }

  const m = raw.match(/^(\d{0,2})d(\d{1,4})([+-]\d{1,3})?$/);
  if (!m) return { error: `看不懂这个表达式：${expr}。请用 NdM 形式，如 1d20+3、2d6` };

  const count = m[1] === '' ? 1 : Number(m[1]);
  const sides = Number(m[2]);
  const mod = m[3] ? Number(m[3]) : 0;

  if (!Number.isInteger(count) || count < 1 || count > MAX_DICE) return { error: `骰子个数需在 1~${MAX_DICE} 之间` };
  if (!Number.isInteger(sides) || sides < 2 || sides > MAX_SIDES) return { error: `骰子面数需在 2~${MAX_SIDES} 之间` };
  if (!Number.isInteger(mod) || Math.abs(mod) > 100) return { error: '调整值需在 -100~100 之间' };
  return { count, sides, mod, raw };
}

/** 掷一个骰子（密码学随机，不可预测、不可复现）。 */
export function d(sides) {
  return randomInt(1, Number(sides) + 1);
}

/**
 * 掷骰并返回明细。
 * advantage: 'normal' | 'adv' | 'dis'，只对单个 d20 生效（优势/劣势 = 掷两次取高/低）。
 */
export function rollExpr(expr, advantage = 'normal') {
  const p = parseExpr(expr);
  if (p.error) return { error: p.error };
  if (p.count === 0) return { rolls: [], mod: p.mod, total: p.mod, kept: [], dropped: [], isD20: false };

  const rolls = Array.from({ length: p.count }, () => d(p.sides));
  let kept = rolls.slice();
  let dropped = [];
  const adv = String(advantage || 'normal').toLowerCase();
  const isD20 = p.sides === 20 && p.count === 1;

  if (isD20 && (adv === 'adv' || adv === 'dis')) {
    const second = d(20);
    const first = rolls[0];
    if (adv === 'adv') {
      kept = [Math.max(first, second)];
      dropped = [Math.min(first, second)];
    } else {
      kept = [Math.min(first, second)];
      dropped = [Math.max(first, second)];
    }
  }

  const total = kept.reduce((a, b) => a + b, 0) + p.mod;
  return { rolls, kept, dropped, mod: p.mod, total, isD20, count: p.count, sides: p.sides };
}

/** 把一次掷骰渲染成一句人话，如 `1d20+5 → [17] +5 = 22`。 */
export function formatRoll(r, expr) {
  if (r.error) return r.error;
  if (!r.kept || r.kept.length === 0) return `${expr} → ${r.total}`;
  const dicePart = r.kept.join(' + ');
  const modPart = r.mod ? (r.mod > 0 ? ` + ${r.mod}` : ` - ${Math.abs(r.mod)}`) : '';
  const droppedPart = r.dropped.length ? `（另掷 ${r.dropped.join(',')}，已弃）` : '';
  return `${expr} → ${dicePart}${modPart} = ${r.total}${droppedPart}`;
}

/** 属性值 → 调整值。 */
export function abilityMod(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 0;
  return Math.floor((n - 10) / 2);
}

/** 等级 → 熟练加值。 */
export function profBonus(level) {
  const lv = Math.max(1, Math.min(20, Number(level) || 1));
  return 2 + Math.floor((lv - 1) / 4);
}

/** 0~1 之间的小比例随机，用于随机表。 */
export function chance(p) {
  return randomInt(0, 1000) / 1000 < Number(p);
}
