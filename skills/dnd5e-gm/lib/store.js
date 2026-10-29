import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 本文件位于 <项目根>/skills/dnd5e-gm/lib/store.js → 上三级就是项目根
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

/** 存档目录：默认 <项目根>/data/dnd；测试可用 QQAGENT_DND_DATA 覆盖。 */
export const DATA_DIR = process.env.QQAGENT_DND_DATA
  ? path.resolve(process.env.QQAGENT_DND_DATA)
  : path.join(ROOT, 'data', 'dnd');

const MAX_LOG = 300;

/** chatKey → 安全文件名（只保留字母数字与 -_，其余转 _）。 */
export function fileFor(chatKey) {
  const safe = String(chatKey ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown';
  return path.join(DATA_DIR, `${safe}.json`);
}

function ensureDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* 目录已存在或无权限时交给后面的写盘报错 */
  }
}

/** 读档；不存在或损坏都返回 null（损坏时把原文件改名留证）。 */
export function load(chatKey) {
  const file = fileFor(chatKey);
  try {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object' || !obj.chatKey) return null;
    return obj;
  } catch (error) {
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* 改名失败就算了 */
    }
    return null;
  }
}

/** 原子写：先写临时文件再 rename，避免中途崩溃留下半个 JSON。 */
export function save(chatKey, data) {
  ensureDir();
  const file = fileFor(chatKey);
  const next = {
    ...data,
    chatKey: String(chatKey),
    version: 1,
    updatedAt: new Date().toISOString()
  };
  if (Array.isArray(next.log) && next.log.length > MAX_LOG) next.log = next.log.slice(-MAX_LOG);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return next;
}

/** 读 → 改 → 写。fn 返回值会忽略，直接以对象原地修改为准。 */
export function update(chatKey, fn) {
  const cur = load(chatKey) || null;
  if (!cur) return null;
  fn(cur);
  return save(chatKey, cur);
}

/** 删除当前群的存档（只删自己的 JSON）。 */
export function remove(chatKey) {
  try {
    const file = fileFor(chatKey);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** 追加一条日志。public=false 的条目不会在群里念出来（暗骰）。 */
export function pushLog(camp, entry) {
  if (!camp || !Array.isArray(camp.log)) {
    if (camp) camp.log = [];
    else return;
  }
  camp.log.push({ t: Date.now(), ...entry });
  if (camp.log.length > MAX_LOG) camp.log = camp.log.slice(-MAX_LOG);
}
