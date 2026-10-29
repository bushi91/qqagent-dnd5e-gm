import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, '..', 'data', 'srd5e.json');

let cache = null;

export function srd() {
  if (!cache) {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  }
  return cache;
}

const KINDS = {
  race: ['种族', 'race', 'races'],
  class: ['职业', 'class', 'classes'],
  skill: ['技能', 'skill', 'skills'],
  feat: ['天赋', '专长', 'feat', 'feats']
};

export function normalizeKind(raw) {
  const s = String(raw || '').trim().toLowerCase();
  for (const [k, words] of Object.entries(KINDS)) {
    if (words.some((w) => s === w.toLowerCase() || s.includes(w))) return k;
  }
  return null;
}

function hit(item, q) {
  const hay = [item.name, item.en, item.abilities, item.primary, item.use]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(q.toLowerCase());
}

export function indexOf(kind) {
  const d = srd();
  if (kind === 'race') return d.races.map((r) => r.name + (r.subraces?.length ? `(${r.subraces.map((s) => s.name).join('/')})` : '')).join('、');
  if (kind === 'class') return d.classes.map((c) => c.name).join('、');
  if (kind === 'skill') return d.skills.map((s) => `${s.name}(${s.ability})`).join('、');
  if (kind === 'feat') return d.feats.map((f) => f.name).join('、');
  return '';
}

function raceText(r) {
  const lines = [
    `${r.name}（${r.en}）｜${r.size}｜速度 ${r.speed}｜属性 ${r.abilities}`,
    ...r.traits.map((t) => `· ${t}`)
  ];
  for (const s of r.subraces || []) {
    lines.push(`【${s.name}】${s.abilities}：${s.traits.join('；')}`);
  }
  return lines.join('\n');
}

function subclassText(c, s) {
  const lines = [`${c.name} · ${s.name}（${s.en}）`];
  for (const lv of s.levels) lines.push(`${lv.level} 级：${lv.text}`);
  return lines.join('\n');
}

function classText(c) {
  const lines = [
    `${c.name}（${c.en}）｜生命骰 ${c.hitDie}｜主属性 ${c.primary}｜豁免 ${c.saves}`,
    `护甲：${c.armor}｜武器：${c.weapons}`,
    `技能：${c.skills}`
  ];
  if (c.levels?.length) {
    lines.push('【1~12 级路线】');
    for (const lv of c.levels) lines.push(`${lv.level} 级：${lv.items.join('、')}`);
  }
  if (c.subclasses?.length) {
    lines.push(`【子职业 ${c.subclasses.length} 个】`);
    for (const s of c.subclasses) {
      lines.push(`${s.name}（${s.en}）`);
      for (const lv of s.levels) lines.push(`  ${lv.level} 级：${lv.text}`);
    }
  }
  lines.push('【1~3 级详细】');
  lines.push(...c.features.map((f) => `${f.level} 级 ${f.name}：${f.text}`));
  return lines.join('\n');
}

function levelText(c, lv) {
  const row = (c.levels || []).find((x) => x.level === lv);
  if (!row) return `${c.name} ${lv} 级：这一级没有列出的特性。`;
  return `${c.name} ${lv} 级：${row.items.join('、')}`;
}

function findSubclass(d, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return null;
  for (const c of d.classes) {
    for (const s of c.subclasses || []) {
      if (s.name.toLowerCase().includes(needle) || String(s.en).toLowerCase() === needle) return { c, s };
    }
  }
  // “战士 战斗大师”：先按职业名切一刀
  for (const c of d.classes) {
    if (!needle.startsWith(c.name)) continue;
    const rest = needle.slice(c.name.length).trim();
    for (const s of c.subclasses || []) if (s.name.toLowerCase().includes(rest)) return { c, s };
  }
  return null;
}

export function lookup(kind, query) {
  const d = srd();
  if (!kind) return '类型要写清楚：种族 / 职业 / 技能 / 天赋。';
  const q = String(query || '').trim();
  if (!q) {
    const label = { race: '种族', class: '职业', skill: '技能', feat: '天赋' }[kind];
    return `${label}清单：${indexOf(kind)}`;
  }

  if (kind === 'race') {
    const r = d.races.find((x) => hit(x, q) || (x.subraces || []).some((s) => s.name.includes(q)));
    return r ? raceText(r) : `没找到种族「${q}」。现有：${indexOf('race')}`;
  }
  if (kind === 'class') {
    const m = q.match(/^(.*?)\s*(\d{1,2})\s*级?$/);
    if (m && m[1]) {
      const c = d.classes.find((x) => hit(x, m[1].trim()));
      if (c) return levelText(c, Number(m[2]));
    }
    const c = d.classes.find((x) => hit(x, q));
    if (c) return classText(c);
    const sub = findSubclass(d, q);
    if (sub) return subclassText(sub.c, sub.s);
    return `没找到职业「${q}」。现有：${indexOf('class')}；子职业可直接问名字，如「狂战士」「战斗大师」。`;
  }
  if (kind === 'skill') {
    const s = d.skills.find((x) => hit(x, q));
    return s ? `${s.name}（${s.en}）｜属性：${s.ability}｜用于：${s.use}` : `没找到技能「${q}」。现有：${indexOf('skill')}`;
  }
  if (kind === 'feat') {
    const f = d.feats.find((x) => hit(x, q));
    return f ? `${f.name}｜前置：${f.prereq}｜${f.text}` : `没找到天赋「${q}」。现有：${indexOf('feat')}`;
  }
  return '类型要写清楚：种族 / 职业 / 技能 / 天赋。';
}
