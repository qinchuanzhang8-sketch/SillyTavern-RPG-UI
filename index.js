/**
 * ST-RPG-UI v1.2 —— 人物信息卡（可拖动 / NTR 全字段 / 跟随聊天窗口） + RPG 状态栏
 * ─────────────────────────────────────────────────────────────
 * ▸ 人物信息卡：悬浮在聊天窗口（可用鼠标自由拖动，位置自动记忆）。
 *   · 随聊天窗口切换，自动显示「当前窗口内最活跃的角色」（近期出镜加权）。
 *   · 实时解析 AI 回复中的状态块并更新，数据保存在聊天元数据中随剧情推进。
 * ▸ 字段：姓名/性别/年龄/职业/金钱/时间(年-月-日 星期-24小时)/地点/天气/
 *   关系好感(对玩家与其他角色)/生命魔力体力理智性欲/怀孕状态(排卵+几率)/
 *   性爱总次数(按对象累计)/最喜欢的阴茎/阴道状态/肛门状况/阴道敏感度/精液量/体味/药物/服装分件/
 *   身体分件/姿态/行为/📷CG式外貌/道具/妆容/情绪/精神状态…
 * ▸ 状态块兼容：【状态栏】/【状态】/<StatusBlock>/<NTR>/```代码块 + chub 英文风格。
 * ▸ RPG 视觉守护：主题为「RPG 冒险者酒馆」时自动修复被覆盖的配色/背景/头像。
 * ▸ v1.8：数据连续性系统——自动注入「上一张人物信息卡」+ 数据连续性铁律
 *   （金钱只随收支增减／性爱总次数只增不减按对象累计／身体与数值循序渐进）。
 */

import { eventSource, event_types, saveSettings, saveSettingsDebounced, generateQuietPrompt, getRequestHeaders } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { power_user } from '../../../power-user.js';
import { background_settings } from '../../../backgrounds.js';

const MODULE = 'rpg_ui';
const DEFAULTS = {
    enabled: true,
    onUser: false,
    parseStats: true,
    compact: false,
    langForce: true,
    visualGuard: true,
    quietStatus: true,
    /* v1.6：独立更新通道（端点/密钥/模型）+ 模板与显示编辑 */
    quietApiUrl: '',
    quietApiKey: '',
    quietModel: '',
    quietModels: [],
    quietTokens: 2400,
    statusTemplate: '',
    hideFields: [],
    /* v1.7：卡片模板（显示 + AI 输出格式，一份两用） */
    cardTemplate: '',
    tplUser: '',
    notesUser: '',
    /* v1.9f：隐藏状态栏正则（仅显示层；内置，不再占用酒馆「正则」扩展） */
    hideRegex: '',
};

if (!extension_settings[MODULE]) {
    extension_settings[MODULE] = {};
}
const cfg = extension_settings[MODULE];
for (const [key, value] of Object.entries(DEFAULTS)) {
    if (cfg[key] === undefined) {
        cfg[key] = value;
    }
}
/* 配置升级：v2 起默认「人物信息卡开 / 每楼小条关 / 横幅关」 */
if (cfg.schema !== 2) {
    cfg.strips = false;
    cfg.infoCard = true;
    cfg.cardAuto = true;
    cfg.hudEnabled = false;
    cfg.schema = 2;
    try { saveSettingsDebounced(); } catch (err) { /* 忽略 */ }
}

function save() {
    try {
        saveSettingsDebounced();
    } catch (err) {
        try {
            getContext().saveSettingsDebounced?.();
        } catch (err2) { /* 忽略 */ }
    }
}

/* ── 首次进入时把界面切到简体中文（仅当用户从未设置过语言） ── */
try {
    if (cfg.langForce && !localStorage.getItem('language')) {
        localStorage.setItem('language', 'zh-cn');
        if (!String(navigator.language || '').toLowerCase().startsWith('zh')) {
            location.reload();
        }
    }
} catch (err) {
    console.warn('[RPG-UI] 语言设置失败', err);
}

/* ═══════════════════ 工具 ═══════════════════ */
function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function fmtTime(sendDate) {
    try {
        const d = new Date(sendDate);
        if (Number.isNaN(d.getTime())) {
            return String(sendDate || '').slice(0, 16);
        }
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        return `${hh}:${mi}`;
    } catch (err) {
        return '';
    }
}

/* 完整时间格式：X年X月X日 星期X HH:MM（24 小时制） */
function fmtFull(input) {
    try {
        const d = input instanceof Date ? input : new Date(input);
        if (Number.isNaN(d.getTime())) {
            return '';
        }
        const wd = '日一二三四五六'[d.getDay()];
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${wd} ${hh}:${mi}`;
    } catch (err) {
        return '';
    }
}

/* ═══════════════════ 数值解析 ═══════════════════ */
const STAT_DEFS = [
    { key: '生命', re: '(?:生命|血量|HP)', color: '#c0392b' },
    { key: '魔力', re: '(?:魔力|法力|MP)', color: '#3a6fb0' },
    { key: '体力', re: '(?:体力|精力|耐力|SP)', color: '#3e8e5a' },
    { key: '理智', re: '(?:理智|精神|SAN)', color: '#7a5fb0' },
    { key: '性欲', re: '(?:性欲值|性欲|欲望|desire)', color: '#c2608a' },
];

function parseStats(text) {
    const found = [];
    if (!text || !cfg.parseStats) {
        return found;
    }
    for (const def of STAT_DEFS) {
        let m = null;
        try {
            const reColon = new RegExp(
                `${def.re}\\s*(?:值|量)?\\s*[:：]\\s*(\\d{1,4})\\s*(?:[/／]\\s*(\\d{1,4})|%)?\\s*(?:[（(]\\s*([+\\-±]\\s*\\d{1,3})\\s*[）)])?`, 'i');
            m = text.match(reColon);
            if (!m) {
                const reFrac = new RegExp(
                    `${def.re}\\s*(?:值|量)?\\s*[^\\d\\n]{0,6}?(\\d{1,4})\\s*[/／]\\s*(\\d{1,4})`, 'i');
                m = text.match(reFrac);
            }
        } catch (err) {
            continue;
        }
        if (m) {
            const cur = Math.max(0, parseInt(m[1], 10) || 0);
            const max = Math.max(1, m[2] ? parseInt(m[2], 10) : 100);
            found.push({ key: def.key, color: def.color, cur, max, chg: m[3] ? ('（' + m[3].replace(/\s+/g, '') + '）') : null });
        }
    }
    return found;
}

function buildStatsHTML(stats, cardEdit = false) {
    if (!stats || !stats.length) {
        return '';
    }
    const hide = cfg.hideFields || [];
    return stats.map(st => {
        if (hide.includes(st.key)) {
            return '';
        }
        const has = st.cur !== null && st.cur !== undefined && !Number.isNaN(st.cur);
        const pct = has ? Math.max(0, Math.min(100, Math.round((st.cur / st.max) * 100))) : 0;
        const editAttr = cardEdit ? ` data-stat="${esc(st.key)}" contenteditable="true" spellcheck="false"` : '';
        const delBtn = cardEdit ? `<span class="rpg-ic-del" data-f="stat:${esc(st.key)}" title="删除该数值">×</span>` : '';
        return `<span class="rpg-sb-field${has ? '' : ' rpg-ic-empty'}" title="${esc(st.key)}">
            <span class="rpg-sb-label">${esc(st.key)}</span>
            <span class="rpg-sb-track"><span class="rpg-sb-fill" style="width:${pct}%;background:linear-gradient(90deg, ${st.color}88, ${st.color})"></span></span>
            <span class="rpg-sb-val"${editAttr}>${has ? `${st.cur}/${st.max}` : '—'}</span>${delBtn}
        </span>`;
    }).join('');
}

/* ═══════════════════ 状态块解析（人物信息卡数据源） ═══════════════════ */
const BLOCK_MARKERS = ['【状态栏】', '【状态】', '<StatusBlock>', '<状态栏>', '<状态>', '<NTR>', '【NTR状态栏】', '【RPG状态栏】'];

const FIELD_ALIASES = {
    time: ['时间', '时刻', '剧情时间', '当前时间', 'time'],
    place: ['地点', '位置', '场景', '所在地', 'place', 'location', 'current map', 'map'],
    weather: ['天气', '气候', 'weather'],
    gender: ['性别', 'gender'],
    age: ['年龄', 'age'],
    job: ['职业', '身份', '职务', 'job', 'occupation', 'profession'],
    race: ['种族', 'race'],
    height: ['身高', 'height'],
    money: ['金钱', '金币', '资产', '资金', '货币', '存款', 'money', 'gold', 'wealth'],
    outfit: ['服装', '衣着', '穿着', '服饰', '装扮', 'outfit', 'clothing', 'clothes'],
    body: ['身体状态', '身体状况', 'body', 'body status'],
    mood: ['心情', '心理', 'mood', 'feeling'],
    emotion: ['情绪', 'emotion'],
    pov: ['视角', '视点', 'pov', 'perspective'],
    behavior: ['行为', '当前行为', 'behavior', 'action'],
    posture: ['当前姿态', '姿态', 'posture'],
    pregnant: ['怀孕状态', '是否怀孕', '怀孕', '妊娠', '孕', 'pregnancy', 'pregnant'],
    health: ['健康', '身体状况', '身体健康', 'health'],
    ovulation: ['排卵/受精', '排卵受精', '是否排卵', '排卵', 'ovulation'],
    pregChance: ['怀孕可能性', '怀孕概率', '怀孕几率', 'pregnancy chance', 'pregnancy probability'],
    bioFather: ['生物学父亲', '生物父亲', '致孕者', 'biological father', 'bio father'],
    /* ── v1.8：性频率 → 性爱总次数（按对象累计，只增不减）＋ 最喜欢的阴茎 ── */
    sexFreq: ['性爱总次数', '性爱次数', '性交总次数', '性频率', '性行为次数', '性交次数', 'sex frequency', 'sex count'],
    favPenis: ['最喜欢的阴茎', '最喜欢的肉棒', '最爱的阴茎', 'favorite penis', 'preferred penis'],
    vagina: ['阴道状况', '阴道状态', '阴道', 'vagina'],
    anus: ['肛门状况', '肛门状态', '肛门', 'anus', 'anal'],
    sensitivity: ['阴道敏感度', '敏感度', 'sensitivity'],
    semen: ['精液量', '精液体积', '精液', 'semen', 'semen volume'],
    kinks: ['已开发性癖', '性癖', '癖好', 'kink', 'kinks'],
    bodyOdor: ['当前体味', '体味', '气味', 'body odor', 'odor'],
    drugs: ['药物状态', '药物', '用药', 'drug', 'drugs'],
    items: ['道具', '配饰', '道具/配饰', '随身物品', 'items', 'props'],
    makeup: ['makeup', '妆容', '化妆'],
    mental: ['精神', '精神状态', '意识', '神志', '催眠', 'mental', 'mental state'],
    relations: ['关系', '好感度', '好感', '亲密关系', 'relationship', 'relationships', 'favorability'],
    obedience: ['服从度', '服从', 'obedience'],
    desire: ['性欲值', '性欲', '欲望', 'desire', 'sexual desire'],
    cg: ['角色状态', '人物状态', '外貌', 'cg'],
    /* ── v1.4 新增：性行为记录 / 高潮值 / 乳房 ── */
    curPose: ['本次姿势', '本次体位', '性爱姿势', 'sexposition'],
    depth: ['插入深度', '本次插入深度', '最大插入深度', 'insertion'],
    satisfy: ['本次满意度', '本次性满意度', '满意度', 'satisfaction'],
    lastPoses: ['上次姿势', '上次体位', '上次性行为姿势', '上次总姿势'],
    lastCum: ['上次射精次数', '射精次数', '男射次数', '上次射精'],
    lastOrgasm: ['上次高潮次数', '高潮次数', '女高潮次数', '上次高潮'],
    lastReview: ['上次评价', '上次性行为评价', '上次评分', '上次的性评价'],
    breast: ['乳房状况', '乳房状态', '胸部状况', '乳房', 'breast'],
    climax: ['高潮值', '高潮槽', '高潮度', 'climax'],
    /* ── v1.5.2 新增：NTR 值 ── */
    ntr: ['ntr值', 'ntr度', 'ntr指数', 'ntr沉沦度', 'ntr沉浸度', 'ntr'],
    /* ── v1.5.3 新增：淫荡值 ── */
    lewd: ['淫荡值', '淫荡度', '淫乱值', '放荡值', '淫荡', 'lewdness', 'lewd'],
    /* ── v1.9c 新增：本次/上次性爱对比 与 心理比较 ── */
    curPartner: ['本次对象', '本次男方', '本次的男人'],
    lastPartner: ['上次对象', '上次男方', '上次的男人', '上次性爱对象'],
    lastPenis: ['上次阴茎', '上次的阴茎', '上次肉棒'],
    lastDepth: ['上次插入深度', '上次深度'],
    curReview: ['本次评价', '本次性爱评价', '当前评价'],
    penisCompare: ['阴茎比较', '阴茎对比', '尺寸比较'],
    sexCompare: ['性爱比较', '性爱对比', '体验比较'],
};

function findCanonical(rawKey) {
    /* v1.9d：白名单式清洗——只保留中文/英文/数字（清除一切符号与 emoji），
       避免「🥒 上次插入深度」因 emoji 残留而被「插入深度」在包含轮抢先匹配（上次值套进本次字段的根因） */
    const k = String(rawKey || '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').toLowerCase();
    if (!k) {
        return null;
    }
    // 第一轮：精确匹配
    for (const [canon, list] of Object.entries(FIELD_ALIASES)) {
        for (const alias of list) {
            const a = alias.replace(/\s/g, '').toLowerCase();
            if (k === a) {
                return canon;
            }
        }
    }
    // 第二轮：包含匹配（循环顺序即优先级）
    for (const [canon, list] of Object.entries(FIELD_ALIASES)) {
        for (const alias of list) {
            const a = alias.replace(/\s/g, '').toLowerCase();
            if (k.endsWith(a) || k.includes(a)) {
                return canon;
            }
        }
    }
    return null;
}

/* v1.9c：判断一个"名字"是否其实是模板分区标题（含 emoji / # / 区名关键词）——过滤被误抓的伪角色名 */
function isLikelySectionTitle(raw) {
    const n = String(raw || '').trim();
    if (!n) {
        return true;
    }
    if (/[0-9#]/.test(n)) {
        return true;
    }
    if (/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(n)) {
        return true;
    }
    return /status|bar|状态|时间|场景|基本|人物|关系|好感|数值|姿态|心情|精神|生理|性爱|服装|道具|视角|记录|金钱|信息|system/i.test(n);
}

function normalizeTarget(name) {
    const t = String(name || '').replace(/[{}<>]/g, '').trim();
    if (!t) {
        return '';
    }
    if (/^(user|玩家|你)$/i.test(t)) {
        return '玩家';
    }
    /* 占位词/泛称净化：AI 有时会把模板占位原样抄出来（如"其他重要角色"），直接丢弃不建条目 */
    if (/^(其他|其它|某|某个|若干|多个)?\s*(重要)?\s*(角色|人物|男人|男性|家伙|NPC)$/i.test(t)) {
        return '';
    }
    if (/真名|占位|示例|填写/.test(t) || /^[?？·—\-。]{1,8}$/.test(t)) {
        return '';
    }
    return t;
}

function parseRelations(val) {
    const out = {};
    if (!val) {
        return out;
    }
    const parts = String(val).split(/[、,，;；|]+/);
    for (const rawPart of parts) {
        const part = rawPart.trim();
        if (!part) {
            continue;
        }
        const m = part.match(/^([^（(]{1,16})[（(]\s*([^）)]{1,40})\s*[）)]\s*$/);
        if (m) {
            const name = normalizeTarget(m[1]);
            const detail = m[2].trim();
            const num = detail.match(/(\d{1,3})/);
            if (name) {
                out[name] = { val: num ? Math.min(100, parseInt(num[1], 10)) : null, note: detail };
            }
        } else {
            const numOnly = part.match(/^([^:：]{0,16})[:：]?\s*(\d{1,3})\s*(?:\/\s*100|%)?$/);
            if (numOnly && numOnly[2]) {
                const name = normalizeTarget(numOnly[1]) || '玩家';
                if (name) {
                    out[name] = { val: Math.min(100, parseInt(numOnly[2], 10)), note: '' };
                }
            } else if (part.length <= 40) {
                const nm = normalizeTarget(part);
                if (nm) {
                    out[nm] = { val: null, note: '' };
                }
            }
        }
    }
    return out;
}

/* 分件提取：[上半身：白衬衫][胸罩：无] → { 上半身: 白衬衫, 胸罩: 无 } */
function extractParts(str) {
    const out = {};
    if (!str) {
        return out;
    }
    const re = /\[([^[\]:：]{1,16})\s*[:：]\s*([^[\]]{0,100}?)\]\s*/g;
    let m = null;
    let n = 0;
    while ((m = re.exec(str)) && n < 26) {
        const k = m[1].trim();
        const v = m[2].trim();
        if (k && v && !FIELD_ALIASES[findCanonical(k)]) {
            out[k] = v;
            n++;
        }
    }
    return out;
}

/**
 * 从一段文本中解析状态块。
 * @returns {{name: string|null, fields: object, relations: object, stats: object, parts: object}|null}
 */
function parseBlock(text) {
    if (!text || typeof text !== 'string') {
        return null;
    }
    let block = null;
    for (const marker of BLOCK_MARKERS) {
        const i = text.lastIndexOf(marker);
        if (i >= 0) {
            block = text.slice(i + marker.length);
            break;
        }
    }
    if (!block) {
        const fences = [...text.matchAll(/```[a-zA-Z]*\s*\n([\s\S]*?)```/g)];
        for (const f of fences.reverse()) {
            if (/(时间|地点|好感|生命|HP|Favorability|Status)\s*[:：]/i.test(f[1])) {
                block = f[1];
                break;
            }
        }
    }
    if (!block) {
        const hits = Object.values(FIELD_ALIASES).flat()
            .filter(a => new RegExp(`${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:：]`, 'i').test(text)).length;
        if (hits >= 3) {
            block = text;
        }
    }
    if (!block) {
        return null;
    }

    block = block.replace(/<\/(?:StatusBlock|状态|状态栏|NTR)>/gi, '\n');
    /* 「🛏 本次性行为：姿势：X ｜ 插入深度：Y」→ 拆为可识别的独立字段（世界书/静默协议格式） */
    block = block.replace(/(本次|上次)性行为\s*[:：]\s*姿\s*势\s*[:：]?/g, '$1姿势：');
    const rawBlock = block;
    const lineBlock = block
        .replace(/[』】]\s*[『【]/g, (m) => m[0] + '\n' + m[1])
        .replace(/\]\s*\[/g, ']\n[')
        .replace(/[｜|]\s*(?=[^\n｜|]{1,26}[:：])/g, '\n');

    const fields = {};
    const relations = {};
    const customFields = {};
    let name = null;
    const parts = extractParts(rawBlock);

    const lines = lineBlock.split(/\r?\n/);
    for (const line of lines) {
        const mm = line.match(/^\s*[『\[\-•*\s]*([^:：]{1,28}?)\s*[:：]\s*(.+?)\s*[』\]】]?\s*$/);
        if (!mm) {
            continue;
        }
        const rawKey = mm[1];
        const val = mm[2].replace(/[『』【】\[\]]/g, '').trim();
        if (!val) {
            continue;
        }
        const keyClean = String(rawKey).replace(/^[^一-龥A-Za-z0-9]+/, '').trim();

        // 📷 CG 式外貌（{{char}}状态）
        if (line.includes('📷')) {
            fields.cg = val;
            continue;
        }
        // 关系好感的专用格式：『💗 对 X 的好感度：85/100』
        const mFavor = keyClean.match(/^对(.{1,16}?)的?(?:好感度|好感)$/);
        if (mFavor) {
            const t = normalizeTarget(mFavor[1]);
            const num = val.match(/(\d{1,3})/);
            if (t) {
                relations[t] = relations[t] || { val: null, note: '' };
                if (num) {
                    relations[t].val = Math.min(100, parseInt(num[1], 10));
                    const mc = val.match(/[（(]\s*([+\-±]\s*\d{1,3})\s*[）)]/);
                    relations[t].chg = mc ? ('（' + mc[1].replace(/\s+/g, '') + '）') : null;
                }
            }
            continue;
        }
        // 『💋 与 X 的关系：…』
        const mFeel = keyClean.match(/^与(.{1,16}?)的?(?:关系|感情|羁绊)$/);
        if (mFeel) {
            const t = normalizeTarget(mFeel[1]);
            if (t) {
                relations[t] = relations[t] || { val: null, note: '' };
                relations[t].note = val;
            }
            continue;
        }

        const canon = findCanonical(keyClean);
        if (!canon) {
            /* v1.6：未知字段 → 收进“自定义”条目（配合可编辑模板：新增字段会自动显示在卡片自定义区） */
            const ck = String(keyClean).trim();
            if (ck && ck.length <= 14 && !/\s/.test(ck) && val.length <= 160 && Object.keys(customFields).length < 24) {
                customFields[ck] = val;
            }
            continue;
        }
        if (canon === 'relations') {
            Object.assign(relations, parseRelations(val));
        } else if (canon === 'obedience') {
            const num = val.match(/(\d{1,3})/);
            if (num) {
                relations['服从'] = { val: Math.min(100, parseInt(num[1], 10)), note: '服从度' };
            }
        } else {
            fields[canon] = fields[canon] ? `${fields[canon]}；${val}` : val;
            if (canon === 'time' || canon === 'place' || canon === 'weather') {
                fields[`_scene_${canon}`] = val;
            }
        }
    }

    // chub NTR+ StatusBlock 风格兼容层
    const grab = (re) => {
        const m = rawBlock.match(re);
        return m ? m[1].replace(/[『』【】]/g, '').trim().slice(0, 240) : null;
    };
    if (!fields.place) {
        const p = grab(/Current map[:：]\s*([^\n]+)/i);
        if (p) { fields.place = p; fields._scene_place = p; }
    }
    if (!fields.pregnant) {
        const pr = grab(/Pregnancy status[:：]\s*([^\n]+)/i);
        if (pr) { fields.pregnant = pr; }
    }
    if (!fields.mood) {
        const e = grab(/Emotion[:：]\s*([^\n]+)/i);
        if (e) { fields.mood = e; }
    }
    const fav = rawBlock.match(/Favorability[^:：]*[:：]\s*(\d{1,3})/i);
    if (fav && !relations['玩家']) {
        relations['玩家'] = { val: Math.min(100, parseInt(fav[1], 10)), note: '' };
    }

    /* 「怀孕状态：是（是否排卵：是，怀孕几率：40%）」内嵌字段拆解 */
    if (fields.pregnant) {
        if (!fields.ovulation) {
            const ov = fields.pregnant.match(/(?:是否排卵|排卵\/受精)\s*[:：]\s*([^，,；;）)（(｜|\n]{1,20})/);
            if (ov && ov[1].trim()) {
                fields.ovulation = ov[1].trim();
            }
        }
        if (!fields.pregChance) {
            const pc = fields.pregnant.match(/怀孕(?:可能性|概率|几率)\s*[:：]?\s*(\d{1,3})\s*%?/);
            if (pc) {
                fields.pregChance = pc[1] + '%';
            }
        }
        if (!fields.bioFather) {
            const bf = fields.pregnant.match(/生物学父亲\s*[:：]\s*([^，,；;）)（(｜|\n]{1,24})/);
            if (bf && bf[1].trim()) {
                fields.bioFather = bf[1].trim();
            }
        }
    }

    // 清理正文型字段里残留的 [..] 片段（分件已单独提取）
    for (const k of ['outfit', 'body']) {
        if (fields[k]) {
            const cleaned = fields[k].replace(/\[[^\]]*\]?/g, '').trim();
            if (cleaned) {
                fields[k] = cleaned;
            } else {
                delete fields[k];
            }
        }
    }

    /* v1.9e：AI 常把「## 📷 视角」当标题、内容直接另起一段（没有「📷 名字视角：」前缀）——
       此时整段会因无冒号而被逐行跳过，导致视角显示为空。此处按「## 📷 视角」标题块兜底收录。 */
    if (!fields.cg) {
        try {
            const parts = block.split(/\n(?=#{1,4}\s)/);
            for (const part of parts) {
                const firstLine = (part.split('\n')[0] || '');
                if (!/📷/.test(firstLine)) {
                    continue;
                }
                let body = part.split('\n').slice(1).join('\n');
                body = body.replace(/<pic[\s\S]*$/i, '').trim();
                if (body.length >= 4) {
                    fields.cg = body.slice(0, 4000);
                }
                break;
            }
        } catch (errCg) { /* 忽略 */ }
    }

    // 名称：字段里的「人物」优先
    for (const cand of ['人物', '角色', '姓名', '名字', 'name']) {
        const re = new RegExp(`(?:^|\\n)\\s*${cand}\\s*[:：]\\s*([^\\n『』【】]{1,20})`);
        const m = block.match(re);
        if (m) {
            name = m[1].trim();
            break;
        }
    }
    if (!name) {
        const hashNames = [...block.matchAll(/#\s*([^\n『』]{1,16})/g)]
            .map(m => m[1].trim())
            .filter(n => n && !isLikelySectionTitle(n));
        if (hashNames.length) {
            name = hashNames[hashNames.length - 1];
        }
    }

    const stats = parseStats(block);
    const hasAnything = Object.keys(fields).length || Object.keys(relations).length || stats.length || name || Object.keys(parts).length || Object.keys(customFields).length;
    if (!hasAnything) {
        return null;
    }
    return { name, fields, relations, stats, parts, custom: customFields };
}

/* ═══════════════════ 人物信息卡：数据仓 ═══════════════════ */
const CARD_KEY = 'rpg_ui_card';

function getCardStore() {
    const ctx = getContext();
    if (!ctx.chatMetadata) {
        return null;
    }
    if (!ctx.chatMetadata[CARD_KEY]) {
        ctx.chatMetadata[CARD_KEY] = { active: null, auto: true, chars: {} };
    }
    const store = ctx.chatMetadata[CARD_KEY];
    /* v1.9c：清除非法的"伪角色名"条目（历史 bug 残留，如「# 🕐 时间·场景」） */
    try {
        if (store && store.chars) {
            let dirty = false;
            for (const n of Object.keys(store.chars)) {
                if (isLikelySectionTitle(n)) {
                    delete store.chars[n];
                    dirty = true;
                    continue;
                }
                const cs2 = store.chars[n];
                if (cs2 && cs2.title && isLikelySectionTitle(cs2.title)) {
                    cs2.title = null;
                    dirty = true;
                }
            }
            if (dirty) {
                if (store.active && !store.chars[store.active]) {
                    store.active = null;
                }
                if (store.locked && !store.chars[store.locked]) {
                    store.locked = null;
                }
                persistCard();
            }
        }
    } catch (err) { /* 忽略 */ }
    return store;
}

function persistCard() {
    try {
        getContext().saveMetadataDebounced?.();
    } catch (err) { /* 忽略 */ }
}

/* 恢复自动跟随（页面加载 / 切换聊天窗口时调用；手动模式仅限当前会话） */
let manualOverride = false;

function resetCardAuto() {
    manualOverride = false;
    const st = getCardStore();
    if (st) {
        st.auto = true;
        st.active = null;
    }
}

function ensureChar(store, name) {
    if (!store.chars[name]) {
        store.chars[name] = {
            fields: {}, relations: {}, stats: {}, parts: {}, count: 0, score: 0, lastMsg: -1, updated: 0, avatar: null,
        };
    }
    const cs = store.chars[name];
    // 兼容旧版本数据仓（补齐缺失字段）
    if (!cs.fields) { cs.fields = {}; }
    if (!cs.relations) { cs.relations = {}; }
    if (!cs.stats) { cs.stats = {}; }
    if (!cs.parts) { cs.parts = {}; }
    if (!cs.ovr) { cs.ovr = {}; }
    if (!cs.custom) { cs.custom = {}; }
    return cs;
}

/* 剧情角色名（卡片标题）清洗：如「米娅 / Mia」；过滤角色卡名与无效值 */
function cleanCharTitle(raw, cardName) {
    let n = String(raw || '').replace(/[『』【】"“”'\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!n) {
        return '';
    }
    const m = n.match(/^(.{1,20}?)\s*[（(]\s*([^（()）]{1,14})\s*[)）]\s*$/);
    if (m) {
        const outer = m[1].trim();
        const inner = m[2].trim();
        /* 「NTR Narrator（Mia）」→ 取括号内的 Mia；「米娅（妻子）」→ 保留米娅 */
        if (cardName && (outer === cardName || cardName.includes(outer) || outer.includes(cardName))) {
            n = inner;
        } else {
            n = outer;
        }
    }
    n = n.split(/[\/｜|、，,؛;]/)[0].trim();
    n = n.replace(/^(角色|人物|主角|女主角|本楼主角|视角角色|姓名|名字)\s*[:：是]?\s*/u, '').trim();
    if (!n || n.length > 16 || /\d/.test(n) || /可自定义|自定义|默认|未知/.test(n)) {
        return '';
    }
    if (cardName && (n === cardName || n.includes(cardName) || cardName.includes(n))) {
        return '';
    }
    return n;
}

/* 从角色卡描述里提取基础信息（性别/年龄/职业/种族/身高 + 默认角色名） */
function seedFromCharacterCard(store, ctx) {
    const cid = ctx.characterId;
    if (cid === undefined || cid === null || !Array.isArray(ctx.characters)) {
        return;
    }
    const ch = ctx.characters[Number(cid)];
    if (!ch?.name) {
        return;
    }
    const cs = ensureChar(store, ch.name);
    if (ch.avatar) {
        cs.avatar = ch.avatar;
    }
    /* 卡片标题（剧情角色名）：如「名称：可自定义（默认："Mia"或"你的妻子"）」→ Mia；
       一旦有名称就一直保留（重置/清空不删），保证信息卡始终有角色名 */
    if (!cs.title) {
        const d2 = String(ch.description || '');
        const mm = d2.match(/名称\s*[:：][^\n]{0,40}?默认\s*[:：]\s*["“”'『』]?\s*([^"“”'『』，,、）)\n或]{1,14})/)
            || d2.match(/名称\s*[:：]\s*["“”']?([^"“”'（(，,、）)\n或]{2,12})/);
        if (mm && mm[1].trim()) {
            const t = cleanCharTitle(mm[1].trim(), ch.name);
            if (t) {
                cs.title = t;
            }
        }
    }
    if (!cs.fields._seed && !cs.noSeed) {
        const d = String(ch.description || '') + '\n' + String(ch.personality || '');
        const g = (re) => {
            const m = d.match(re);
            return m ? m[1].replace(/[*。，,]/g, '').trim().slice(0, 16) : null;
        };
        cs.fields.gender = cs.fields.gender || g(/性别[：:]\s*([^\n，,。*]{1,6})/);
        cs.fields.age = cs.fields.age || g(/年龄[：:]\s*([^\n，,。*]{1,12})/);
        cs.fields.race = cs.fields.race || g(/种族[：:]\s*([^\n，,。*]{1,10})/);
        cs.fields.job = cs.fields.job || g(/职业[：:]\s*([^\n，,。*]{1,16})/) || g(/身份[：:]\s*([^\n，,。*]{1,16})/);
        cs.fields.height = cs.fields.height || g(/身高[：:]\s*([^\n，,。*]{1,12})/);
        cs.fields._seed = '1';
    }
}

/* 合并解析结果进数据仓 */
function mergeIntoStore(store, charName, parsed, msgIndex) {
    if (!charName || store.hidden?.[charName]) {
        return;
    }
    const cs = ensureChar(store, charName);
    /* 重置后的角色：忽略重置年份之前的旧消息数据 */
    if (msgIndex !== undefined && cs.resetFloor !== undefined && msgIndex < cs.resetFloor) {
        return;
    }
    for (const [k, v] of Object.entries(parsed.fields)) {
        if (v) {
            cs.fields[k] = v;
            if (cs.ovr && cs.ovr[k]) { delete cs.ovr[k]; } // AI 有新数据 → 解除删除/覆盖标记
        }
    }
    for (const [k, v] of Object.entries(parsed.relations)) {
        const nk = normalizeTarget(k); /* 统一净化（含快照回放路径的占位词） */
        if (!v || !nk) {
            continue;
        }
        cs.relations[nk] = v;
        /* 记录该关系最近一次被更新的消息位置（用于"实时切换当前男人"的过期过滤） */
        if (msgIndex !== undefined) {
            cs.relMsg = cs.relMsg || {};
            cs.relMsg[nk] = Math.max(cs.relMsg[nk] ?? -1, msgIndex);
        }
        if (cs.ovr) { delete cs.ovr[`rel:${nk}`]; }
    }
    for (const st of parsed.stats || []) {
        cs.stats[st.key] = st;
        if (cs.ovr) { delete cs.ovr[`stat:${st.key}`]; }
    }
    if (parsed.parts) {
        for (const [k, v] of Object.entries(parsed.parts)) {
            cs.parts[k] = v;
        }
    }
    /* 模板里新增的自定义字段：并入“自定义”条目显示 */
    if (parsed.custom) {
        for (const [k, v] of Object.entries(parsed.custom)) {
            if (v) {
                cs.custom = cs.custom || {};
                cs.custom[k] = v;
            }
        }
    }
    /* 卡片标题：优先采用状态栏「人物/姓名」里的剧情角色名（如 米娅）；分区标题样文本不是名字 */
    if (parsed.name && !isLikelySectionTitle(parsed.name)) {
        const t = cleanCharTitle(parsed.name, getContext().name2);
        if (t && !isLikelySectionTitle(t)) {
            cs.title = t;
        }
    }
    cs.lastMsg = Math.max(cs.lastMsg ?? -1, msgIndex ?? -1);
    cs.updated = Date.now();
}

/* 近期出镜加权评分：用于「最活跃角色」判定 */
function computeScores(chat, ctx, windowSize = 30) {
    const scores = {};
    const start = Math.max(0, chat.length - windowSize);
    const span = Math.max(1, chat.length - start);
    for (let i = start; i < chat.length; i++) {
        const m = chat[i];
        if (!m || m.is_system || m.is_user || !m.name) {
            continue;
        }
        const recency = (i - start + 1) / span; // 0..1，越新权重越高
        scores[m.name] = (scores[m.name] || 0) + 1 + recency * 1.5;
    }
    if (ctx.name2 && scores[ctx.name2] !== undefined) {
        scores[ctx.name2] += 0.5; // 当前聊天窗口的主角微加成
    }
    return scores;
}

/* 扫描聊天：统计出镜 + 解析状态块（v1.4：升序增量解析 + 后台状态快照回放） */
const STORE_VER = 3;

function scanChat(opts = {}) {
    const full = !!opts.full;
    const ctx = getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const store = getCardStore();
    if (!store) {
        return null;
    }
    /* 旧版数据仓自动清空重建，一次生效 */
    if (store.ver !== STORE_VER) {
        store.chars = {};
        store.history = {};
        store.active = null;
        store.locked = null;
        store.auto = true;
        store.ver = STORE_VER;
        persistCard();
    }
    if (!store.history) {
        store.history = {};
    }
    seedFromCharacterCard(store, ctx);

    for (const cs of Object.values(store.chars)) {
        cs.count = 0;
        cs.score = 0;
    }
    const userName = ctx.name1;
    const start = full ? 0 : Math.max(0, chat.length - 16);
    for (let i = start; i < chat.length; i++) {
        const m = chat[i];
        if (!m || m.is_system || m.is_user || !m.name || m.name === userName || store.hidden?.[m.name]) {
            continue;
        }
        const cs = ensureChar(store, m.name);
        cs.count = (cs.count || 0) + 1;
        cs.lastMsg = Math.max(cs.lastMsg ?? -1, i);
        if (full || i > (store.parsedUpto ?? -1)) {
            /* ① 消息内嵌状态块（旧聊天 / 其他预设） */
            const parsed = parseBlock(m.mes);
            if (parsed) {
                mergeIntoStore(store, parsed.name || m.name, parsed, i);
            }
            /* ② 后台静默状态快照（按消息位置回放，支持删除回退） */
            const snap = store.history[i];
            if (snap) {
                /* 快照按写入时的锁定键回放（key），退回旧字段 name 兼容 */
                mergeIntoStore(store, snap.key || m.name, snap, i);
            }
        }
    }
    /* 消息被移除（未经删除事件）时回退游标，避免索引复用导致漏解析 */
    if ((store.parsedUpto ?? -1) >= chat.length) {
        store.parsedUpto = chat.length - 1;
    }
    store.parsedUpto = Math.max(store.parsedUpto ?? -1, chat.length - 1);
    const scores = computeScores(chat, ctx);
    for (const [nm, sc] of Object.entries(scores)) {
        ensureChar(store, nm).score = sc;
    }
    return store;
}

/* 完全重建（删除消息后，卡片回退到上一次描写的人物状态） */
function rebuildCardStore() {
    const ctx = getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const store = getCardStore();
    if (!store) {
        return;
    }
    /* 保留下手动编辑（ovr 覆盖 / __DEL__ 删除标记）与自定义条目 */
    const preserved = {};
    for (const [n, cs] of Object.entries(store.chars)) {
        preserved[n] = { ovr: cs.ovr || {}, custom: cs.custom || {} };
    }
    store.chars = {};
    store.parsedUpto = -1;
    store.locked = null;
    if (!store.history) {
        store.history = {};
    }
    for (const k of Object.keys(store.history)) {
        if (Number(k) > chat.length - 1) {
            delete store.history[k];
        }
    }
    scanChat({ full: true });
    for (const [n, p] of Object.entries(preserved)) {
        if (isLikelySectionTitle(n)) {
            continue;
        }
        const cs = ensureChar(store, n);
        cs.ovr = Object.assign({}, p.ovr, cs.ovr || {});
        cs.custom = Object.assign({}, p.custom, cs.custom || {});
    }
    persistCard();
    $('#rpg-info-card').removeData('sig');
    updateCard();
}

/* 单条消息强制重解析（用于编辑/翻页事件） */
function reparseOne(id) {
    const ctx = getContext();
    const st = getCardStore();
    const m = ctx.chat?.[id];
    if (!st || !m || m.is_system) {
        return;
    }
    if (st.history) {
        delete st.history[id]; // 编辑/翻页后旧快照作废
    }
    const parsed = parseBlock(m.mes);
    if (parsed) {
        mergeIntoStore(st, parsed.name || m.name, parsed, id);
    }
}

/* 排序：近期出镜加权 > 总出镜数 > 最近出场 */
function sortChars(store) {
    return Object.keys(store.chars)
        .filter(nm => !store.hidden?.[nm])
        .sort((a, b) => (store.chars[b].score || 0) - (store.chars[a].score || 0)
            || (store.chars[b].count || 0) - (store.chars[a].count || 0)
            || (store.chars[b].lastMsg ?? -1) - (store.chars[a].lastMsg ?? -1));
}

/* 女性角色判定（用户要求：显示该窗口聊天最活跃的女性角色） */
function isFemale(cs) {
    const g = String(cs?.fields?.gender || '');
    return /女|female|♀|futa|shemale/i.test(g);
}

function pickActive(store, ctx) {
    if (!store.auto && store.active && store.chars[store.active]) {
        return store.active;
    }
    const names = sortChars(store).filter(n => !isLikelySectionTitle(n));
    if (!names.length) {
        return ctx.name2 || null;
    }
    /* 稳定锁：已选定的角色仍然活跃时不再随消息切换（每个角色只显示一张卡）；
       但若锁的是非女性角色、且此时已解析出女性候选，则改锁女性 */
    const chatLen = Array.isArray(ctx.chat) ? ctx.chat.length : 0;
    const females = names.filter(nm => isFemale(store.chars[nm]));
    if (store.locked && store.chars[store.locked]) {
        const lc = store.chars[store.locked];
        const lockActive = (lc.lastMsg ?? -1) >= chatLen - 14;
        if (lockActive && (isFemale(lc) || females.length === 0)) {
            return store.locked;
        }
    }
    return (females.length ? females : names)[0];
}

/* ═══════════════════ 人物信息卡：渲染 ═══════════════════ */
let lastRenderCache = {};

const RELATION_COLORS = ['#d8b25c', '#c987b8', '#7aa2c9', '#8fbf7a', '#c98080'];

const OUTFIT_KEY_RE = /上半身|上身|上衣|上装|外套|胸罩|胸衣|内衣|文胸|bra|upper|下装|下半身|裙|裤子|内裤|pants|panty|丝袜|长袜|袜|腿部|legs|stocking|鞋|靴|shoes|footwear|帽|hat|配饰|首饰|耳环|项链|手镯|戒指|手套|围巾|披风|斗篷|accessor|item/i;
const BODY_KEY_RE = /嘴巴|嘴|唇|口部|牙|胸部|胸|乳房|breast|chest|手部|手|hand|发型|头发|hairstyle|hair|腹部|肚子|abdomen|belly|大腿|thigh|腿部|腿|leg|脚部|脚|足|foot|feet|眼睛|eye|脖子|颈|背|臀|皮肤|skin|mouth/i;

function splitParts(parts) {
    const outfit = [];
    const body = [];
    for (const [k, v] of Object.entries(parts || {})) {
        if (OUTFIT_KEY_RE.test(k)) {
            outfit.push([k, v]);
        } else if (BODY_KEY_RE.test(k)) {
            body.push([k, v]);
        }
    }
    return { outfit, body };
}

function partsHTML(list) {
    list = (list || []).filter(([k]) => !(cfg.hideFields || []).includes(k));
    if (!list.length) {
        return '';
    }
    const edit = !!cfg.cardEdit;
    return `<div class="rpg-ic-parts">${list.map(([k, v]) => `<div class="rpg-ic-part"><b>${esc(k)}</b><span${edit ? ` data-p="${esc(k)}" contenteditable="true" spellcheck="false"` : ''}>${esc(v)}</span>${edit ? `<span class="rpg-ic-del" data-p="${esc(k)}" title="删除该部件">×</span>` : ''}</div>`).join('')}</div>`;
}

/* 当前渲染所用的删除标记（供占位模板判断） */
let currentOvr = {};

/* 与角色卡绑定的固定分件键（模板模式下始终显示） */
const STD_OUTFIT_PARTS = ['上半身', '胸罩', '下半身', '内裤', '腿部', '鞋子'];
const STD_BODY_PARTS = ['嘴巴', '胸部', '手', '发型', '腹部', '大腿', '脚'];

function fieldRowHTML(icon, label, value, flashKey, fieldKey, always) {
    if (fieldKey && currentOvr[fieldKey] === '__DEL__') {
        return '';
    }
    if (label && (cfg.hideFields || []).includes(label)) {
        return ''; /* 玩家在设置里隐藏的条目 */
    }
    const has = value !== null && value !== undefined && value !== '';
    if (!has && !always) {
        return '';
    }
    const display = has ? String(value) : '—';
    const dirty = has && lastRenderCache[flashKey] !== undefined && lastRenderCache[flashKey] !== display;
    const editable = cfg.cardEdit && fieldKey;
    return `<div class="rpg-ic-row${dirty ? ' rpg-ic-chg' : ''}${has ? '' : ' rpg-ic-empty'}">
        <span class="rpg-ic-ico"><i class="fa-solid ${icon}"></i></span>
        <span class="rpg-ic-label">${esc(label)}</span>
        <span class="rpg-ic-val"${editable ? ` data-f="${esc(fieldKey)}" contenteditable="true" spellcheck="false"` : ''}>${esc(display)}</span>
        ${editable ? `<span class="rpg-ic-del" data-f="${esc(fieldKey)}" title="删除该条目">×</span>` : ''}
    </div>`;
}

function relationHTML(name, rel, idx, playerName) {
    const label = (name === '玩家') ? playerName : name;
    const color = RELATION_COLORS[idx % RELATION_COLORS.length];
    const edit = !!cfg.cardEdit;
    let html = '';
    if (rel.val !== null && rel.val !== undefined) {
        html += `<div class="rpg-ic-rel">
            <span class="rpg-ic-rel-name">💗 对${esc(label)}好感度</span>
            <span class="rpg-sb-track rpg-ic-track"><span class="rpg-sb-fill" style="width:${rel.val}%;background:linear-gradient(90deg, ${color}88, ${color})"></span></span>
            <span class="rpg-ic-rel-val"${edit ? ` data-f="relv:${esc(name)}" contenteditable="true" spellcheck="false"` : ''}>${rel.val}/100</span>
            ${edit ? `<span class="rpg-ic-del" data-f="rel:${esc(name)}" title="删除该关系">×</span>` : ''}</div>`;
    } else {
        html += `<div class="rpg-ic-rel"><span class="rpg-ic-rel-name">💗 ${esc(label)}</span>${edit ? `<span class="rpg-ic-del" data-f="rel:${esc(name)}" title="删除该关系">×</span>` : ''}</div>`;
    }
    if (rel.note || edit) {
        html += `<div class="rpg-ic-rel-sub"${edit ? ` data-f="reln:${esc(name)}" contenteditable="true" spellcheck="false"` : ''}>💋 与${esc(label)}：${esc(rel.note || '')}</div>`;
    }
    return html;
}

/* ── 全卡编辑会话：点 ✎ 进入 → 整卡可改（改值/删除/添加）→ 💾 保存 / ✕ 取消 ── */
let editSession = null;

function persistEdits() {
    if (editSession) {
        return; /* 编辑未保存：先不落盘，等点“保存” */
    }
    persistCard();
}

function startEditSession() {
    if (editSession) {
        return;
    }
    const st = getCardStore();
    const key = st?.active;
    const cs = st?.chars?.[key];
    if (!st || !cs) {
        return;
    }
    editSession = {
        key,
        backup: JSON.stringify({
            f: cs.fields || {}, r: cs.relations || {}, p: cs.parts || {},
            c: cs.custom || {}, o: cs.ovr || {}, s: cs.stats || {},
            t: cs.title ?? null, a: cs.avatar ?? null,
        }),
    };
    cfg.cardEdit = true;
    save();
    $('#rpg-info-card').removeData('sig');
    updateCard();
}

function finishEditSession(saveIt) {
    if (!editSession) {
        return;
    }
    const st = getCardStore();
    const cs = st?.chars?.[editSession.key];
    if (cs) {
        if (saveIt) {
            persistCard();
            console.debug('[RPG-UI] 卡片编辑已保存');
        } else {
            try {
                const b = JSON.parse(editSession.backup);
                cs.fields = b.f;
                cs.relations = b.r;
                cs.parts = b.p;
                cs.custom = b.c;
                cs.ovr = b.o;
                cs.stats = b.s;
                cs.title = b.t;
                cs.avatar = b.a;
            } catch (err) { /* 忽略 */ }
            console.debug('[RPG-UI] 卡片编辑已取消（改动已还原）');
        }
    }
    editSession = null;
    cfg.cardEdit = false;
    save();
    $('#rpg-info-card').removeData('sig');
    updateCard();
}

/* ═══════════════════ v1.7 卡片模板（卡片显示 + AI 输出格式，一份模板两用） ═══════════════════ */
/* v1.9 卡片模板（迁移升级用；无【状态栏】行——注入协议会自动补） */
const CARD_TEMPLATE_V19 = `## 🕐 时间·场景
时间：<…>
地点：<…>
天气：<…>
## 👤 基本信息
人物：<角色名>
性别：<…>
年龄：<…>
身高：<…>
种族：<…>
职业：<…>
金钱：<…>
## 👗 服装·道具
服装：[上半身：<…>][胸罩：<…>][下半身：<…>][内裤：<…>][腿部：<…>][鞋子：<…>]
🛒 道具/配饰：<…>
## 📊 数值状态
体力：<0-100>/100（±N）
性欲值：<0-100>/100（±N）
怀孕可能性：<0-100>%
高潮值：<0-100>/100（±N）
🔥 NTR值：<0-100>/100（±N）
💦 淫荡值：<0-100>/100（±N）
👌 敏感度：<0-100>/100（±N）
## 💗 关系好感
💗 对<user>的好感度：<0-100>/100（±N）
💋 与<user>的关系：<…>
💗 对<另一位男人>的好感度：<0-100>/100（±N）
💋 与<另一位男人>的关系：<…>
## 🎭 姿态·心情
💋 妆容：<…>
😃 当前姿态：<…>
🎇 当前行为：<…>
🎈 心情：<…>
🙀 情绪：<…>
🧠 精神：<…>
## 🛏 性爱记录
💠 是否处女：<是/否；若已不是处女，必须写明失去的时间、对象真名与方式，如"否（2026年5月4日 被某人以手指与性器在试衣间夺走）">
🛏 性爱总次数：<按对象分别累计，只增不减>
🍆 最喜欢的阴茎：<长XXcm·直径XXcm + 对象真名＋一条偏爱理由（硬度／持久／技巧／感觉）>
【本次】
🛏 本次对象：<…>
🛏 本次姿势：<…>
🥒 本次插入深度：<最小~最深，单位厘米>
💗 本次评价：<…>
【上次】
🛏 上次对象：<…>
🍆 上次阴茎：<…>
🥒 上次插入深度：<最小~最深，单位厘米>
🛏 上次姿势：<…>
💧 上次射精次数：<…> ｜ 😊 上次高潮次数：<…>
💬 上次评价：<…>
💭 阴茎比较：<…>
💭 性爱比较：<…>
🏥 健康：<健康/患病——患病须写疾病名与现状（潜伏期/发作/治疗中/已治愈）；性病单独注明（无 或 有：种类、感染时间、现状）；无病写"健康">
## 🔥 生理状态
🤰 怀孕状态：<是/否> | 排卵/受精：<是/否（受精要注明：卵子已受精）> | 生物学父亲：<未怀孕写"无"；受孕后写男方真名>
🍑 阴道状况：<…>
🌸 肛门状况：<…>
🐻 乳房状况：<…>
🧪 精液量：<按毫升计——胃部（口交射入）Xml ｜ 阴道内（含子宫）Xml ｜ 肛门内 Xml ｜ 外部（体表/衣物等）Xml；没有的写0ml>
🎯 已开发性癖：<喜欢：<…> ｜ 不喜欢：<…>——只写已开发/亲身体验过的；没有写"尚无">
👃 当前体味：<…>
💊 药物状态：<…>
## 📷 视角
📷 <角色名>视角：<…>`;
const DEFAULT_CARD_TEMPLATE = `【状态栏】
` + CARD_TEMPLATE_V19;

/* v1.9d：字段填写说明（设置面板可编辑；随协议发给 AI，指导填写） */
const DEFAULT_NOTES = `【人物信息卡·字段填写说明】（每条都按此解释填写与更新；一切信息变化都应顺其自然、有剧情或时间依据，禁止突兀跳变）
· 数值变化量标注（所有数值行通用）：好感度、体力、性欲值、高潮值、NTR值、淫荡值、敏感度——每个数字后面必须用（±N）注明本次变化量（例：72/100（+3）、58/100（-5）、无变化写（±0））；（±N）只是占位格式，N 要换成实际数字。变化必须与本楼剧情事实一致、循序渐进。
· 时间：格式 X年X月X日 星期X HH:MM（24小时制）；必须在上一版基础上自然前进（对话数分钟、赶路数小时、睡一觉到清晨），除非剧情明确跳跃。
· 地点：她此刻所在的详细位置（小到具体的房间与朝向），并写明玩家此刻在哪。
· 天气：当前天气与室内外环境氛围（光线、温度、声音）。
· 基本信息（性别/年龄/身高/种族/职业/金钱）：这些字段会以标签形式显示在头像旁。金钱只随剧情中的收入与支出增减，有变动就在括号里注明（如 ¥650（+200 直播结算／-499 买鞋）），没有变化就原样保留，禁止凭空跳变。
· 服装：每件写清颜色款式材质与穿戴状态（领口开着、湿了一块、被掀起、脱下放在了哪）。胸罩/内裤要注明"未穿"或当前状态；亲密或自慰之后要写上痕迹（湿痕、褶乱、被拽坏的扣子等等...）。
· 道具/配饰：只描写她此刻随身携带、双手触手可及的东西（身上佩戴、口袋、包里、手边伸手可拿到）。已经使用完/吃完的、已经丢失的、放在别处或离开她一定范围、双手触碰不到的物品，一律不写、并从此行移除；暂时摘下但仍在手边的要注明放在了哪（如"手机放在床头柜上"）。写清什么还在她身上、只写一什么已被取下，下一条对话不再描写。
· 好感度与关系：她心里的真实倾向。失望、受伤会缓慢下降；被温柔对待、愧疚补偿会缓慢上升；单次浮动能到个位数，且必须有具体剧情依据（变化量同样写（±N））。**必须始终保留一位「当前与她最亲近／纠缠最深的另一位男人」的好感与关系**——写他的真名（不要写"另一位男人"这几个字）；人选随剧情更换：谁最近与她接触最多、影响最深就写谁，旧的退场、新的补上；哪怕是这一楼暂时没出场的那个男人，也先保留到剧情重心真正换人为止。**他的好感度要与「对玩家的好感度」形成直接对比**：在「与他的关系」里直白描写她心里的天平——她更黏谁、更怕谁、更容易为谁的礼物心软、对玩家演的又是什么（带上与玩家的对比，如"比你阴茎长多少cm、直径粗多少cm，她却狡辩..."）。若她此刻还在与别的NPC接触、见面或联络，为每个这样的NPC各补一行好感与关系（每行都带（±N））；没有就不写，不要编造。**显示规则：卡片只常驻玩家与一位最重要的NTR角色；其他角色仅在最近一楼仍被更新时短暂显示，离开或不再重要会自动隐藏——不要为了保住显示而机械刷新他们的好感。**
· 好感度（0-100）分级参考：
 - 0-10 敌视：行为上当面冷淡、回避独处；心理上抵触防备、只维持表面礼貌；语言生硬、懒得敷衍。
 - 11-25 冷漠：行为上公事公办、保持距离；心理上戒备但不敌意；语言客套、话少。
 - 26-45 面熟：行为上认得、偶尔搭话；心理上有好奇但不亲近；语言自然、有分寸。
 - 46-60 友好：行为上愿意合作、闲聊；心理上觉得对方可靠；语言随意、玩笑渐多。
 - 61-75 亲近：行为上信任、分享私事、肢体接触自然；心理上开始在意对方情绪；语言变软、撒娇或依赖。
 - 76-90 亲密：行为上依赖、明显偏爱、主动找对方；心理上心动、会吃醋；语言黏、藏不住的偏袒。
 - 91-100 挚爱/迷恋：行为上倾心付出、占有欲强、愿为对方付出重大代价；心理上眼里只有对方；语言毫无保留、深情或患得患失。
· 体力（0-100）分级参考：
 - 0-10 力竭：站不稳、只顾喘息；脑子空白；气音、短句（"让我…歇会儿…"）。
 - 11-25 疲惫：动作迟缓、想躺下；懒得思考；语气敷衍、打哈欠、回话变短。
 - 26-45 疲倦：能行动但易累；注意力涣散；抱怨累、推掉不必要的事。
 - 46-60 一般：正常状态；正常交流。
 - 61-75 精神：行动轻快、心情好；乐于互动；话变多、爱开玩笑。
 - 76-90 充沛：精力旺盛、反应快；主动张罗事情；语调上扬、兴致勃勃。
 - 91-100 亢奋：坐不住、兴奋过度；情绪高涨难自控；语速快、爱闹。
· 性欲值（0-100）分级参考：
 - 0-10 冷淡：毫无念头、被撩无感；语气平静、公事公办。
 - 11-25 平静：偶尔想到很快移开；轻微撩拨只当玩笑；正常语气。
 - 26-45 心痒：注意到暧昧细节、悄悄多看；语言带上试探与玩笑。
 - 46-60 渴望：身体发热、容易脸红；心里期待被进一步；话里有暗示、爱撒娇。
 - 61-75 高涨：坐立难安、腿间发潮；一半注意力在"那件事"；主动贴近、明示暗示。
 - 76-90 饥渴：气息变粗、夹腿、手心出汗；满脑子想要；言语黏腻、近乎求欢。
 - 91-100 失控边缘：一点刺激就可能决堤；几乎无法思考别的事；气音、毫无掩饰地索求。
· 高潮值（0-100，情欲累积进度，高潮后清零）分级参考：
 - 0-10 未启动：心如止水。
 - 11-30 起火：身体微热、呼吸略变。
 - 31-50 攀升：呼吸变浅、注意力收窄、话变短。
 - 51-70 临界前：肌肉发紧、逻辑断线、口齿不清。
 - 71-90 濒临：颤抖、抓紧手边一切、求饶或催促。
 - 91-100 决堤：彻底失控、绷紧弓起，下一秒就是高潮。
· NTR值（0-100，她向他人沉沦的进度；只随重大剧情节点缓慢上升，不因单次接触猛涨）分级参考：
 - 0-20 抗拒期：抗拒越界、事后愧疚；心里仍坚定；语言上明确拒绝。
 - 21-45 动摇期：替对方找理由、偷偷回味；嘴上否认、语气变软。
 - 46-70 隐瞒期：主动隐瞒、谎话变多；纠结煎熬又放不下；对玩家报喜不报忧、转移话题。
 - 71-90 沉溺期：身心偏向对方、愧疚钝化；对玩家敷衍、对外主动。
 - 91-100 习以为常：彻底接受、内心平静甚至合理化；不再掩饰，甚至反客为主。
· 淫荡值（0-100，她对性本身的开放度：羞涩被动→主动索求）分级参考：
 - 0-10 羞涩：提到性会脸红、全程被动；不敢说荤话。
 - 11-25 保守：被动接受、事后羞耻；小声抱怨但不真的反抗。
 - 26-45 半推半就：嘴上矜持、身体诚实；敢小声说出想要。
 - 46-60 放开：接受各种花样、会说喜好；荤话能出口。
 - 61-75 主动：主动索求、主动挑逗；语言大胆。
 - 76-90 大胆：什么话都敢说、什么都敢试；半公开场合也敢玩。
 - 91-100 淫乱：以性为乐、毫无羞耻感；花样与言语完全放开。
· 敏感度（0-100）分级参考：
 - 0-10 迟钝：需要强烈刺激才有反应。
 - 11-30 普通：正常反应。
 - 31-50 敏感：轻触就有感觉、容易出声。
 - 51-70 高敏：一碰就软、容易湿。
 - 71-90 极敏：吹气都能颤、轻微刺激便濒临高潮。
 - 91-100 一碰就化：几乎触之即高潮。

【数值涨跌规则】（每项升降都必须有明确的剧情触发事件——遇到什么涨、遇到什么降按下表；没有触发事件就原样保留并写（±0）；禁止无缘无故的连续上升或持续下降；单次变化由你自行判断上涨或下降，以下只是大致方向。幅度一般为个位数，重大剧情节点至多十几点）
· 好感度↑：温柔对待、兑现承诺、礼物惊喜、共度重要时刻、危难相助、愧疚补偿；↓：失望受伤、爽约冷落、争吵、被揭穿谎言、羞辱或强迫。对另一位男人的好感↑：他的攻势与关怀、满足她的需求、攻心话术；↓：怠慢、玩腻、粗暴、控制欲过强。
· 体力↑：休息（20~40）、睡眠（100）、进食饮水（30~80）、按摩放松；↓：熬夜、劳累工作、剧烈运动、性爱消耗（高潮次数越多降得越多）、生病、饥饿。
· 性欲值↑：被撩拨、暧昧氛围、亲密接触、排卵期、长时间没有亲密（缓慢上浮）、观看情色内容；↓：高潮后大幅回落、冷水澡、身体疲惫、负面情绪、身体不适。
· 怀孕状态（必须随剧情时间实时推进，严禁照抄上一楼）：格式＝怀孕状态 | 排卵/受精 | 生物学父亲。变化条件：①未排卵→"排卵/受精：否"；②进入排卵期（经期前约14天、±3天窗口）→"排卵/受精：已排卵（未受精）"，怀孕可能性随周期上调；③排卵期内（卵子存活约24小时内）被无保护内射→"排卵/受精：卵子已受精"，并当次起把"怀孕状态"改写为"是"（显示怀孕成功）、怀孕可能性跳到60%以上；④受精后孕期逐日推进（停经、晨吐、嗜睡等），怀孕可能性逐步升到≈100%；⑤始终未受精（受精窗口过去仍无有效内射）→保持"已排卵（未受精）"，经期到来→重置为"否"，怀孕可能性回低位，下个周期循环；⑥已怀孕："怀孕状态"保持"是"，直至分娩或终止。生物学父亲：未怀孕时写"无"；受精或怀孕后写使卵子受精的那次内射的男方真名（她不确定或多人都可能时写"不明（可能与：甲／乙）"）；一经确定不得随意更改；经期重置（未孕）时同步清回"无"。周期约28天、经期约5天。每次填写前先对比上一张卡的时间——剧情过了多少天就推进多少天，"到了第二天仍是昨天的状态"直接算不合格，必须重写。
· 🏥 健康（身体状况与疾病）：写她当前的身体健康情况——是否健康、患了什么病、处于什么阶段；疾病必须与剧情吻合（感染史、防护与否、就医行为）。**感染概率铁律：她与任何对象发生无保护性行为都有染病概率，对象越陌生越危险**——固定且健康的伴侣＝零风险；熟识对象＝低风险（约10~30%）；陌生人、初次见面、酒后或被下药＝高风险（约40~70%）；频繁多伴侣/风月场对象＝极高（70%以上）；全程安全套可大幅降低但并非绝对（疱疹、湿疣等皮肤接触类戴套仍可能传染）。**性病会传染：任何体液交换——阴道/肛门被内射、口交、深喉、舔阴——都可能把病传染给参与的任何一方（包括玩家）**；她染病后会传染给之后与她做爱的人，对方染病亦然；传染后各方按潜伏期陆续出现症状或无症状携带（无症状也照样传染）。**性病谱系**：〔可治愈〕①淋病——头孢曲松等抗生素可治愈；②梅毒——青霉素可治愈（早期；拖延至晚期伤及全身）；③衣原体感染——多西环素/阿奇霉素；④支原体感染——阿奇霉素/多西环素；⑤软下疳——阿奇霉素/头孢曲松；⑥滴虫病——甲硝唑。〔无法治愈·病毒类〕⑦艾滋病（HIV）——无法治愈，抗病毒治疗（ART）可控制到接近常人寿命，需终身服药；⑧生殖器疱疹（HSV）——无法治愈，抗病毒药可压制复发，病毒终身潜伏；⑨尖锐湿疣（HPV）——疣体可经冷冻/激光/外用药去除，但病毒难以清除、极易复发。字段写法：未患病写"健康"；染病写"患病（××病，急性期/治疗中）"；治愈写"已治愈（××病，年-月）"；多种并列写。她是否知情、是否隐瞒、是否就医，都是剧情的一部分；染病与传染事件必须在正文中铺垫与表现。
· 🎯 已开发性癖（喜欢/不喜欢）：只写她已被开发、亲身体验过的性癖——"喜欢"写真正受用的，"不喜欢"写抗拒或无感的；从未开发过的可留空。"喜欢"里的**超级喜欢**项：她一碰就进入状态——敏感度与高潮值涨速约2~3倍、更快到达高潮且能连续高潮、身体更诚实（更湿、更颤、更主动配合）、**无法拒绝**（嘴上说不要、身体却背叛，或半推半就地接受）；正文给足细节（潮红、痉挛、失语、抱紧）。"不喜欢"项：明确抵触（拒绝、躲闪、提条件、事后生气）、身体干涩紧绷；高潮值/敏感度/淫荡值等**各项性爱数值涨速明显放缓（不到常态一半）**，强行使用会掉好感与心情、事后留怨；只有长期调教、淫荡值很高或面对特定对象时才可能缓慢转变（转变必须写清过程）。性癖随经历更新：第一次被开发时在正文写清感受，再记入喜欢/不喜欢；同一性癖的态度可缓慢演变、不能一夜反转；"喜欢"不能凭空出现，必须先被开发过。
· 高潮值↑：抚摸、亲吻、口交、抽插、道具与情话等刺激的累积（敏感度越高涨得越快）；↓：高潮后清零；刺激中断、冷却、疼痛、分心或被打扰时回落。
· NTR值↑：仅在重大剧情节点——第一次越界、反复隐瞒后尝到甜头、被其他角色攻心、重要时刻{{user}}缺席而在其他角色身边等，每次只加个位数；↓：只有真正修复关系（坦白＋{{user}}原谅＋长期远离对方）才缓慢回落，其余情况不降。
· 淫荡值↑：被开发新玩法、被夸奖或围观获得快感、自慰的刺激、主动尝试后尝到甜头；↓：受伤、被羞辱贬低、社死或被严厉管束、长期压抑。
· 敏感度↑：被反复使用、被认真调教、排卵期、长时间禁欲后再被触碰、开发出新的敏感点；↓：长期无亲密、身体疲惫、疼痛、经期初期与恢复期（缓慢回落）。被调教过的部位敏感度涨得更快。
· 总则：数值、身体状态与正文描写三边必须吻合——正文发生了什么，对应数值才动；数值档位也决定正文里她的表现（见上方分级表）。
· 妆容：完整妆、半妆还是素颜；眼妆花没花、口红糊没糊、脸上有没有汗和泪痕。
· 当前姿态/当前行为：此刻的身体姿态与位置（坐着/趴着/被谁抱着、手和腿放在哪里）与正在做的具体动作。
· 心情/情绪/精神：当下的情绪基调（几个词）；内心的纠结、期待与隐瞒（心理活动）；意识状态（清醒/疲倦/微醺/恍惚/被快感淹没/半梦半醒）。
· 💭 阴茎比较 / 💭 性爱比较：她内心真实的私下比较（比男人们的尺寸、硬度、持久、技巧；谁让她最有感觉、哪一次最难忘、对比时是愧疚还是沉溺）。用她的口吻、只写她此刻知道和感受过的；羞于承认也要写——但这是内心活动，绝不当众说出来。
· 生理状态：阴道/肛门写当下状态（湿润、收缩、松紧、颜色、精液残留、使用过度的痕迹，没开发过写"未开发"）；乳房写罩杯与手感（如 D杯，白软一手握不住）、乳尖状态与有无吻痕指痕；**精液量按毫升计、分四处写：胃部（口交射入）、阴道内（含子宫）、肛门内、外部（体表/衣物等）**，如"胃部10ml｜阴道内25ml｜肛门内0ml｜外部5ml"，没有的写0ml（淋浴清洗或时间流逝后相应清零；再次射入则累加）；体味写香水、汗味、情欲的气息、有没有混进别人的味道；药物写避孕药/酒精/催情类药物等等的药物...，没有服用药则写"无"。
· 性爱记录：顶部依次写三项常驻——①「💠 是否处女」：是/否；一旦失去处女，必须写明失去的时间、对象真名与方式（如"否（2026年5月4日 被某人以手指与性器在试衣间夺走）"），此后保持不变、不得篡改；②「🛏 性爱总次数」（只增不减、按对象分别累计，每发生一次对应对象+1，书写例：与玩家12次｜与某人7次）；③「🍆 最喜欢的阴茎」（长XXcm·直径XXcm + 对象真名＋一条偏爱理由（硬度／持久／技巧／感觉））；以她身体最诚实的答案为准，会随体验变化）。【本次】只记录"正在进行或刚刚结束"的这一场性爱（对象=真名；插入深度写最小~最深厘米数；💗 本次评价写她此时此刻的真实感受）。**重要结算规则：一旦她结束性爱、回到日常（穿衣、清洗、外出、聊天、睡觉……），必须当次把【本次】全部内容平移进【上次】**——上次对象＝原本次对象、上次阴茎＝该对象阴茎的长度粗细特征、上次插入深度＝原本次插入深度、上次姿势＝原本次姿势、上次射精次数／上次高潮次数＝本场实际发生数、上次评价＝原本次评价；随后把【本次】四格全部改写为"无"（本次对象：无 ｜ 本次姿势：无 ｜ 本次插入深度：无 ｜ 本次评价：无）。**此后只要没有新的性爱，【本次】始终保持"无"，严禁残留上一场的信息**，直到下一场性爱开始再逐项写回。【上次】为上一场的完整复盘（对象真名、与她的关系、体型与气质；阴茎写长度粗细特征以及她心里与玩家的对比；所有"上次"条目都必须带"上次"前缀）。
· 📷 视角：以第三人称、像游戏 CG 一样详细描述她此刻的外貌——细致入微、芳香细腻；注意对人体各部位的详细描述，包括声音、形状、颜色、味道、感觉，以及运动和变化过程中的整体表现，带来真实体验；必须是最新的，严禁照抄上一楼（不可重复）。
· 数值与描写必须一致：数值低时她的反应平淡、数值高时反应强烈；身体的湿润、腿软、呼吸与颤栗都要和敏感度、性欲值、高潮值等字段吻合——描写与数值不可互相矛盾，且必须符合上面的分级表与涨跌规则。`;

const STAT_ROW_MAP = {
    体力: '体力', 性欲: '性欲', 性欲值: '性欲',
    怀孕几率: '怀孕几率', 怀孕可能性: '怀孕几率',
    高潮值: '高潮值', NTR值: 'NTR值', 淫荡值: '淫荡值',
    敏感度: '敏感度',
};

function layoutRowType(label, canon) {
    const clean = String(label || '').replace(/^[^一-龥A-Za-z0-9]+/, '').trim();
    if (/^对.+的?好感度$/.test(clean) || /^与.+的?关系$/.test(clean) || canon === 'relations') {
        return 'rel';
    }
    if (STAT_ROW_MAP[clean]) {
        return 'stat';
    }
    if (canon === 'outfit') {
        return 'partsOutfit';
    }
    if (canon === 'body') {
        return 'partsBody';
    }
    if (canon === 'cg' || clean.endsWith('视角')) {
        return 'cg';
    }
    return 'field';
}

/* 解析卡片模板 → [{title, rows:[{label, canon, type}]}] */
function buildLayoutFromTemplate(text) {
    const out = [];
    let cur = null;
    const src = String(text || '')
        .replace(/本次性行为\s*[:：]\s*姿\s*势\s*[:：]?/g, '本次姿势：')
        .replace(/上次性行为\s*[:：]\s*姿\s*势\s*[:：]?/g, '上次姿势：');
    for (const raw of src.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) {
            continue;
        }
        const mh = line.match(/^#{1,4}\s*(.+)$/);
        if (mh) {
            cur = { title: mh[1].trim(), rows: [] };
            out.push(cur);
            continue;
        }
        if (!cur) {
            cur = { title: '', rows: [] };
            out.push(cur);
        }
        for (const seg of line.split(/[｜|]/).map(s => s.trim()).filter(Boolean)) {
            const kv = seg.match(/^([^:：]{1,30})[:：]\s*(.+)$/);
            if (!kv) {
                continue;
            }
            const label = kv[1].trim();
            const canon = findCanonical(label);
            cur.rows.push({ label, canon, type: layoutRowType(label, canon) });
        }
    }
    return out.filter(s => s.rows.length);
}

function updateCard() {
    try { syncPrevCardPrompt(); } catch (err0) { /* 忽略 */ }
    const ctx = getContext();
    const hasCharacter = (ctx.characterId !== undefined && ctx.characterId !== null && ctx.characterId !== '')
        || !!ctx.groupId;

    let $card = $('#rpg-info-card');
    if (!cfg.enabled || !cfg.infoCard || !hasCharacter) {
        $card.remove();
        return;
    }

    const store = scanChat();
    if (!store) {
        return;
    }
    const activeName = pickActive(store, ctx);
    const chars = sortChars(store);
    const curName = store.auto ? activeName : (store.active && store.chars[store.active] ? store.active : activeName);
    if (!curName) {
        return;
    }
    /* 手动模式仅在本次会话的主动切换后生效；其余时刻强制自动跟随 */
    if (!manualOverride) {
        store.auto = true;
    }
    store.active = curName;

    if (!$card.length) {
        $card = $('<div id="rpg-info-card" class="rpg-info-card"></div>');
        $('body').append($card);
        if (cfg.cardCollapsed) {
            $card.addClass('rpg-ic-collapsed');
        }
        // 恢复记忆的位置
        if (cfg.cardPos && Number.isFinite(cfg.cardPos.left) && Number.isFinite(cfg.cardPos.top)) {
            const nl = Math.min(Math.max(0, cfg.cardPos.left), Math.max(0, window.innerWidth - 80));
            const nt = Math.min(Math.max(0, cfg.cardPos.top), Math.max(0, window.innerHeight - 46));
            $card.css({ left: nl + 'px', top: nt + 'px' });
        }
        makeDraggable($card);
        $card.on('click', '.rpg-ic-prev', () => cycleChar(-1));
        $card.on('click', '.rpg-ic-next', () => cycleChar(1));
        $card.on('click', '.rpg-ic-auto', () => {
            if (editSession) {
                return;
            }
            manualOverride = false;
            const s = getCardStore();
            if (s) {
                s.auto = true;
            }
            persistCard();
            updateCard();
        });
        $card.on('click', '.rpg-ic-collapse', () => {
            $card.toggleClass('rpg-ic-collapsed');
            cfg.cardCollapsed = $card.hasClass('rpg-ic-collapsed');
            save();
        });
        /* ✎ 修改按钮：进入全卡编辑（整页可改，改完点保存）；编辑中再点 = 取消 */
        $card.on('click', '.rpg-ic-edit', () => {
            if (editSession) {
                finishEditSession(false);
            } else {
                startEditSession();
            }
        });
        /* 💾 保存 / ✕ 取消 */
        $card.on('click', '.rpg-ic-save', () => finishEditSession(true));
        $card.on('click', '.rpg-ic-cancel', () => finishEditSession(false));
        /* ✨ 推演补全 */
        $card.on('click', '.rpg-ic-fill', () => requestFill());
        /* 🗑 删除卡内角色 */
        $card.on('click', '.rpg-ic-drop', () => {
            if (editSession) {
                return;
            }
            const st = getCardStore();
            if (!st || !st.active) {
                return;
            }
            st.hidden = st.hidden || {};
            st.hidden[st.active] = 1;
            delete st.chars[st.active];
            st.locked = null;
            manualOverride = false;
            persistCard();
            $card.removeData('sig');
            updateCard();
        });
        /* 空态：恢复被 🗑 删除的全部角色 */
        $card.on('click', '.rpg-ic-restoreall', () => {
            if (editSession) {
                return;
            }
            const st = getCardStore();
            if (st) {
                st.hidden = {};
                persistCard();
            }
            rebuildCardStore();
        });
        /* ↺ 重置角色信息为空白 */
        $card.on('click', '.rpg-ic-reset', () => {
            if (editSession) {
                return;
            }
            const st = getCardStore();
            const cs = st?.chars?.[st.active];
            if (!st || !cs) {
                return;
            }
            cs.fields = {};
            cs.relations = {};
            cs.stats = {};
            cs.parts = {};
            cs.ovr = {};
            cs.custom = {};
            cs.noSeed = true;
            cs.resetFloor = getContext().chat?.length || 0;
            persistCard();
            $card.removeData('sig');
            updateCard();
        });
        /* 卡片宽度缩放 */
        $card.on('click', '.rpg-ic-wminus', () => {
            cfg.cardW = Math.max(190, (cfg.cardW || 252) - 36);
            save();
            $card.css('--rpg-card-w', cfg.cardW + 'px');
        });
        $card.on('click', '.rpg-ic-wplus', () => {
            cfg.cardW = Math.min(560, (cfg.cardW || 252) + 36);
            save();
            $card.css('--rpg-card-w', cfg.cardW + 'px');
        });
        /* 删除条目 */
        $card.on('click', '.rpg-ic-del', (e) => {
            e.stopPropagation();
            const $el = $(e.currentTarget);
            const st = getCardStore();
            const cs = st?.chars?.[st.active];
            if (!cs) {
                return;
            }
            cs.ovr = cs.ovr || {};
            const f = $el.attr('data-f');
            const p = $el.attr('data-p');
            const c = $el.attr('data-c');
            if (f) {
                cs.ovr[f] = '__DEL__';
            }
            if (p) {
                cs.ovr[`part:${p}`] = '__DEL__';
            }
            if (c !== undefined) {
                delete (cs.custom || {})[c];
            }
            persistEdits();
            $card.removeData('sig');
            updateCard();
        });
        /* 行内编辑保存 */
        $card.on('focusout', '[contenteditable="true"]', (e) => {
            const $el = $(e.currentTarget);
            let text = $el.text().replace(/[\r\n]+/g, ' ').trim();
            const st = getCardStore();
            const cs = st?.chars?.[st.active];
            if (!cs) {
                return;
            }
            const f = $el.attr('data-f');
            const p = $el.attr('data-p');
            const c = $el.attr('data-c');
            const sKey = $el.attr('data-stat');
            if (sKey) {
                /* 数值条直接编辑（如 “76/100” 取前一个数字） */
                const num = parseInt(text, 10);
                if (!Number.isNaN(num)) {
                    const v = Math.min(100, Math.max(0, num));
                    if (sKey === '体力') {
                        cs.stats = cs.stats || {};
                        cs.stats['体力'] = { key: '体力', cur: v, max: 100, chg: null };
                    } else {
                        const fk = { '性欲': 'desire', '怀孕几率': 'pregChance', '高潮值': 'climax', 'NTR值': 'ntr', '淫荡值': 'lewd' }[sKey];
                        if (fk) {
                            cs.fields[fk] = v + '/100';
                            cs.ovr = cs.ovr || {};
                            cs.ovr[fk] = v + '/100';
                        }
                    }
                }
                persistEdits();
                $card.removeData('sig');
                updateCard();
                return;
            }
            if (f) {
                if (f.startsWith('relv:')) {
                    const n = f.slice(5);
                    const num = parseInt(text, 10);
                    const r = cs.relations[n] || (cs.relations[n] = { val: null, note: '' });
                    r.val = Number.isNaN(num) ? null : Math.min(100, Math.max(0, num));
                    r.chg = null;
                } else if (f.startsWith('reln:')) {
                    const n = f.slice(5);
                    text = text.replace(/^💋\s*与[^：:]{1,20}[：:]\s*/, '');
                    const r = cs.relations[n] || (cs.relations[n] = { val: null, note: '' });
                    r.note = text;
                } else if (text) {
                    cs.fields[f] = text;
                    if (cs.ovr) {
                        cs.ovr[f] = text; // 手动编辑在完全重建时也保留；AI 更新到该字段时自动解除
                    }
                }
            }
            if (p && text) {
                cs.parts = cs.parts || {};
                cs.parts[p] = text;
                cs.ovr = cs.ovr || {};
                cs.ovr[`partv:${p}`] = text;
            }
            if (c !== undefined) {
                cs.custom = cs.custom || {};
                cs.custom[c] = text;
            }
            persistEdits();
            $card.removeData('sig');
            updateCard();
        });
        /* 添加条目（自定义 / 关系 / 部件） */
        $card.on('click', '.rpg-ic-addbtn', (e) => {
            e.stopPropagation();
            const $row = $(e.currentTarget).closest('.rpg-ic-addrow');
            const kind = $row.attr('data-kind') || 'custom';
            const k = String($row.find('.rpg-ic-addkey').val() || '').trim();
            const v = String($row.find('.rpg-ic-addval').val() || '').trim();
            const n = String($row.find('.rpg-ic-addnote').val() || '').trim();
            const st = getCardStore();
            const cs = st?.chars?.[st.active];
            if (!cs || !k) {
                return;
            }
            if (kind === 'rel') {
                cs.relations = cs.relations || {};
                const num = parseInt(v, 10);
                cs.relations[k] = { val: Number.isNaN(num) ? null : Math.min(100, Math.max(0, num)), note: n };
            } else if (kind === 'part') {
                if (!v) {
                    return;
                }
                cs.parts = cs.parts || {};
                cs.parts[k] = v;
            } else {
                if (!v) {
                    return;
                }
                cs.custom = cs.custom || {};
                cs.custom[k] = v;
            }
            $row.find('input').val('');
            persistEdits();
            $card.removeData('sig');
            updateCard();
        });
        $card.css('--rpg-card-w', (cfg.cardW || 252) + 'px');
    }

    /* 当前角色已被 🗑 移除：显示空态卡片（可一键恢复），避免显示一张永远不更新的空白卡 */
    if (store.hidden?.[curName]) {
        const emptyHTML = `
        <div class="rpg-ic-header" title="按住可拖动卡片">
            <div class="rpg-ic-avatar rpg-ic-avatar-fallback">—</div>
            <div class="rpg-ic-id"><div class="rpg-ic-name">人物信息卡</div></div>
            <div class="rpg-ic-controls">
                <span class="rpg-ic-wminus" title="缩小卡片">－</span>
                <span class="rpg-ic-wplus" title="扩大卡片">＋</span>
                <span class="rpg-ic-collapse" title="折叠/展开">▾</span>
            </div>
        </div>
        <div class="rpg-ic-body">
            <div class="rpg-ic-sec rpg-ic-empty-note">
                已从信息卡中移除全部角色。<br>
                <span class="menu_button rpg-ic-restoreall" title="恢复被 🗑 删除的全部角色">↩ 恢复全部角色</span>
            </div>
        </div>`;
        if ($card.data('sig') !== emptyHTML) {
            $card.html(emptyHTML);
            $card.data('sig', emptyHTML);
        }
        $card.css('--rpg-card-w', (cfg.cardW || 252) + 'px');
        return;
    }

    /* 即使数据仓为空（如刚进新聊天），也创建空白条目并显示卡片模板 */
    const cur = ensureChar(store, curName);
    if (store.auto) {
        store.locked = curName;
    }
    /* 卡片标题：剧情角色名（如 Mia/米娅）优先，否则退回角色/聊天名 */
    const displayTitle = (cur.title && String(cur.title).trim()) || curName;

    // 头像
    const chData = Array.isArray(ctx.characters)
        ? ctx.characters.find(c => c.name === curName)
        : null;
    const avatarFile = cur.avatar || chData?.avatar || null;
    const avatarHTML = avatarFile
        ? `<img class="rpg-ic-avatar" src="/characters/${encodeURI(avatarFile)}" onerror="this.outerHTML='<div class=&quot;rpg-ic-avatar rpg-ic-avatar-fallback&quot;>${esc(String(displayTitle).slice(0, 1))}</div>'">`
        : `<div class="rpg-ic-avatar rpg-ic-avatar-fallback">${esc(String(displayTitle).slice(0, 1))}</div>`;

    // 场景信息
    let sceneTime = null; let scenePlace = null; let sceneWeather = null;
    for (const cs of Object.values(store.chars)) {
        sceneTime = cs.fields._scene_time || cs.fields.time || sceneTime;
        scenePlace = cs.fields._scene_place || cs.fields.place || scenePlace;
        sceneWeather = cs.fields._scene_weather || cs.fields.weather || sceneWeather;
    }

    const rawPlayerName = String(ctx.name1 || '').trim();
    const playerName = /^user$/i.test(rawPlayerName) ? '玩家' : (rawPlayerName || '玩家');

    // 编辑覆盖层：'__DEL__' 表示该条目已被玩家删除（AI 更新到该字段时自动恢复）
    const ovr = cur.ovr || {};
    currentOvr = ovr;
    const fv = (k) => {
        if (ovr[k] === '__DEL__') {
            return null;
        }
        if (typeof ovr[k] === 'string') {
            return ovr[k];
        }
        return cur.fields[k];
    };
    sceneTime = fv('time') || sceneTime;
    scenePlace = fv('place') || scenePlace;
    sceneWeather = fv('weather') || sceneWeather;

    // 关系列表（含对玩家与其他角色）
    const relEntries = Object.entries(cur.relations).filter(([n, r]) => r && (r.val !== null && r.val !== undefined || r.note) && ovr[`rel:${n}`] !== '__DEL__');
    const relSorted = relEntries.sort((a, b) => {
        const av = a[0] === '玩家' ? 101 : (a[1].val ?? -1);
        const bv = b[0] === '玩家' ? 101 : (b[1].val ?? -1);
        return bv - av;
    }).slice(0, 6);
    const relHTML = relSorted.length
        ? relSorted.map(([n, r], i) => relationHTML(n, r, i, playerName)).join('')
        : relationHTML('玩家', { val: null, note: '' }, 0, playerName);

    // 数值状态（v1.4 只保留：体力 / 性欲 / 怀孕几率 / 高潮值；未填充时显示占位）
    const numOf = (v) => {
        const m = String(v ?? '').match(/(\d{1,3})/);
        return m ? parseInt(m[1], 10) : null;
    };
    /* v1.9h：从原始文本里取「本次变化量」标注（如（+3）） */
    const chgOf = (v) => {
        const m = String(v ?? '').match(/[（(]\s*([+\-±]\s*\d{1,3})\s*[）)]/);
        return m ? ('（' + m[1].replace(/\s+/g, '') + '）') : null;
    };
    const statList = [];
    const tili = cur.stats?.['体力'];
    statList.push({ key: '体力', cur: tili && !Number.isNaN(tili.cur) ? tili.cur : null, max: tili?.max ?? 100, color: '#3e8e5a', chg: (tili && tili.chg) || null });
    statList.push({ key: '性欲', cur: numOf(fv('desire')) ?? (cur.stats?.['性欲'] && !Number.isNaN(cur.stats['性欲'].cur) ? cur.stats['性欲'].cur : null), max: 100, color: '#c2608a', chg: chgOf(fv('desire')) });
    statList.push({ key: '怀孕几率', cur: numOf(fv('pregChance')), max: 100, color: '#d07090', chg: chgOf(fv('pregChance')) });
    statList.push({ key: '高潮值', cur: numOf(fv('climax')), max: 100, color: '#b06ad0', chg: chgOf(fv('climax')) });
    statList.push({ key: 'NTR值', cur: numOf(fv('ntr')), max: 100, color: '#9a6ad0', chg: chgOf(fv('ntr')) });
    statList.push({ key: '淫荡值', cur: numOf(fv('lewd')), max: 100, color: '#d0785a', chg: chgOf(fv('lewd')) });
    statList.push({ key: '敏感度', cur: numOf(fv('sensitivity')), max: 100, color: '#8fbf9a', chg: chgOf(fv('sensitivity')) });
    /* 被编辑删除的数值不显示 */
    const statFinal = statList.filter(st => (cur.ovr || {})[`stat:${st.key}`] !== '__DEL__');

    // 分件（过滤已删除项；应用编辑覆盖）
    const partsAll = Object.fromEntries(Object.entries(cur.parts || {})
        .filter(([k]) => ovr[`part:${k}`] !== '__DEL__')
        .map(([k, v]) => [k, ovr[`partv:${k}`] ?? v]));
    const { outfit: outfitParts, body: bodyParts } = splitParts(partsAll);

    // 固定分件模板（未填充显示占位；被删除的键不显示）
    const outfitList = [];
    for (const k of STD_OUTFIT_PARTS) {
        if (ovr[`part:${k}`] !== '__DEL__') {
            outfitList.push([k, partsAll[k] || '—']);
        }
    }
    for (const [k, v] of outfitParts) {
        if (!STD_OUTFIT_PARTS.includes(k)) {
            outfitList.push([k, v]);
        }
    }
    const bodyList = [];
    for (const k of STD_BODY_PARTS) {
        if (ovr[`part:${k}`] !== '__DEL__') {
            bodyList.push([k, partsAll[k] || '—']);
        }
    }
    for (const [k, v] of bodyParts) {
        if (!STD_BODY_PARTS.includes(k)) {
            bodyList.push([k, v]);
        }
    }

    /* v2.0.5：布局提前计算（怀孕行需按模板是否含独立「排卵/受精」「生物学父亲」行决定是否合并） */
    const layoutSrc = (cfg.cardTemplate && String(cfg.cardTemplate).trim()) ? cfg.cardTemplate : DEFAULT_CARD_TEMPLATE;
    const layout = buildLayoutFromTemplate(layoutSrc);
    const layoutCanonSet = new Set();
    for (const sec of layout) {
        for (const row of sec.rows) {
            if (row.canon) { layoutCanonSet.add(row.canon); }
        }
    }

    // 怀孕行（模板含独立行时各自显示；旧模板自动合并排卵/受精与生物学父亲）
    const pregText = [
        fv('pregnant'),
        (!layoutCanonSet.has('ovulation') && fv('ovulation')) ? `排卵/受精：${fv('ovulation')}` : null,
        (!layoutCanonSet.has('bioFather') && fv('bioFather')) ? `生物学父亲：${fv('bioFather')}` : null,
    ].filter(Boolean).join(' ｜ ');

    // 生理区（固定模板：未填充时显示占位）
    const physHTML = [
        fieldRowHTML('fa-bed', '性频率', fv('sexFreq'), 'sexFreq', 'sexFreq', true),
        fieldRowHTML('fa-baby', '怀孕状态', pregText, 'pregnant', 'pregnant', true),
        fieldRowHTML('fa-droplet', '阴道状况', fv('vagina'), 'vagina', 'vagina', true),
        fieldRowHTML('fa-moon', '肛门状况', fv('anus'), 'anus', 'anus', true),
        fieldRowHTML('fa-heart', '乳房状况', fv('breast'), 'breast', 'breast', true),
        fieldRowHTML('fa-hand-sparkles', '敏感度', fv('sensitivity'), 'sensitivity', 'sensitivity', true),
        fieldRowHTML('fa-vial', '精液量', fv('semen'), 'semen', 'semen', true),
        fieldRowHTML('fa-leaf', '体味', fv('bodyOdor'), 'bodyOdor', 'bodyOdor', true),
        fieldRowHTML('fa-pills', '药物', fv('drugs'), 'drugs', 'drugs', true),
        fieldRowHTML('fa-brain', '精神', fv('mental'), 'mental', 'mental', true),
    ].join('');

    // 性行为记录（本次 / 上次）
    const sexHTML = [
        fieldRowHTML('fa-person-half-dress', '本次姿势', fv('curPose'), 'curPose', 'curPose', true),
        fieldRowHTML('fa-ruler-horizontal', '插入深度', fv('depth'), 'depth', 'depth', true),
        fieldRowHTML('fa-star', '本次满意度', fv('satisfy'), 'satisfy', 'satisfy', true),
        fieldRowHTML('fa-clock-rotate-left', '上次姿势', fv('lastPoses'), 'lastPoses', 'lastPoses', true),
        fieldRowHTML('fa-droplet-slash', '上次射精次数', fv('lastCum'), 'lastCum', 'lastCum', true),
        fieldRowHTML('fa-heart-crack', '上次高潮次数', fv('lastOrgasm'), 'lastOrgasm', 'lastOrgasm', true),
        fieldRowHTML('fa-comment-dots', '上次评价', fv('lastReview'), 'lastReview', 'lastReview', true),
    ].join('');

    const idxInfo = `${Math.max(1, chars.indexOf(curName) + 1)}/${Math.max(1, chars.length)}`;
    const nowFull = fmtFull(new Date());

    /* ═══ v1.7：表格化布局（由「卡片模板」驱动；设置面板可自由编辑显示内容与条目） ═══ */
    /* v2.0.5：layoutSrc / layout / layoutCanonSet 已在本函数上方「怀孕行」处提前计算 */
    const coveredCustom = new Set();
    const seenSpecial = { rel: false, partsOutfit: false, partsBody: false, cg: false };
    const statByKey = Object.fromEntries(statFinal.map(s => [s.key, s]));

    const tdKey = (t) => `<td class="k">${esc(t)}</td>`;
    const tdVal = (t, attrs, empty) => `<td class="v" colspan="3"><span class="rpg-ic-val${empty ? ' rpg-ic-empty' : ''}"${attrs || ''}>${esc(t)}</span></td>`;
    const xCell = (inner) => `<td class="x">${inner || ''}</td>`;

    /* v1.9：字段 → 单元格对象（供两列紧凑排布）；自定义字段键做归一化，修复「🧠 精神」等带符号标签取不到值的问题 */
    const klKey = (s) => String(s || '').replace(/^[^一-龥A-Za-z0-9]+/, '').trim();
    const customGet = (label) => {
        const cc = cur.custom || {};
        if (cc[label] !== undefined && cc[label] !== null && cc[label] !== '') { return cc[label]; }
        const ck = klKey(label);
        if (cc[ck] !== undefined && cc[ck] !== null && cc[ck] !== '') { return cc[ck]; }
        return label === '人物' ? displayTitle : null;
    };
    const SHORT_CELL_MAX = 22;

    const fieldCell = (label, canon) => {
        if (canon && ovr[canon] === '__DEL__') {
            coveredCustom.add(klKey(label));
            return null;
        }
        if ((cfg.hideFields || []).includes(label)) {
            return null;
        }
        let val = canon ? fv(canon) : null;
        if (canon === 'pregnant') {
            val = pregText;
        }
        if (!canon) {
            val = customGet(label);
            coveredCustom.add(klKey(label));
        } else if (val === null || val === undefined || val === '') {
            /* v1.9：canon 字段无值时回退到自定义区（兼容旧版本把「精神」等字段存进 custom 的历史数据） */
            const cc = cur.custom || {};
            if (cc[label] !== undefined && cc[label] !== null && cc[label] !== '') { val = cc[label]; }
            else {
                const ck = klKey(label);
                if (cc[ck] !== undefined && cc[ck] !== null && cc[ck] !== '') { val = cc[ck]; }
            }
        }
        const has = val !== null && val !== undefined && val !== '';
        const key = canon ? canon : klKey(label);
        const attrs = cfg.cardEdit
            ? (canon
                ? ` data-f="${esc(canon)}" contenteditable="true" spellcheck="false"`
                : ` data-c="${esc(key)}" contenteditable="true" spellcheck="false"`)
            : '';
        const del = cfg.cardEdit
            ? (canon
                ? `<span class="rpg-ic-del" data-f="${esc(canon)}" title="删除该条目">×</span>`
                : `<span class="rpg-ic-del" data-c="${esc(key)}" title="删除该条目">×</span>`)
            : '';
        const shown = has ? String(val) : '—';
        const cleanGrp = klKey(label);
        const grp = /^上次/.test(cleanGrp) ? 'prev' : (/^本次/.test(cleanGrp) ? 'cur' : '');
        return {
            k: label,
            inner: `<span class="rpg-ic-val${has ? '' : ' rpg-ic-empty'}"${attrs}>${esc(shown)}</span>${del}`,
            len: has ? shown.length : 0,
            stat: false,
            empty: !has,
            grp: grp,
            forced: label === '人物',
        };
    };

    const buildRelRows = () => {
        let html = '';
        /* 实时切换：玩家关系永远显示；非玩家NPC只在“最近 3 条消息内被更新过”时显示（场景切换后旧NPC自动隐去；没有NPC则只剩玩家） */
        const latestIdx = Array.isArray(ctx.chat) ? ctx.chat.length - 1 : 0;
        const isPlayerRel = (n) => n === '玩家' || (playerName && n === playerName);
        /* v1.9i：常驻 = 玩家 + 一位最重要的NTR角色（最近更新优先、好感次之）；其他角色仅在最近一楼仍被更新时显示，离开/不再重要立即隐藏 */
        const npcAll = relSorted.filter(([n]) => !isPlayerRel(n));
        let primaryNpc = null;
        for (const [n, r] of npcAll) {
            if (!primaryNpc) {
                primaryNpc = [n, r];
                continue;
            }
            const rmA = (cur.relMsg || {})[n];
            const rmB = (cur.relMsg || {})[primaryNpc[0]];
            const a = (rmA === undefined) ? -1 : rmA;
            const b = (rmB === undefined) ? -1 : rmB;
            const vA = (r && r.val !== null && r.val !== undefined) ? r.val : -1;
            const vB = (primaryNpc[1] && primaryNpc[1].val !== null && primaryNpc[1].val !== undefined) ? primaryNpc[1].val : -1;
            if (a > b || (a === b && vA > vB)) {
                primaryNpc = [n, r];
            }
        }
        const fresh = relSorted.filter(([n, r]) => {
            if (isPlayerRel(n)) {
                return true;
            }
            if (primaryNpc && n === primaryNpc[0]) {
                return true;
            }
            const rm = (cur.relMsg || {})[n];
            return rm !== undefined && rm >= latestIdx - 1;
        });
        const players = fresh.filter(([n]) => isPlayerRel(n));
        const npcs = fresh.filter(([n]) => !isPlayerRel(n)).sort((x, y) => {
            if (primaryNpc && x[0] === primaryNpc[0]) { return -1; }
            if (primaryNpc && y[0] === primaryNpc[0]) { return 1; }
            const xv = (x[1] && x[1].val !== null && x[1].val !== undefined) ? x[1].val : -1;
            const yv = (y[1] && y[1].val !== null && y[1].val !== undefined) ? y[1].val : -1;
            return yv - xv;
        });
        const renderOne = ([n, r], i) => {
            const label = isPlayerRel(n) ? playerName : n;
            const color = RELATION_COLORS[i % RELATION_COLORS.length];
            if (r.val !== null && r.val !== undefined) {
                const bar = `<span class="rpg-sb-track rpg-ic-track"><span class="rpg-sb-fill" style="width:${r.val}%;background:linear-gradient(90deg, ${color}88, ${color})"></span></span>`;
                const attrs = cfg.cardEdit ? ` data-f="relv:${esc(n)}" contenteditable="true" spellcheck="false"` : '';
                /* v1.9e：非玩家男人 → 追加与玩家好感度的直接对比（比你±N / 与你持平） */
                let cmp = '';
                if (!isPlayerRel(n)) {
                    const pv = players.length ? players[0][1].val : null;
                    if (pv !== null && pv !== undefined) {
                        const d = r.val - pv;
                        const cls = d > 0 ? 'up' : (d < 0 ? 'neg' : 'eq');
                        const txt = d === 0 ? '与你持平' : ('比你' + (d > 0 ? '+' : '') + d);
                        cmp = `<span class="rpg-ic-rel-cmp ${cls}">（${txt}）</span>`;
                    }
                }
                const rChg = r.chg ? String(r.chg) : '';
                const rChgCls = /\+/.test(rChg) ? 'up' : (/-/.test(rChg) ? 'down' : 'zero');
                const rChgHTML = rChg ? ` <span class="rpg-ic-chgv rpg-chg-${rChgCls}">${esc(rChg)}</span>` : '';
                html += `<tr>${tdKey('💗 对' + label + '好感度')}<td class="v" colspan="3">${bar} <span class="rpg-ic-val"${attrs}>${r.val}/100</span>${rChgHTML}${cmp}${cfg.cardEdit ? `<span class="rpg-ic-del" data-f="rel:${esc(n)}" title="删除该关系">×</span>` : ''}</td></tr>`;
            }
            if (r.note || cfg.cardEdit) {
                const attrs2 = cfg.cardEdit ? ` data-f="reln:${esc(n)}" contenteditable="true" spellcheck="false"` : '';
                html += `<tr>${tdKey('💋 与' + label + '关系')}${tdVal(r.note || '—', attrs2, !r.note)}${xCell('')}</tr>`;
            }
        };
        if (players.length) {
            players.forEach(renderOne);
        } else {
            html += `<tr>${tdKey('💗 好感度')}${tdVal('—', '', true)}${xCell('')}</tr>`;
        }
        if (npcs.length) {
            /* 当前与女主在一起/接触的男人们：出现即实时更新姓名与关系 */
            npcs.forEach(renderOne);
        } else {
            /* 女主身边暂无其他男人 → 显示 ？？？；出现后会自动替换为真名与关系 */
            html += `<tr>${tdKey('💗 对？？？的好感度')}${tdVal('？？？', '', false)}${xCell('')}</tr>`;
            html += `<tr>${tdKey('💋 与？？？的关系')}${tdVal('？？？', '', false)}${xCell('')}</tr>`;
        }
        if (cfg.cardEdit) {
            html += '<tr><td colspan="3"><div class="rpg-ic-addrow" data-kind="rel"><input class="text_pole rpg-ic-addkey" placeholder="角色名" maxlength="12"><input class="text_pole rpg-ic-addval" placeholder="好感0-100" maxlength="3"><input class="text_pole rpg-ic-addnote" placeholder="关系描述" maxlength="60"><span class="menu_button rpg-ic-addbtn">＋关系</span></div></td></tr>';
        }
        return html;
    };

    const statCell = (label) => {
        const clean = String(label || '').replace(/^[^一-龥A-Za-z0-9]+/, '').trim();
        const key = STAT_ROW_MAP[clean];
        if (!key || ovr[`stat:${key}`] === '__DEL__' || (cfg.hideFields || []).includes(key)) {
            return null;
        }
        const s = statByKey[key];
        const curV = s && s.cur !== null && s.cur !== undefined && !Number.isNaN(s.cur) ? s.cur : null;
        const has = curV !== null;
        const pct = has ? Math.max(0, Math.min(100, curV)) : 0;
        const color = s ? s.color : '#a882dc';
        const bar = `<span class="rpg-sb-track rpg-ic-track"><span class="rpg-sb-fill" style="width:${pct}%;background:linear-gradient(90deg, ${color}88, ${color})"></span></span>`;
        const attrs = cfg.cardEdit ? ` data-stat="${esc(key)}" contenteditable="true" spellcheck="false"` : '';
        const del = cfg.cardEdit ? `<span class="rpg-ic-del" data-f="stat:${esc(key)}" title="删除该数值">×</span>` : '';
        const chgTxt = (s && s.chg) ? String(s.chg) : '';
        const chgCls = /\+/.test(chgTxt) ? 'up' : (/-/.test(chgTxt) ? 'down' : 'zero');
        const chgHTML = chgTxt ? ` <span class="rpg-ic-chgv rpg-chg-${chgCls}">${esc(chgTxt)}</span>` : '';
        return {
            k: clean,
            inner: `${bar} <span class="rpg-ic-val${has ? '' : ' rpg-ic-empty'}"${attrs}>${has ? curV + '/100' : '—'}</span>${chgHTML}${del}`,
            len: 0,
            stat: true,
            grp: '',
            forced: false,
        };
    };

    const buildPartsRows = (list) => {
        const items = (list || []).filter(([k]) => !(cfg.hideFields || []).includes(k));
        let html = '';
        for (let i = 0; i < items.length; i += 2) {
            html += '<tr>';
            for (let j = 0; j < 2; j++) {
                const it = items[i + j];
                if (it) {
                    const [k, v] = it;
                    const has = v && v !== '—';
                    const attrs = cfg.cardEdit ? ` data-p="${esc(k)}" contenteditable="true" spellcheck="false"` : '';
                    const del = cfg.cardEdit ? `<span class="rpg-ic-del" data-p="${esc(k)}" title="删除该部件">×</span>` : '';
                    html += `${tdKey(k)}<td class="v"><span class="rpg-ic-val${has ? '' : ' rpg-ic-empty'}"${attrs}>${esc(has ? v : '—')}</span>${del}</td>`;
                } else {
                    html += '<td class="k"></td><td class="v"></td>';
                }
            }
            if (i + 1 >= items.length) {
                html += '<td class="k"></td><td class="v"></td>';
            }
            html += '</tr>';
        }
        if (cfg.cardEdit) {
            html += '<tr><td colspan="4"><div class="rpg-ic-addrow" data-kind="part"><input class="text_pole rpg-ic-addkey" placeholder="部位/衣物名" maxlength="12"><input class="text_pole rpg-ic-addval" placeholder="内容" maxlength="80"><span class="menu_button rpg-ic-addbtn">＋部件</span></div></td></tr>';
        }
        return html;
    };

    const cgCell = () => {
        const has = !!(fv('cg') || fv('pov'));
        const attrs = cfg.cardEdit ? ' data-f="cg" contenteditable="true" spellcheck="false"' : '';
        return `<tr><td class="v rpg-ic-cg-cell" colspan="4"><div class="rpg-ic-cg${has ? '' : ' rpg-ic-empty'}"${attrs}>${esc(fv('cg') || fv('pov') || '—')}</div></td></tr>`;
    };

    /* v1.9：流水线式两列打包 —— 短值字段自动成对（中间竖线分隔），长值整排；分区为边界 */
    const singleRow = (c) => `<tr${c.grp === 'prev' ? ' class="rpg-ic-trprev"' : ''}><td class="k">${esc(c.k)}</td><td class="v" colspan="3">${c.inner}</td></tr>`;
    const doubleRow = (a, b) => `<tr${(a.grp === 'prev' || b.grp === 'prev') ? ' class="rpg-ic-trprev"' : ''}><td class="k">${esc(a.k)}</td><td class="v">${a.inner}</td><td class="k">${esc(b.k)}</td><td class="v">${b.inner}</td></tr>`;
    let bodyHTML = '';
    const headerBadges = [];
    for (const sec of layout) {
        /* v1.9b：『基本信息』区不上正文 —— 其字段转移到头像后方，以标签展示 */
        if ((sec.title || '').includes('基本信息')) {
            for (const row of sec.rows) {
                if (row.label === '人物') { continue; }
                const c = fieldCell(row.label, row.canon);
                if (!c) { continue; }
                headerBadges.push(c);
            }
            continue;
        }
        let rows = '';
        let pairBuf = [];
        const flushPair = () => {
            if (!pairBuf.length) { return; }
            if (pairBuf.length === 1) { rows += singleRow(pairBuf[0]); } else { rows += doubleRow(pairBuf[0], pairBuf[1]); }
            pairBuf = [];
        };
        for (const row of sec.rows) {
            if (row.type === 'rel') {
                if (seenSpecial.rel) { continue; }
                seenSpecial.rel = true;
                flushPair();
                rows += buildRelRows();
            } else if (row.type === 'partsOutfit' || row.type === 'partsBody') {
                if (seenSpecial[row.type]) { continue; }
                seenSpecial[row.type] = true;
                flushPair();
                rows += buildPartsRows(row.type === 'partsOutfit' ? outfitList : bodyList);
            } else if (row.type === 'cg') {
                if (seenSpecial.cg) { continue; }
                seenSpecial.cg = true;
                flushPair();
                rows += cgCell();
            } else {
                const c = (row.type === 'stat') ? statCell(row.label) : fieldCell(row.label, row.canon);
                if (!c) { continue; }
                if (c.forced || (!c.stat && c.len > SHORT_CELL_MAX)) {
                    flushPair();
                    rows += singleRow(c);
                } else {
                    /* v1.9c：本次 / 上次 分组不混合成对 */
                    if (pairBuf.length === 1 && (pairBuf[0].grp || '') !== (c.grp || '')) {
                        flushPair();
                    }
                    pairBuf.push(c);
                    if (pairBuf.length === 2) { flushPair(); }
                }
            }
        }
        flushPair();
        if (rows) {
            bodyHTML += `<div class="rpg-ic-sec">${sec.title ? `<div class="rpg-ic-sec-title">${esc(sec.title)}</div>` : ''}<table class="rpg-ic-table"><colgroup><col class="cg-k"><col class="cg-v"><col class="cg-k"><col class="cg-v"></colgroup>${rows}</table></div>`;
        }
    }
    bodyHTML += cfg.cardEdit ? '<div class="rpg-ic-editbar"><span class="menu_button rpg-ic-save">💾 保存</span><span class="menu_button rpg-ic-cancel">✕ 取消</span><span class="rpg-ic-edit-hint">编辑中：点条目改值 · × 删除 · ＋添加 · 完成后点保存</span></div>' : '';

    // 更新对比缓存（用于变化高亮）
    lastRenderCache = {
        scene_time: sceneTime, scene_place: scenePlace, scene_weather: sceneWeather,
        outfit: fv('outfit'), body: fv('body'), mood: fv('mood'), emotion: fv('emotion'),
        pregnant: pregText, mental: fv('mental'), behavior: fv('behavior'),
        posture: fv('posture'), pov: fv('cg') || fv('pov'), money: fv('money'),
        sexFreq: fv('sexFreq'), favPenis: fv('favPenis'), vagina: fv('vagina'), anus: fv('anus'),
        semen: fv('semen'), bodyOdor: fv('bodyOdor'), drugs: fv('drugs'),
        items: fv('items'), makeup: fv('makeup'), breast: fv('breast'), sensitivity: fv('sensitivity'),
        curPose: fv('curPose'), depth: fv('depth'), satisfy: fv('satisfy'),
        lastPoses: fv('lastPoses'), lastCum: fv('lastCum'), lastOrgasm: fv('lastOrgasm'), lastReview: fv('lastReview'),
    };

    const badgesHTML = headerBadges
        .filter(c => cfg.cardEdit || !c.empty)
        .map(c => `<span class="rpg-ic-badge"><i>${esc(c.k)}</i>：${c.inner}</span>`)
        .join('');
    const html = `
        <div class="rpg-ic-header rpg-ic-header-v2" title="按住可拖动卡片">
            <div class="rpg-ic-titlerow">
                <div class="rpg-ic-name">${esc(displayTitle)}</div>
                <div class="rpg-ic-controls">
                ${!store.auto ? `<span class="rpg-ic-auto" title="恢复自动跟随">自动</span>` : ''}
                <span class="rpg-ic-edit ${cfg.cardEdit ? 'active' : ''}" title="修改信息：进入全卡编辑（可改值/删除/添加），改完点💾保存">✎</span>
                <span class="rpg-ic-fill" title="✨ 按角色卡与上下文推演补全全部信息">✨</span>
                <span class="rpg-ic-drop" title="删除该角色（从信息卡移除；可在扩展设置中恢复）">🗑</span>
                <span class="rpg-ic-reset" title="重置该角色信息为空白（之后的剧情再重新填写）">↺</span>
                <span class="rpg-ic-prev" title="上一位角色">◀</span>
                <span class="rpg-ic-ctrl-idx">${idxInfo}</span>
                <span class="rpg-ic-next" title="下一位角色">▶</span>
                <span class="rpg-ic-wminus" title="缩小卡片">－</span>
                <span class="rpg-ic-wplus" title="扩大卡片">＋</span>
                <span class="rpg-ic-collapse" title="折叠/展开">▾</span>
                </div>
            </div>
            <div class="rpg-ic-mainrow">
                ${avatarHTML}
                <div class="rpg-ic-id">
                    ${badgesHTML ? `<div class="rpg-ic-badges">${badgesHTML}</div>` : ''}
                </div>
            </div>
        </div>
        <div class="rpg-ic-body">${bodyHTML}</div>
        <div class="rpg-ic-foot"><span>${store.auto ? '自动跟随' : '手动查看'}</span><span>${esc(nowFull)}</span></div>`;

    if ($card.data('sig') !== html) {
        $card.html(html);
        $card.data('sig', html);
    }
    try { syncPrevCardPrompt(); } catch (err0b) { /* 忽略 */ }
}

/* ── 拖动 ── */
function makeDraggable($card) {
    let dragging = false;
    let startX = 0; let startY = 0; let startL = 0; let startT = 0;

    const onMove = (e) => {
        if (!dragging) {
            return;
        }
        const w = Math.min($card.outerWidth() || 252, window.innerWidth);
        let nl = startL + (e.clientX - startX);
        let nt = startT + (e.clientY - startY);
        nl = Math.min(Math.max(0, nl), Math.max(0, window.innerWidth - w));
        nt = Math.min(Math.max(0, nt), Math.max(0, window.innerHeight - 46));
        $card.css({ left: nl + 'px', top: nt + 'px' });
    };
    const onUp = () => {
        if (!dragging) {
            return;
        }
        dragging = false;
        $card.removeClass('rpg-ic-dragging');
        $(document).off('.rpgicdrag');
        const rect = $card[0].getBoundingClientRect();
        cfg.cardPos = { left: Math.round(rect.left), top: Math.round(rect.top) };
        save();
    };

    $card.on('pointerdown', '.rpg-ic-header', function (e) {
        if ($(e.target).closest('.rpg-ic-controls').length) {
            return;
        }
        if (e.button !== 0) {
            return;
        }
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = $card[0].getBoundingClientRect();
        startL = rect.left;
        startT = rect.top;
        $card.css({ left: startL + 'px', top: startT + 'px', right: 'auto', bottom: 'auto' });
        $card.addClass('rpg-ic-dragging');
        e.preventDefault();
        $(document).on('pointermove.rpgicdrag', onMove).on('pointerup.rpgicdrag', onUp).on('pointercancel.rpgicdrag', onUp);
    });
}

/* ✨ 按角色卡与上下文推演补全（生成一条隐藏的状态栏，用于给信息卡填充数据） */
async function requestFill() {
    const ctx = getContext();
    const st = getCardStore();
    const name = st?.active || ctx.name2 || '角色';
    const ooc = `《系统任务：纯数据推演——这不是剧情回合。请依据角色卡设定、世界观与当前聊天上下文，为角色「${name}」推演并补全她的完整信息：出身经历、习惯癖好、身体细节状态、衣物与随身之物、与身边人的关系与好感、当下心情与目标。 【输出铁律】你的整条回复只能是【状态栏】数据块本身：从「【状态栏】」开头，到最后一个字段结束；不得写任何正文、旁白、剧情、对话或动作描写（不要使用引号或星号）；不得推进剧情；不得代替任何人说话。玩家不会看到这段文字，它只是后台数据。》`;
    try {
        ctx.setExtensionPrompt('RPG_UI_FILL', ooc, 1, 1, false, 0, false);
    } catch (err) {
        console.warn('[RPG-UI] 补全注入失败', err);
    }
    let done = false;
    try {
        /* v1.9d：静默生成——不写入聊天，仅取回文本，自己解析后只更新当前角色信息卡 */
        const reply = await ctx.generate('quiet');
        let text = '';
        if (typeof reply === 'string') {
            text = reply;
        } else if (reply && typeof reply === 'object') {
            text = String(reply.content ?? reply.text ?? reply.mes ?? '');
        }
        const parsed = parseBlock(text);
        if (parsed && st) {
            mergeIntoStore(st, name, parsed, Array.isArray(ctx.chat) ? ctx.chat.length : undefined);
            persistCard();
            $('#rpg-info-card').removeData('sig');
            updateCard();
            done = true;
            if (typeof toastr !== 'undefined') {
                toastr.info('已按上下文推演并补全「' + name + '」的信息卡');
            }
        }
    } catch (err) {
        console.warn('[RPG-UI] 静默补全失败', err);
    } finally {
        try {
            ctx.setExtensionPrompt('RPG_UI_FILL', '', 1, 1, false, 0, false);
        } catch (err3) { /* 忽略 */ }
    }
    if (!done) {
        /* 兜底：静默模式不可用时，退回常规触发（会写入一条回复） */
        try {
            await ctx.executeSlashCommandsWithOptions('/trigger');
        } catch (err2) {
            if (typeof toastr !== 'undefined') {
                toastr.warning('推演补全失败，请稍后重试');
            }
        }
    }
}

function cycleChar(dir) {
    const store = getCardStore();
    if (!store) {
        return;
    }
    const chars = sortChars(store);
    if (chars.length < 2) {
        return;
    }
    let idx = chars.indexOf(store.active);
    if (idx === -1) {
        idx = 0;
    }
    idx = (idx + dir + chars.length) % chars.length;
    store.active = chars[idx];
    store.locked = chars[idx];
    store.auto = false;
    manualOverride = true;
    persistCard();
    updateCard();
}

/* ═══════════════════ 每楼状态小条（旧版，可选） ═══════════════════ */
function buildStripHTML(mes, id) {
    const isUser = !!mes.is_user;
    const len = String(mes.mes || '').replace(/\s/g, '').length;
    const whoName = mes.name || (isUser ? '你' : '旁白');
    const segs = [
        `<span class="rpg-sb-seg rpg-sb-who ${isUser ? 'is-user' : 'is-char'}"><i class="fa-solid ${isUser ? 'fa-user' : 'fa-scroll'}"></i>${esc(whoName)}</span>`,
        `<span class="rpg-sb-seg"><i class="fa-solid fa-clock"></i>${esc(fmtTime(mes.send_date))}</span>`,
        `<span class="rpg-sb-seg rpg-sb-floor"><i class="fa-solid fa-layer-group"></i>#${id}</span>`,
        `<span class="rpg-sb-seg rpg-sb-len"><i class="fa-solid fa-pen-nib"></i>${len} 字</span>`,
    ];
    const stats = buildStatsHTML(parseStats(mes.mes));
    return `<div class="rpg-sb-left">${segs.join('')}</div>`
        + (stats ? `<div class="rpg-sb-stats">${stats}</div>` : '');
}

function removeStrip(id) {
    $(`#chat .mes[mesid="${id}"] .rpg-statusbar`).remove();
}

function processMessage(id) {
    if (!cfg.enabled || !cfg.strips) {
        removeStrip(id);
        return;
    }
    const $mes = $(`#chat .mes[mesid="${id}"]`);
    if (!$mes.length) {
        return;
    }
    const context = getContext();
    const mes = context.chat?.[id];
    if (!mes || mes.is_system) {
        removeStrip(id);
        return;
    }
    if (mes.is_user && !cfg.onUser) {
        removeStrip(id);
        return;
    }

    const $block = $mes.find('.mes_block');
    if (!$block.length) {
        return;
    }

    let $bar = $block.children('.rpg-statusbar');
    if (!$bar.length) {
        $bar = $('<div class="rpg-statusbar" data-rpg="1"></div>');
        const $bias = $block.children('.mes_bias');
        if ($bias.length) {
            $bias.before($bar);
        } else {
            $block.append($bar);
        }
    }
    $bar.toggleClass('rpg-compact', !!cfg.compact);
    const html = buildStripHTML(mes, id);
    if ($bar.data('sig') !== html) {
        $bar.html(html);
        $bar.data('sig', html);
    }
}

function processAll() {
    if (!cfg.enabled || !cfg.strips) {
        $('#chat .rpg-statusbar').remove();
    } else {
        $('#chat .mes').each(function () {
            const id = Number($(this).attr('mesid'));
            if (!Number.isNaN(id)) {
                processMessage(id);
            }
        });
    }
    updateHud();
    updateCard();
}

/* ═══════════════════ 冒险手记横幅（可选） ═══════════════════ */
function ensureHud() {
    if (!cfg.enabled || !cfg.hudEnabled) {
        $('#rpg-scene-hud').remove();
        return null;
    }
    let $hud = $('#rpg-scene-hud');
    if (!$hud.length) {
        const $chat = $('#chat');
        if (!$chat.length) {
            return null;
        }
        $hud = $('<div id="rpg-scene-hud" class="rpg-scene-hud" data-rpg="1" title="冒险状态（点击折叠 / 展开）"></div>');
        $chat.prepend($hud);
        $hud.on('click', () => $hud.toggleClass('rpg-hud-folded'));
    }
    return $hud;
}

function updateHud() {
    const $hud = ensureHud();
    if (!$hud) {
        return;
    }
    const context = getContext();
    const hasCharacter = (context.characterId !== undefined && context.characterId !== null && context.characterId !== '')
        || !!context.groupId;
    if (!hasCharacter) {
        $hud.remove();
        return;
    }
    const chat = Array.isArray(context.chat) ? context.chat : [];
    let last = null;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m || m.is_system || m.is_user) {
            continue;
        }
        last = m;
        break;
    }
    let chatName = '当前冒险';
    try {
        chatName = context.getCurrentChatId?.() || context.chatId || chatName;
    } catch (err) { /* 忽略 */ }

    const lastTime = last ? fmtTime(last.send_date) : '';
    const lastName = last?.name || '';
    const stats = last ? buildStatsHTML(parseStats(last.mes)) : '';

    const html = `
        <span class="rpg-hud-title"><i class="fa-solid fa-shield-halved"></i> 冒险手记</span>
        <span class="rpg-hud-chat">${esc(chatName)}</span>
        <span class="rpg-hud-meta">
            <span><i class="fa-solid fa-layer-group"></i>${chat.length} 楼</span>
            ${lastTime ? `<span><i class="fa-solid fa-clock"></i>${esc(lastTime)}</span>` : ''}
            ${lastName ? `<span><i class="fa-solid fa-scroll"></i>${esc(lastName)}</span>` : ''}
        </span>
        ${stats ? `<span class="rpg-hud-stats">${stats}</span>` : ''}
    `;
    if ($hud.data('sig') !== html) {
        $hud.html(html);
        $hud.data('sig', html);
    }
}

/* ═══════════════════ RPG 视觉守护 ═══════════════════ */
const GUARD_THEME = 'RPG 冒险者酒馆';
const GUARD_BG_NAME = 'cityscape medieval night.jpg';
const GUARD_BG_URL = 'url("backgrounds/cityscape medieval night.jpg")';
const GUARD_COLORS = {
    main_text_color: 'rgba(238, 228, 204, 1)',
    italics_text_color: 'rgba(205, 184, 145, 1)',
    underline_text_color: 'rgba(232, 198, 118, 1)',
    quote_text_color: 'rgba(226, 178, 88, 1)',
    blur_tint_color: 'rgba(24, 19, 14, 0.92)',
    chat_tint_color: 'rgba(12, 10, 8, 0.72)',
    user_mes_blur_tint_color: 'rgba(96, 70, 36, 0.55)',
    bot_mes_blur_tint_color: 'rgba(28, 23, 16, 0.80)',
    shadow_color: 'rgba(0, 0, 0, 0.6)',
    border_color: 'rgba(216, 178, 92, 0.45)',
};

async function visualGuard() {
    if (!cfg.visualGuard) {
        return;
    }
    try {
        /* v1.9f：隐藏状态栏已内置到人物信息卡（显示钩子）——清理酒馆「正则」扩展里的旧 RPG 条目 */
        if (Array.isArray(extension_settings.regex)) {
            let rxRemoved = 0;
            for (let i = extension_settings.regex.length - 1; i >= 0; i--) {
                const r = extension_settings.regex[i];
                const name = r && typeof r.scriptName === 'string' ? r.scriptName : '';
                const rid = r && typeof r.id === 'string' ? r.id : '';
                if (name.startsWith('RPG隐藏') || name.startsWith('RPG剥离') || rid.startsWith('rpg-ui-fix-')) {
                    extension_settings.regex.splice(i, 1);
                    rxRemoved++;
                }
            }
            if (rxRemoved) {
                console.info('[RPG-UI] 已从酒馆正则扩展移除 RPG 条目', rxRemoved, '条（隐藏状态栏已内置到人物信息卡）');
                try { await saveSettings(); } catch (err6) { save(); }
            }
        }
        if (!power_user || power_user.theme !== GUARD_THEME) {
            return;
        }
        const drift = [];
        if (power_user.avatar_style !== 2) {
            power_user.avatar_style = 2;
            drift.push('avatar_style');
        }
        for (const [key, value] of Object.entries(GUARD_COLORS)) {
            if (power_user[key] !== value) {
                power_user[key] = value;
                drift.push(key);
            }
        }
        /* v2.0.2：仅在"用户未设置任何背景"时才补默认守护背景；手动设置的背景永不接管 */
        if (background_settings && !background_settings.url && !background_settings.name) {
            background_settings.name = GUARD_BG_NAME;
            background_settings.url = GUARD_BG_URL;
            background_settings.fitting = 'cover';
            drift.push('background');
        }
        if (drift.length) {
            console.warn('[RPG-UI] 检测到界面设置被覆盖，正在恢复 RPG 视觉：', drift.join(', '));
            if (drift.includes('background')) {
                try {
                    $('#bg1').css('background-image', GUARD_BG_URL);
                    $('#bg1').removeClass('cover contain stretch center').addClass('cover');
                } catch (err2) { /* 忽略 */ }
            }
            try {
                await saveSettings();
            } catch (err3) {
                save();
            }
        }
        const needReload = drift.some(d => d !== 'background');
        if (needReload) {
            const last = Number(sessionStorage.getItem('rpg_guard_ts') || 0);
            if (Date.now() - last > 20000) {
                sessionStorage.setItem('rpg_guard_ts', String(Date.now()));
                setTimeout(() => location.reload(), 1500);
            }
        }
    } catch (err) {
        console.warn('[RPG-UI] 视觉守护失败', err);
    }
}

/* ═══════════════════ 事件调度 ═══════════════════ */
const schedule = (() => {
    let timer = null;
    return (fn, delay = 80) => {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = null;
            try {
                fn();
            } catch (err) {
                console.warn('[RPG-UI]', err);
            }
        }, delay);
    };
})();

const refreshOne = (id, reparse = false) => schedule(() => {
    if (reparse) {
        try {
            reparseOne(id);
        } catch (err) { /* 忽略 */ }
    }
    processMessage(id);
    updateHud();
    updateCard();
});

eventSource.on(event_types.MESSAGE_UPDATED, (id) => refreshOne(id, true));
eventSource.on(event_types.MESSAGE_SWIPED, (id) => refreshOne(id, true));
eventSource.on(event_types.USER_MESSAGE_RENDERED, (id) => refreshOne(id));
eventSource.on(event_types.MESSAGE_RECEIVED, (id) => refreshOne(id));
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (id) => refreshOne(id));
eventSource.on(event_types.MESSAGE_DELETED, () => schedule(() => {
    try {
        rebuildCardStore();
    } catch (err) {
        console.warn('[RPG-UI] 回退重建失败', err);
    }
    processAll();
}, 180));

/* 切换聊天窗口：重置为「自动跟随该窗口最活跃角色」并全面重建
   注意：不能用 schedule——它是共享定时器的防抖器，多次调用会互相清除（导致切窗不刷新） */
eventSource.on(event_types.CHAT_CHANGED, () => {
    /* v1.9f：切换/载入聊天时立即重挂协议（原来只延迟 700ms；clearChat 清空后无人兜底） */
    try { applyProtocolPrompt(); } catch (errP0) { /* 忽略 */ }
    const forceRefresh = () => {
        $('#rpg-info-card').removeData('sig');
    };
    const refresh = () => {
        try {
            resetCardAuto();
            forceRefresh();
            processAll();
        } catch (err) {
            console.warn('[RPG-UI] 切窗刷新失败', err);
        }
    };
    setTimeout(refresh, 500);
    setTimeout(refresh, 1600);
    setTimeout(refresh, 3200);
    setTimeout(() => { try { visualGuard(); } catch (err) { /* 忽略 */ } }, 2500);
    setTimeout(() => { try { applyProtocolPrompt(); } catch (err) { /* 忽略 */ } }, 700);
});

/* v1.9f：让卡片协议与「上一张卡数据」像世界书一样可靠——每次生成前重挂一遍。
   根治：新建/清空聊天时 clearChat 会清空 extension_prompts（所有注入），
   此后不重挂，模板与字段说明就不会再进入请求（AI 收不到、无法按格式填卡）。 */
try {
    const reapplyProtocol = () => { try { applyProtocolPrompt(); } catch (errR) { /* 忽略 */ } };
    eventSource.on(event_types.GENERATION_STARTED, reapplyProtocol);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, reapplyProtocol);
    eventSource.on(event_types.CHAT_CREATED, reapplyProtocol);
} catch (errOr) { /* 忽略 */ }

/* 生成过程中：正常回复节流刷新信息卡；静默生成则流式填卡（把信息卡当另一个对话框） */
let lastLive = 0;
eventSource.on(event_types.STREAM_TOKEN_RECEIVED, (text) => {
    if (quietBusy) {
        handleQuietStream(text);
        return;
    }
    /* 单请求：正文里包含【状态栏】时边收边填 */
    handleLiveParse(text);
    const now = Date.now();
    if (now - lastLive > 2500) {
        lastLive = now;
        schedule(() => {
            updateCard();
            updateHud();
        }, 300);
    }
});
eventSource.on(event_types.GENERATION_ENDED, () => {
    if (suppressEnded) {
        if (quietOrphan) {
            /* 超时被弃置的静默生成终于结束：恢复正常，且不再叠加新的静默 */
            quietOrphan = false;
            quietBusy = false;
            suppressEnded = false;
            lastQuietEndedAt = Date.now();
            $('#rpg-info-card').removeClass('rpg-ic-busy').removeAttr('data-rpg-live');
            /* 迟到的流式数据已合并进卡片：补一次落盘 */
            try { getContext().saveMetadataDebounced?.(); } catch (err10) { /* 忽略 */ }
            console.debug('[RPG-UI] 超时静默已自然结束，恢复正常');
        }
        return;
    }
    /* 用原生 setTimeout（不能用 schedule 防抖器：可能被其他调用的共享定时器清掉） */
    setTimeout(() => {
        try {
            updateCard();
            updateHud();
        } catch (err) {
            console.warn('[RPG-UI]', err);
        }
    }, 500);
});

/* ═══════════════════ 后台静默状态更新（不写入对话） ═══════════════════ */
let quietBusy = false;
let suppressEnded = false;
let lastQuietAt = 0;
let lastQuietEndedAt = 0;
let quietStreamText = '';   // 流式接收中的静默输出（累积文本）
let lastQuietRender = 0;    // 流式渲染节流
let quietBefore = null;     // 失败时回滚用的快照
let quietIdx = -1;          // 本次静默对应的消息下标（resetFloor 判定用）
let quietOrphan = false;    // 超时后被弃置的静默生成：等它自然结束，避免叠加循环

/* 后台静默生成自带完整协议（skipWIAN 跳过世界书扫描），并压制“记忆表格”插件的填表指令干扰 */
const QUIET_PROTOCOL = (name, userName) => `【状态栏】
时间：<X年X月X日 星期X HH:MM，24小时制，随剧情连续推进>
地点：<详细生动的当前位置>
天气：<当前天气与环境氛围>
人物：${name}
性别：<…> ｜ 年龄：<…> ｜ 职业：<…> ｜ 金钱：<数值与货币>
服装：[上半身：…][胸罩：…][下半身：…][内裤：…][腿部：…][鞋子：…]
身体：[嘴巴：…][胸部：…][手：…][发型：…][腹部：…][大腿：…][脚：…]
😃当前姿态：<…> ｜ 🎇当前行为：<此刻具体动作>
🎈 心情：<当前情绪>
💗 对${userName}的好感度：<0-100>/100（±N）
💋 与${userName}的关系：<对${userName}的感情与关系状态>
💗 对其他重要角色的好感度：<0-100>/100（每个重要角色一行）（±N）
💋 与其他重要角色的关系：<对相关角色的感情>
体力：<0-100>/100（±N） ｜ 性欲值：<0-100>/100（±N） ｜ 怀孕可能性：<0-100>% ｜ 高潮值：<0-100>/100（±N） ｜ 🔥 NTR值：<0-100>/100（±N） ｜ 💦 淫荡值：<0-100>/100（±N）
🛏 性频率：与${userName} X次，与其他角色 Y次
🤰 怀孕状态：<是/否> | 排卵/受精：<是/否（受精要注明：卵子已受精）> | 生物学父亲：<未怀孕写"无"；受孕后写男方真名>
🍑 阴道状况：<当前状况与特征>
🌸 肛门状况：<当前状况与特征>
🐻 乳房状况：<当前状况与双乳特征>
👌 敏感度：<0-100>/100（±N）
🧪 精液量：<胃部（口交射入）Xml ｜ 阴道内（含子宫）Xml ｜ 肛门内 Xml ｜ 外部 Xml（毫升）>
🎯 已开发性癖：<喜欢：<…> ｜ 不喜欢：<…>——只写已开发/亲身体验过的；没有写"尚无">
👃 当前体味：<…>
🙀 情绪：<情绪与心理活动>
💊 药物状态：<…，无则写"无">
🛒 道具/配饰：<随身物品与道具>
💋 妆容：<…>
🛏 本次性行为：姿势：<…> ｜ 插入深度：<最小~最深，单位厘米，例：8~14cm>
😊 本次满意度：<0-100>/100
🛏 上次性行为：姿势：<…> ｜ 射精次数：<…> ｜ 高潮次数：<…>
💬 上次评价：<对上次性行为的评价>
🏥 健康：<健康/患病——患病须写疾病名与现状（潜伏期/发作/治疗中/已治愈）；性病单独注明（无 或 有：种类、感染时间、现状）；无病写"健康">
📷 ${name}视角：<以第三人称、像游戏CG一样详细描述${name}此刻的外貌与神态：细致入微，注意声音、形状、颜色、味道、感觉及动作变化，必须是最新的，严禁照抄上一楼>`;

/* 分块协议（渐进式填卡）：基础块先到 → 卡片立即显示；剧情块随后补齐 */
const QUIET_PROTOCOL_BASE = (name, userName) => `【状态栏】
时间：<X年X月X日 星期X HH:MM，24小时制，从上一版连续推进>
地点：<详细生动的当前位置>
天气：<当前天气与环境氛围>
人物：${name}
性别：<…> ｜ 年龄：<…> ｜ 职业：<…> ｜ 金钱：<数值与货币>
🎈 心情：<当前情绪>
体力：<0-100>/100（±N） ｜ 性欲值：<0-100>/100（±N） ｜ 怀孕可能性：<0-100>% ｜ 高潮值：<0-100>/100（±N） ｜ 🔥 NTR值：<0-100>/100（±N） ｜ 💦 淫荡值：<0-100>/100（±N）
🛏 性频率：与${userName} X次，与其他角色 Y次
🤰 怀孕状态：<是/否> | 排卵/受精：<是/否（受精要注明：卵子已受精）> | 生物学父亲：<未怀孕写"无"；受孕后写男方真名>
🍑 阴道状况：<当前状况与特征>
🌸 肛门状况：<当前状况与特征>
🐻 乳房状况：<当前状况与双乳特征>
👌 敏感度：<0-100>/100（±N）
🧪 精液量：<胃部（口交射入）Xml ｜ 阴道内（含子宫）Xml ｜ 肛门内 Xml ｜ 外部 Xml（毫升）>
🎯 已开发性癖：<喜欢：<…> ｜ 不喜欢：<…>——只写已开发/亲身体验过的；没有写"尚无">
👃 当前体味：<…>
🙀 情绪：<情绪与心理活动>
💊 药物状态：<…，无则写"无">
🛒 道具/配饰：<随身物品与道具>
💋 妆容：<…>`;

const QUIET_PROTOCOL_STORY = (name, userName) => `【状态栏】
💗 对${userName}的好感度：<0-100>/100（±N）
💋 与${userName}的关系：<对${userName}的感情与关系状态>
💗 对<其他重要角色的真名，例如“马库斯”；若剧情中暂无其他重要角色则整行省略>的好感度：<0-100>/100（±N）
💋 与<同上真名>的关系：<对相关角色的感情>
😃当前姿态：<…> ｜ 🎇当前行为：<此刻具体动作>
服装：[上半身：…][胸罩：…][下半身：…][内裤：…][腿部：…][鞋子：…]
身体：[嘴巴：…][胸部：…][手：…][发型：…][腹部：…][大腿：…][脚：…]
🛏 本次性行为：姿势：<…> ｜ 插入深度：<最小~最深，单位厘米，例：8~14cm>
😊 本次满意度：<0-100>/100
🛏 上次性行为：姿势：<…> ｜ 射精次数：<…> ｜ 高潮次数：<…>
💬 上次评价：<对上次性行为的评价>
🏥 健康：<健康/患病——患病须写疾病名与现状（潜伏期/发作/治疗中/已治愈）；性病单独注明（无 或 有：种类、感染时间、现状）；无病写"健康">
📷 ${name}视角：<以第三人称、像游戏CG一样详细描述${name}此刻的外貌与神态：细致入微，注意声音、形状、颜色、味道、感觉及动作变化，必须是最新的，严禁照抄上一楼>`;

/* 内置默认模板的“可见文本”（显示在设置面板，可编辑；与它保持一致时走内置分块路径）
   <角色名> / <user> 会在生成时被替换为实际名字 */
const DEFAULT_TEMPLATE_TEXT = `【状态栏】
时间：<X年X月X日 星期X HH:MM，24小时制，从上一版连续推进>
地点：<详细生动的当前位置>
天气：<当前天气与环境氛围>
人物：<角色名>
性别：<…> ｜ 年龄：<…> ｜ 职业：<…> ｜ 金钱：<数值与货币>
🎈 心情：<当前情绪>
体力：<0-100>/100（±N） ｜ 性欲值：<0-100>/100（±N） ｜ 怀孕可能性：<0-100>% ｜ 高潮值：<0-100>/100（±N） ｜ 🔥 NTR值：<0-100>/100（±N） ｜ 💦 淫荡值：<0-100>/100（±N）
🛏 性爱总次数：共<N>次（与<user> <n>次｜与<其他对象真名> <n>次｜…，按对象分别累计，只增不减）
🍆 最喜欢的阴茎：长<XX>cm·直径<XX>cm（注明是谁的）
🤰 怀孕状态：<是/否> | 排卵/受精：<是/否（受精要注明：卵子已受精）> | 生物学父亲：<未怀孕写"无"；受孕后写男方真名>
🍑 阴道状况：<当前状况与特征>
🌸 肛门状况：<当前状况与特征>
🐻 乳房状况：<当前状况与双乳特征>
👌 敏感度：<0-100>/100（±N）
🧪 精液量：<胃部（口交射入）Xml ｜ 阴道内（含子宫）Xml ｜ 肛门内 Xml ｜ 外部 Xml（毫升）>
🎯 已开发性癖：<喜欢：<…> ｜ 不喜欢：<…>——只写已开发/亲身体验过的；没有写"尚无">
👃 当前体味：<…>
🙀 情绪：<情绪与心理活动>
💊 药物状态：<…，无则写"无">
🛒 道具/配饰：<随身物品与道具>
💋 妆容：<…>
💗 对<user>的好感度：<0-100>/100（±N）
💋 与<user>的关系：<对<user>的感情与关系状态>
💗 对<其他重要角色真名（如"马库斯"）>的好感度：<0-100>/100（±N）
💋 与<同上真名>的关系：<对相关角色的感情>
😃当前姿态：<…> ｜ 🎇当前行为：<此刻具体动作>
服装：[上半身：…][胸罩：…][下半身：…][内裤：…][腿部：…][鞋子：…]
身体：[嘴巴：…][胸部：…][手：…][发型：…][腹部：…][大腿：…][脚：…]
🛏 本次性行为：姿势：<…> ｜ 插入深度：<最小~最深，单位厘米，例：8~14cm>
😊 本次满意度：<0-100>/100
🛏 上次性行为：姿势：<…> ｜ 射精次数：<…> ｜ 高潮次数：<…>
💬 上次评价：<对上次性行为的评价>
🏥 健康：<健康/患病——患病须写疾病名与现状（潜伏期/发作/治疗中/已治愈）；性病单独注明（无 或 有：种类、感染时间、现状）；无病写"健康">
📷 <角色名>视角：<以第三人称、像游戏CG一样详细描述<角色名>此刻的外貌与神态：细致入微，注意声音、形状、颜色、味道、感觉及动作变化，必须是最新的，严禁照抄上一楼>`;

/* 取“自定义模板”（已替换姓名占位）；与内置默认一致或为空 → null（走内置分块路径） */
function getCustomTemplate(forName, userName) {
    const raw = String(cfg.statusTemplate || '').trim();
    if (!raw) {
        return null;
    }
    if (raw.replace(/\s+/g, '') === DEFAULT_TEMPLATE_TEXT.replace(/\s+/g, '')) {
        return null;
    }
    return raw.replace(/<角色名>/g, forName).replace(/<user>/g, userName);
}

/* ═══ 单请求方案：把「卡片模板」作为系统提示注入每次生成 ═══
   AI 在剧情正文末尾直接输出【状态栏】→ 显示层自动隐藏 → 立即解析填入卡片（无需第二次请求） */
function applyProtocolPrompt() {
    try {
        const ctx = getContext();
        const raw = (cfg.cardTemplate && String(cfg.cardTemplate).trim()) ? String(cfg.cardTemplate).trim() : DEFAULT_CARD_TEMPLATE;
        const uName = (ctx.name1 && !/^user$/i.test(ctx.name1)) ? ctx.name1 : '玩家';
        const cName = ctx.name2 || '角色';
        let tpl = raw.replace(/<user>/g, uName).replace(/<角色名>/g, cName);
        if (!tpl.includes('【状态栏】')) {
            /* 旧版自定义模板缺标记行：注入时自动补上（显示层不受影响） */
            tpl = '【状态栏】\n' + tpl;
        }
        const head = '《系统格式要求》每次回复：先照常写剧情正文（写足细节），然后在正文末尾另起一行，输出一条完整的【状态栏】（供系统读取并自动填入人物信息卡；它会被自动隐藏，玩家看不到；绝不能与正文混写、不得省略字段）。【状态栏】必须以「【状态栏】」这四个字（中文方括号）作为开头第一行——这是系统识别的必需标记，缺了它系统就无法识别。字段格式如下：\n';
        const rules = '\n《数据连续性铁律》（必须遵守）：\n'
            + '① 人物信息卡是持续更新的数据库，不是每楼重写的作文：系统另附有「上一张人物信息卡·内部数据」，必须以它为基准逐字段对照本次剧情——没有发生变化的字段原样沿用，数字绝不允许重置、跳变或每次另填一套。\n'
            + '② 金钱：只随剧情中的收入与支出增减（工资/兼职/红包/售卖＝收入；购物/餐饮/打车/房租等＝支出），金额后用括号注明本次收支（例：¥2350（+120兼职／-38午餐））；没有收支事实时保持原值；金额须符合该角色的收入水平与积蓄。\n'
            + '③ 性爱总次数：只增不减、按对象分别累计——剧情中每发生一次性行为，给对应对象+1（书写例：与' + uName + '12次｜与某对象7次，不要加冒号）；绝不允许改小、清零或重写。「🍆 最喜欢的阴茎」（长度·直径）按角色真实发生过关系的对象与其内心偏好确定，一经确立不得随意更改。\n'
            + '④ 其他数值与身体：怀孕/排卵/敏感度/淫荡值/NTR值/体力/好感度等必须循序渐进（一次事件只做小幅合理变化）且有剧情或时间依据；身材、性格、关系等基准设定不随每楼变化。\n'
            + '⑤ 填写前先在心里对账：本次剧情里【谁和谁、做了什么、花了或赚了什么、身体发生了什么变化】——只更新与这些事实相关的字段，其余照抄上一张卡。\n'
            + '⑥ 「💭 阴茎比较」与「💭 性爱比较」必须每楼填写（哪怕只有一句话）：这是她此刻最真实的内心活动——对男人们（含玩家）尺寸/持久/技巧的私下比较、对性爱体验的惦记与对比。不得省略、不得留空、不得用"无"敷衍；她可以在外表上掩饰、否认，但内心字段要诚实。\n'
            + '⑦ 【本次/上次】结算（重要）：性爱结束、她回到日常后，必须把【本次】四格（对象／姿势／插入深度／评价）平移进【上次】对应项，并把【本次】四格全部改写为"无"；没有新的性爱之前【本次】一直保持"无"，严禁残留上一场信息。\n'
            + '⑧ 怀孕状态实时推进（格式：怀孕状态 | 排卵/受精 | 生物学父亲）：排卵期→注明"已排卵（未受精）"；排卵期内射→"卵子已受精"，且"怀孕状态"立即改写为"是"（怀孕成功）；始终未受精→经期时重置为"否"；"生物学父亲"：未怀孕写"无"，受精/怀孕后写致孕男方真名（不确定写"不明（可能与：…）"），确定后不得更改。每次填写前对比上一张卡的时间——过了几天就推进几天，严禁照抄上一楼。\n';
        const notes = (cfg.fieldNotes && String(cfg.fieldNotes).trim())
            ? ('\n《字段填写说明》（在设置面板可编辑；每条都按此解释填写）：\n' + String(cfg.fieldNotes).trim())
            : ((typeof DEFAULT_NOTES === 'string') ? ('\n《字段填写说明》：\n' + DEFAULT_NOTES) : '');
        ctx.setExtensionPrompt('RPG_UI_PROTOCOL', head + tpl + rules + notes, 1, 1, false, 0, false);
        syncPrevCardPrompt();
    } catch (err) { /* 忽略 */ }
}

/* ═══ v1.9f：内置「隐藏状态栏」显示钩子 ═══
   回复末尾的【状态栏】块只从「显示层」隐藏（聊天记录与发给 AI 的内容不受影响）；
   不再依赖酒馆「正则」扩展——规则文本可在本扩展设置里编辑（🧹 隐藏状态栏正则）。 */
const DEFAULT_HIDE_REGEX = '/(?:【状态栏】|【NTR状态栏】|【RPG状态栏】|#{1,4}[^\\n]{0,16}基本信息|时间\\s*[:：]\\s*\\d{4}\\s*年)[\\s\\S]*$/g';
let hideHookDone = false;
let hideCacheSrc = null;
let hideCacheRe = null;
function compileHideRegex(src) {
    const p = String(src || '').trim() || DEFAULT_HIDE_REGEX;
    if (p === hideCacheSrc) { return hideCacheRe; }
    const m = p.match(/^\/([\s\S]*)\/([a-z]*)$/i);
    try {
        if (m) {
            const flags = m[2].includes('g') ? m[2] : m[2] + 'g';
            hideCacheRe = new RegExp(m[1], flags);
        } else {
            hideCacheRe = new RegExp(p, 'g');
        }
    } catch (err) {
        hideCacheRe = null;
    }
    hideCacheSrc = p;
    return hideCacheRe;
}
function registerHideHook() {
    if (hideHookDone) { return; }
    try {
        const mf = getContext().messageFormatter;
        if (!mf || typeof mf.addHook !== 'function') { return; }
        mf.addHook((mes) => {
            try {
                const re = compileHideRegex(cfg.hideRegex);
                if (!re) { return mes; }
                return mes.replace(re, '').replace(/\s+$/, '');
            } catch (err) { return mes; }
        }, { stage: mf.stage.AFTER_REGEX, order: mf.order.LATE });
        hideHookDone = true;
        console.info('[RPG-UI] 隐藏状态栏钩子已启用（内置·不占用酒馆正则扩展）');
    } catch (err) { /* 忽略 */ }
}

/* ═══ v1.8：数据连续性——把「上一张人物信息卡」注入提示，AI 只能做增量更新 ═══ */
function syncPrevCardPrompt() {
    try {
        const ctx = getContext();
        const store = getCardStore();
        let text = '';
        const hasCharacter = (ctx.characterId !== undefined && ctx.characterId !== null && ctx.characterId !== '') || !!ctx.groupId;
        if (store && hasCharacter) {
            const activeName = pickActive(store, ctx);
            const nm = store.auto ? activeName : (store.active && store.chars[store.active] ? store.active : activeName);
            const cur = nm && !(store.hidden && store.hidden[nm]) ? store.chars?.[nm] : null;
            if (cur) {
                const body = buildPrevCardText(cur, ctx, nm);
                if (body) {
                    const title = (cur.title && String(cur.title).trim()) || nm;
                    text = '【上一张人物信息卡·内部数据】（' + title + ' 上一轮更新后的既有数据；本次填写必须以此为基础做增量修改，未发生变化的字段原样保留）：\n' + body;
                }
            }
        }
        ctx.setExtensionPrompt('RPG_UI_PREV', text, 1, 1, false, 0, false);
    } catch (err) { /* 忽略 */ }
}

/* 把当前卡片数据序列化成紧凑文本（取值逻辑与卡片显示保持一致） */
function buildPrevCardText(cur, ctx, name) {
    const rawPlayer = String(ctx.name1 || '').trim();
    const playerName = /^user$/i.test(rawPlayer) ? '玩家' : (rawPlayer || '玩家');
    const forName = (cur.title && String(cur.title).trim()) || name;
    const ovr = cur.ovr || {};
    const fv = (k) => {
        if (ovr[k] === '__DEL__') {
            return null;
        }
        if (typeof ovr[k] === 'string') {
            return ovr[k];
        }
        return cur.fields[k];
    };
    const clean = (s) => String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
    /* 时间写成 2026-10-09 形式，避免被显示层“剥离状态块”正则误伤 */
    const safeTime = (s) => clean(s).replace(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, '$1-$2-$3');
    const numOf = (v) => { const m = String(v === null || v === undefined ? '' : v).match(/(\d{1,3})/); return m ? parseInt(m[1], 10) : null; };
    const src = (cfg.cardTemplate && String(cfg.cardTemplate).trim()) ? cfg.cardTemplate : DEFAULT_CARD_TEMPLATE;
    const layout = buildLayoutFromTemplate(src);
    const layoutCanonSet = new Set();
    for (const sec of layout) {
        for (const row of sec.rows) {
            if (row.canon) { layoutCanonSet.add(row.canon); }
        }
    }
    const latestIdx = Array.isArray(ctx.chat) ? ctx.chat.length - 1 : 0;
    const isPlayerRel = (n) => n === '玩家' || (playerName && n === playerName);
    const relFiltered = Object.entries(cur.relations || {})
        .filter(([n, r]) => r && ((r.val !== null && r.val !== undefined) || r.note) && ovr['rel:' + n] !== '__DEL__')
        .filter(([n, r]) => isPlayerRel(n) || (r && r.val !== null && r.val !== undefined && r.val >= 50) || ((cur.relMsg || {})[n] !== undefined && (cur.relMsg || {})[n] >= latestIdx - 1))
        .sort((a, b) => ((b[0] === '玩家' ? 101 : (b[1].val === null || b[1].val === undefined ? -1 : b[1].val)) - (a[0] === '玩家' ? 101 : (a[1].val === null || a[1].val === undefined ? -1 : a[1].val))))
        .slice(0, 6);
    const statVal = {};
    const tili = cur.stats ? cur.stats['体力'] : null;
    if (tili && !Number.isNaN(tili.cur)) {
        statVal['体力'] = tili.cur + '/100';
    }
    const statPairs = [['性欲', numOf(fv('desire'))], ['怀孕几率', numOf(fv('pregChance'))], ['高潮值', numOf(fv('climax'))], ['NTR值', numOf(fv('ntr'))], ['淫荡值', numOf(fv('lewd'))], ['敏感度', numOf(fv('sensitivity'))]];
    for (const [k, v] of statPairs) {
        if (v !== null && v !== undefined) {
            statVal[k] = v + '/100';
        }
    }
    const partsAll = Object.fromEntries(Object.entries(cur.parts || {})
        .filter(([k]) => ovr['part:' + k] !== '__DEL__')
        .map(([k, v]) => [k, ovr['partv:' + k] !== undefined ? ovr['partv:' + k] : v]));
    const split = splitParts(partsAll);
    const emitted = { rel: false, partsOutfit: false, partsBody: false };
    const lines = [];
    for (const sec of layout) {
        const rows = [];
        for (const row of sec.rows) {
            try {
                if (row.type === 'cg') {
                    continue;
                }
                if (row.type === 'rel') {
                    if (emitted.rel) {
                        continue;
                    }
                    emitted.rel = true;
                    for (const [n, r] of relFiltered) {
                        const label = isPlayerRel(n) ? playerName : n;
                        if (r.val !== null && r.val !== undefined) {
                            rows.push('💗 对' + label + '的好感度：' + r.val + '/100');
                        }
                        if (r.note) {
                            rows.push('💋 与' + label + '的关系：' + clean(r.note));
                        }
                    }
                    continue;
                }
                if (row.type === 'stat') {
                    const ckey = STAT_ROW_MAP[String(row.label || '').replace(/^[^一-龥A-Za-z0-9]+/, '').trim()];
                    if (ckey && statVal[ckey] && ovr['stat:' + ckey] !== '__DEL__') {
                        rows.push(row.label + '：' + statVal[ckey]);
                    }
                    continue;
                }
                if (row.type === 'partsOutfit' || row.type === 'partsBody') {
                    if (emitted[row.type]) {
                        continue;
                    }
                    emitted[row.type] = true;
                    const arr = row.type === 'partsOutfit' ? split.outfit : split.body;
                    for (const [k, v] of arr) {
                        if (v) {
                            rows.push(k + '：' + clean(v));
                        }
                    }
                    continue;
                }
                const klPrev = (s) => String(s || '').replace(/^[^一-龥A-Za-z0-9]+/, '').trim();
                let val = row.canon ? fv(row.canon) : ((cur.custom || {})[row.label] !== undefined ? (cur.custom || {})[row.label] : ((cur.custom || {})[klPrev(row.label)] !== undefined ? (cur.custom || {})[klPrev(row.label)] : (row.label === '人物' ? forName : null)));
                if (row.canon === 'pregnant') {
                    val = [
                        fv('pregnant'),
                        (!layoutCanonSet.has('ovulation') && fv('ovulation')) ? ('排卵/受精：' + clean(fv('ovulation'))) : null,
                        (!layoutCanonSet.has('bioFather') && fv('bioFather')) ? ('生物学父亲：' + clean(fv('bioFather'))) : null,
                    ].filter(Boolean).join(' ｜ ');
                }
                if (row.canon === 'time' && val) {
                    val = safeTime(val);
                }
                if (val !== null && val !== undefined && String(val).trim()) {
                    rows.push(row.label + '：' + clean(val));
                }
            } catch (err2) { /* 单行出错不影响其他 */ }
        }
        if (rows.length) {
            lines.push('【' + (sec.title || '其他') + '】');
            lines.push(...rows);
        }
    }
    return lines.join('\n');
}

/* v1.9k：用户自定义冻结标记——用户在设置面板保存过模板/说明后，迁移永不自动改动对应内容 */
const CUSTOM_EPOCH = 'u1.9k';

/* v1.8：旧模板里的「性频率」行自动升级（含金钱行提示），幂等，只在需要时保存一次 */
function migrateCardTemplateV18() {
    try {
        if (cfg.tplUser === CUSTOM_EPOCH) { return; } /* 用户已自定义模板：永不自动改动 */
        const t = String(cfg.cardTemplate || '');
        if (!t || (!t.includes('性频率') && !t.includes('数值不能随意变更') && !t.includes('金钱：<数值与货币>'))) {
            return;
        }
        const out = [];
        for (const ln of t.split('\n')) {
            if (ln.includes('性频率')) {
                out.push('🛏 性爱总次数：共<N>次（与<user> <n>次｜与<其他对象真名> <n>次｜…，按对象分别累计，只增不减）');
                out.push('🍆 最喜欢的阴茎：长<XX>cm·直径<XX>cm（注明是谁的）');
            } else {
                out.push(ln
                    .replace('金钱：<数值不能随意变更，严格遵守收入和支出来变更数字>', '金钱：<数值与货币：只随剧情中的收入与支出增减，注明本次收支，如 ¥2350（+120兼职／-38午餐）>')
                    .replace('金钱：<数值与货币>', '金钱：<数值与货币：只随剧情中的收入与支出增减，注明本次收支，如 ¥2350（+120兼职／-38午餐）>'));
            }
        }
        cfg.cardTemplate = out.join('\n');
        save();
        console.info('[RPG-UI] 卡片模板已自动升级到 v1.8（性爱总次数 / 金钱收支）');
    } catch (err) { /* 忽略 */ }
}

/* v1.9：旧版卡片模板自动升级 —— 时间·场景置顶 / 分类重构 / 双列紧凑适配；幂等，仅升级官方结构的旧模板 */
function migrateCardTemplateV19() {
    try {
        if (cfg.tplUser === CUSTOM_EPOCH) { return; } /* 用户已自定义模板：永不自动改动 */
        const t = String(cfg.cardTemplate || '');
        if (!t.trim()) {
            return;
        }
        const tIdx = t.indexOf('🕐 时间·场景');
        const bIdx = t.indexOf('👤 基本信息');
        if (tIdx >= 0 && bIdx >= 0 && tIdx < bIdx) {
            return; /* 已是新版：时间·场景在最前 */
        }
        /* 只升级官方结构的旧模板；完全自定义的模板保持不动 */
        if (!t.includes('💗 关系好感') || !t.includes('📊 数值状态') || !t.includes('📷')) {
            return;
        }
        cfg.cardTemplate = CARD_TEMPLATE_V19;
        save();
        console.info('[RPG-UI] 卡片模板已自动升级到 v1.9（时间·场景置顶 / 分类重构 / 双列紧凑）');
    } catch (err) { /* 忽略 */ }
}

/* v1.9b：服装·道具前置 / 心情加图标 / 基本信息并入头像标签；幂等 */
function migrateCardTemplateV19b() {
    try {
        if (cfg.tplUser === CUSTOM_EPOCH) { return; } /* 用户已自定义模板：永不自动改动 */
        const t = String(cfg.cardTemplate || '');
        if (!t.trim()) {
            return;
        }
        if (t.includes('🎈 心情')) {
            return; /* 已是最新 */
        }
        if (!t.includes('🕐 时间·场景') || !t.includes('💗 关系好感')) {
            return; /* 非官方结构，不动 */
        }
        cfg.cardTemplate = CARD_TEMPLATE_V19;
        save();
        console.info('[RPG-UI] 卡片模板已升级 v1.9b（服装前置 / 心情图标 / 基本信息并入头像标签）');
    } catch (err) { /* 忽略 */ }
}

/* v1.9c：性爱记录重构（本次/上次分组+男方信息）+ 全字段填写说明 + 比较心理字段；幂等 */
function migrateCardTemplateV19c() {
    try {
        if (cfg.tplUser === CUSTOM_EPOCH) { return; } /* 用户已自定义模板：永不自动改动 */
        const t = String(cfg.cardTemplate || '');
        if (!t.trim()) {
            return;
        }
        if (t.includes('阴茎比较') && t.includes('本次插入深度') && t.includes('上次对象')) {
            return; /* 已是最新 */
        }
        if (!t.includes('🕐 时间·场景') || !t.includes('💗 关系好感')) {
            return; /* 非官方结构，不动 */
        }
        cfg.cardTemplate = CARD_TEMPLATE_V19;
        save();
        console.info('[RPG-UI] 卡片模板已升级 v1.9c（性爱记录重构 / 全字段说明 / 比较心理）');
    } catch (err) { /* 忽略 */ }
}

/* v1.9d：字段说明从模板移入设置面板（模板只留字段格式）；同时确保说明文档就位；幂等 */
function migrateCardTemplateV19d() {
    try {
        let changed = false;
        const t = String(cfg.cardTemplate || '');
        if (t.trim() && t.includes('🕐 时间·场景') && t.includes('💗 关系好感') && t.includes('时间：<格式') && cfg.tplUser !== CUSTOM_EPOCH) {
            cfg.cardTemplate = CARD_TEMPLATE_V19;
            changed = true;
        }
        if (!cfg.fieldNotes || !String(cfg.fieldNotes).trim()) {
            cfg.fieldNotes = DEFAULT_NOTES;
            changed = true;
        }
        if (changed) {
            save();
            console.info('[RPG-UI] v1.9d：字段说明已移入设置面板（可随协议发送给 AI）');
        }
    } catch (err) { /* 忽略 */ }
}

/* v1.9e：模板与说明的整体升级（关系好感「另一位男人」对比行 + 布局调整：性爱数据入性爱记录、数值下移、妆容入姿态）——幂等 */
function migrateCardTemplateV19e() {
    try {
        let changed = false;
        const t = String(cfg.cardTemplate || '');
        if (t.trim() && t.includes('🕐 时间·场景') && !t.includes('另一位男人') && cfg.tplUser !== CUSTOM_EPOCH) {
            cfg.cardTemplate = CARD_TEMPLATE_V19;
            changed = true;
        }
        if (t.trim() && t.includes('另一位男人') && !t.includes('💠 是否处女') && cfg.tplUser !== CUSTOM_EPOCH) {
            cfg.cardTemplate = CARD_TEMPLATE_V19;
            changed = true;
        }
        const n = String(cfg.fieldNotes || '');
        if (n.trim() && !n.includes('另一位男人') && cfg.notesUser !== CUSTOM_EPOCH) {
            cfg.fieldNotes = DEFAULT_NOTES;
            changed = true;
        }
        if (changed) {
            save();
            console.info('[RPG-UI] v1.9e：模板与字段说明已升级（最新布局）');
        }
    } catch (err) { /* 忽略 */ }
}

/* v1.9g：布局调整——🛏 性爱记录整段上移到 🔥 生理状态之前；💭 阴茎比较/性爱比较 移动到性爱记录最下方；幂等 */
function migrateCardTemplateV19g() {
    try {
        if (cfg.tplUser === CUSTOM_EPOCH) { return; } /* 用户已自定义模板：永不自动改动 */
        const t = String(cfg.cardTemplate || '');
        if (!t.trim() || !t.includes('🕐 时间·场景') || !t.includes('🛏 性爱记录') || !t.includes('## 🔥 生理状态')) {
            return; /* 非官方结构，不动 */
        }
        const lines = t.split(/\r?\n/);
        /* 1) 先摘出「比较」两行（无论当前在哪一段） */
        const comps = [];
        const favRows = [];
        for (let i = lines.length - 1; i >= 0; i--) {
            const s = lines[i].trim();
            if (/^💭\s*阴茎比较/.test(s) || /^💭\s*性爱比较/.test(s)) {
                comps.unshift(lines[i]);
                lines.splice(i, 1);
            } else if (/^🍆\s*心中最棒的阴茎是谁的/.test(s)) {
                favRows.unshift(lines[i]);
                lines.splice(i, 1);
            }
        }
        /* 2) 摘出性爱记录整段 */
        const si = lines.findIndex(x => x.trim().startsWith('## 🛏'));
        if (si < 0) {
            return;
        }
        let ei = si + 1;
        while (ei < lines.length && !lines[ei].trim().startsWith('## ')) {
            ei++;
        }
        const sexBlock = lines.slice(si, ei);
        lines.splice(si, ei - si);
        if (comps.length) {
            sexBlock.push(...comps); /* 比较行并入性爱记录最下方 */
        }
        if (favRows.length) {
            sexBlock.push(...favRows); /* 「心中最棒的阴茎是谁的」永远在最底 */
        }
        /* 3) 整段插到生理状态之前 */
        const bi = lines.findIndex(x => x.trim().startsWith('## 🔥'));
        if (bi < 0) {
            return;
        }
        lines.splice(bi, 0, ...sexBlock);
        const nt = lines.join('\n');
        if (nt !== t) {
            cfg.cardTemplate = nt;
            save();
            console.info('[RPG-UI] v1.9g：性爱记录已上移至生理状态之前（比较字段在性爱记录最下方）');
        }
    } catch (err) { /* 忽略 */ }
}

/* v1.9h/i：数值变化量（±N）+ 分级指导 + 涨跌规则 + 道具规则——模板 8 行加（±N）；字段说明升级；幂等 */
function migrateCardTemplateChgMark() {
    try {
        let changed = false;
        const t = String(cfg.cardTemplate || '');
        if (t.trim() && t.includes('🕐 时间·场景') && !t.includes('（±N）') && cfg.tplUser !== CUSTOM_EPOCH) {
            const nt = t.replace(/^(💗 对<[^>]{1,24}>的好感度：<0-100>\/100|体力：<0-100>\/100|性欲值：<0-100>\/100|高潮值：<0-100>\/100|🔥 NTR值：<0-100>\/100|💦 淫荡值：<0-100>\/100|👌 敏感度：<0-100>\/100)$/gm, '$1（±N）');
            if (nt !== t) {
                cfg.cardTemplate = nt;
                changed = true;
            }
        }
        const n = String(cfg.fieldNotes || '');
        if (n.trim() && !n.includes('已开发性癖') && (cfg.notesUser !== CUSTOM_EPOCH || n.includes('怀孕可能性：随生理周期波动'))) {
            /* v2.0.6：旧代出厂说明（带指纹）即使被冻结也强制升级到最新版——多页面回写后仍会自愈收敛 */
            cfg.fieldNotes = DEFAULT_NOTES;
            changed = true;
        }
        if (changed) {
            save();
            console.info('[RPG-UI] v1.9l：字段说明已升级（涨跌规则只定方向，判断权交给 AI）');
        }
    } catch (err) { /* 忽略 */ }
}

/* v1.9j：精液量毫升化（胃/阴道含子宫/肛门/外部）+ 排卵→受精显示 + 处女记录行；幂等 */
function migrateCardTemplateV19j() {
    try {
        let changed = false;
        const t = String(cfg.cardTemplate || '');
        if (t.trim() && t.includes('🕐 时间·场景') && cfg.tplUser !== CUSTOM_EPOCH) {
            let nt = t;
            const oldPreg = '🤰 怀孕状态：<是/否>（是否排卵：<是/否>，怀孕几率：<0-100>%）';
            const oldPreg2 = '🤰 怀孕状态：<是/否>（是否排卵：<是/否>；已排卵则改写"卵子是否受精：<是/否>"，受精后约6~12天着床→"怀孕状态"改"是"；怀孕几率：<0-100>%）';
            const newPreg = '🤰 怀孕状态：<是/否> | 排卵/受精：<是/否（受精要注明：卵子已受精）> | 生物学父亲：<未怀孕写"无"；受孕后写男方真名>';
            if (nt.includes(oldPreg) && !nt.includes('卵子是否受精')) {
                nt = nt.replace(oldPreg, newPreg);
            }
            if (nt.includes(oldPreg2)) {
                nt = nt.replace(oldPreg2, newPreg);
            }
            const oldSemen = '🧪 精液量：<…>';
            const newSemen = '🧪 精液量：<按毫升计——胃部（口交射入）Xml ｜ 阴道内（含子宫）Xml ｜ 肛门内 Xml ｜ 外部（体表/衣物等）Xml；没有的写0ml>';
            if (nt.includes(oldSemen) && !nt.includes('胃部（口交射入）')) {
                nt = nt.replace(oldSemen, newSemen);
            }
            if (!nt.includes('💠 是否处女')) {
                nt = nt.replace('🛏 性爱总次数：', '💠 是否处女：<是/否；若已不是处女，必须写明失去的时间、对象真名与方式，如"否（2026年5月4日 被某人以手指与性器在试衣间夺走）">\n🛏 性爱总次数：');
            }

            /* v2.0.7：健康行（性爱记录最下方）*/
            if (!nt.includes('🏥 健康')) {
                const _hl = '🏥 健康：<健康/患病——患病须写疾病名与现状（潜伏期/发作/治疗中/已治愈）；性病单独注明（无 或 有：种类、感染时间、现状）；无病写"健康">';
                if (nt.includes('💭 性爱比较：<…>')) {
                    nt = nt.replace('💭 性爱比较：<…>', '💭 性爱比较：<…>\n' + _hl);
                } else if (nt.includes('💬 上次评价：<…>')) {
                    nt = nt.replace('💬 上次评价：<…>', '💬 上次评价：<…>\n' + _hl);
                }
            }

            /* v2.0.8：已开发性癖行（精液量下方）*/
            if (!nt.includes('🎯 已开发性癖')) {
                const _xh = '🎯 已开发性癖：<喜欢：<…> ｜ 不喜欢：<…>——只写已开发/亲身体验过的；没有写"尚无">';
                if (nt.includes('👃 当前体味：')) {
                    nt = nt.replace('👃 当前体味：', _xh + '\n👃 当前体味：');
                }
            }
            if (nt !== t) {
                cfg.cardTemplate = nt;
                changed = true;
            }
        }
        const n = String(cfg.fieldNotes || '');
        if (n.trim() && !n.includes('已开发性癖') && (cfg.notesUser !== CUSTOM_EPOCH || n.includes('怀孕可能性：随生理周期波动'))) {
            /* v2.0.6：旧代出厂说明（带指纹）即使被冻结也强制升级到最新版——多页面回写后仍会自愈收敛 */
            cfg.fieldNotes = DEFAULT_NOTES;
            changed = true;
        }
        if (changed) {
            save();
            console.info('[RPG-UI] v1.9j：精液量毫升化 / 受精显示 / 处女记录已就位');
        }
    } catch (err) { /* 忽略 */ }
}

/* v1.9m：移除「🍆 心中最棒的阴茎是谁的」行（内容已并入「🍆 最喜欢的阴茎」行）；用户自定义模板不触碰；幂等 */
function migrateCardTemplateV19k() {
    try {
        if (cfg.tplUser === CUSTOM_EPOCH) {
            return;
        }
        const t = String(cfg.cardTemplate || '');
        if (!t.trim() || !t.includes('心中最棒的阴茎是谁的')) {
            return;
        }
        const nt = t.split('\n').filter(function (ln) { return !/^🍆\s*心中最棒的阴茎是谁的/.test(ln.trim()); }).join('\n');
        if (nt !== t) {
            cfg.cardTemplate = nt;
            save();
            console.info('[RPG-UI] v1.9m：已移除「心中最棒的阴茎是谁的」行');
        }
    } catch (err) { /* 忽略 */ }
}

/* 单请求方案：正文流式输出时，边接收边解析末尾【状态栏】，实时填入卡片（把卡片当另一个对话框） */
let lastLiveParse = 0;
function handleLiveParse(text) {
    if (typeof text !== 'string' || !text) {
        return;
    }
    if (text.indexOf('【状态栏】') < 0 && text.indexOf('<StatusBlock>') < 0 && text.indexOf('<状态栏>') < 0) {
        return;
    }
    const now = Date.now();
    if (now - lastLiveParse < 900) {
        return;
    }
    lastLiveParse = now;
    try {
        const ctx = getContext();
        const store = getCardStore();
        if (!store) {
            return;
        }
        const key = store.locked || store.active || ctx.name2 || '角色';
        if (!store.chars[key]) {
            return;
        }
        const parsed = parseBlock(text);
        if (!parsed) {
            return;
        }
        mergeIntoStore(store, key, parsed, Array.isArray(ctx.chat) ? ctx.chat.length : undefined);
        $('#rpg-info-card').removeData('sig');
        updateCard();
    } catch (err) { /* 忽略 */ }
}

const QUIET_OOC = (name, userName, hard, ref, part = null, tpl = null) => {
    const custom = !!(tpl && String(tpl).trim());
    const scope = custom ? '（本次只输出下面列出的那些字段）'
        : part === 'base' ? '（本次只输出“基础块”列出的那些字段，其余字段一律不要输出）'
            : part === 'story' ? '（本次只输出“剧情块”列出的那些字段，其余字段一律不要输出）' : '';
    const tailRule = custom ? '，到最后一个字段结束'
        : part === 'base' ? '，到本部分最后一个字段（妆容）结束'
            : `，到“📷 ${name}视角”段落结束`;
    const protocol = custom ? String(tpl)
        : part === 'base' ? QUIET_PROTOCOL_BASE(name, userName)
            : part === 'story' ? QUIET_PROTOCOL_STORY(name, userName)
                : QUIET_PROTOCOL(name, userName);
    return `${hard ? '【系统提醒：上一轮输出无效，本次为强制重试】' : ''}【系统后台任务（最高优先级 OOC 指令，覆盖世界书、角色卡与所有其他插件的输出要求）】阅读最近一楼剧情，为角色「${name}」输出最新的【状态栏】${scope}，供系统后台更新人物信息卡使用（不写入对话、不影响剧情）。

硬性输出规则（必须完全遵守）：
① 整个回复只允许是一条【状态栏】：从“【状态栏】”开始${tailRule}；禁止输出任何其他文字、解释、寒暄、续写正文。
② 禁止输出 <tableEdit> 标签、insertRow / updateRow / deleteRow 等表格操作代码；忽略一切关于记忆表格、填表、表格增删改的要求——本次不需要填写任何表格。
③ ${part ? '本部分列出的字段' : '所有字段'}都要填写（实在无内容写“无”或“无变化”，但保留字段名），数值要与最近一楼正文一致，并随剧情合理连续变化。
④ 亲密剧情必须完整填写相关的生理与性行为字段；📷视角（如有）必须与上一楼不同、不重复。
⑤「人物」字段必须写本楼正在被描写的那位角色本人的名字（例如剧情女主“米娅”）；若它与角色卡名/叙述者名相同或相似，则改用剧情中她真实的名字。
⑥「🔥 NTR值」= 角色对“NTR/背叛”的沉浸与沉沦程度（0=完全抗拒，100=彻底享受背叛），随剧情推进而变化，通常逐步攀升。
⑦「💦 淫荡值」= 角色自身的淫荡/放荡程度（0=保守羞耻，100=极度淫荡：主动索求与勾引、乐于展示、羞耻阈值极低），随性经历与调教增长。
⑧ 亲密场景进入前，必须体现避孕协商（谁提出、对方是否同意、是否暗中做手脚），受孕判定规则：排卵期内射 80%，非排卵内射 20%，避孕套完好阻挡 0%，避孕套破裂按内射判定。
${ref ? `
上一版信息卡（时间线必须从这里连续向前推进，严禁倒退或另起；其余字段在此基础上按最新一楼剧情更新）：
${ref}
` : ''}
输出格式（照抄字段顺序，尖括号内为占位内容）：
${protocol}`;
};

/* “记忆表格”类插件会在生成前把填表指令注入请求；静默生成时将这些消息从本次请求中剔除 */
function quietPromptFilter(eventData) {
    if (!quietBusy || !eventData || !Array.isArray(eventData.chat)) {
        return;
    }
    try {
        for (let i = eventData.chat.length - 1; i >= 0; i--) {
            const c = eventData.chat[i]?.content;
            if (typeof c === 'string' && /dataTable 说明|【增删改触发条件】|<OperateRule>|通过表格记录的当前场景信息/.test(c)) {
                eventData.chat.splice(i, 1);
                console.debug('[RPG-UI] 已从静默生成请求中移除表格注入消息（位置 #' + i + '）');
            }
        }
    } catch (err) { /* 忽略 */ }
}

function ensureQuietFilter() {
    try {
        /* 挪到监听器末尾（makeLast），确保在其他插件把填表指令注入之后再过滤 */
        if (typeof eventSource.makeLast === 'function') {
            eventSource.makeLast(event_types.CHAT_COMPLETION_PROMPT_READY, quietPromptFilter);
        } else {
            eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, quietPromptFilter);
        }
    } catch (err) { /* 忽略 */ }
}

function quietBudget() {
    const n = Number(cfg.quietTokens);
    return Number.isFinite(n) && n >= 400 ? Math.min(2000000, Math.round(n)) : 2400;
}

/* 实际发送给接口的预算上限（多数供应商 max_tokens ≤ 1M，超出会被 400 拒绝） */
function quietRequestBudget() {
    return Math.min(quietBudget(), 1048000);
}

function quietGenerate(name, userName, hard, ref, part = null, tpl = null) {
    const budget = quietRequestBudget();
    const len = part === 'base' ? Math.max(1400, Math.round(budget * 0.6)) : budget;
    return Promise.race([
        generateQuietPrompt({ quietPrompt: QUIET_OOC(name, userName, hard, ref, part, tpl), skipWIAN: true, responseLength: len }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('quiet 超时')), 150000)),
    ]);
}

/* 数据完整性检查：防止“被截断的半截状态”判定为成功（v1.6） */
function quietLooksOk(parsed, part, custom) {
    if (!parsed) {
        return false;
    }
    const f = parsed.fields || {};
    const hasTime = !!(f.time || f.place);
    const hasStory = !!(f.cg || f.curPose || f.satisfy || Object.keys(parsed.relations || {}).length || Object.keys(parsed.parts || {}).length);
    if (custom) {
        return hasTime || hasStory;
    }
    if (part === 'base') {
        return !!(f.time || f.place || f.desire || f.ntr || f.money);
    }
    if (part === 'story') {
        return hasStory;
    }
    return hasTime || hasStory;
}

/* 角色简历（角色卡名/描述/性格/场景设定），供静默更新“结合人物简历”使用 */
function getCharProfile(maxLen = 1800) {
    try {
        const ctx = getContext();
        const ch = Array.isArray(ctx.characters) ? ctx.characters[Number(ctx.characterId)] : null;
        if (!ch) {
            return '';
        }
        let s = `【角色卡·${ch.name}】\n${String(ch.description || '')}`;
        if (ch.personality) {
            s += `\n【性格】${String(ch.personality)}`;
        }
        if (ch.scenario) {
            s += `\n【场景设定】${String(ch.scenario)}`;
        }
        return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
    } catch (err) {
        return '';
    }
}

/* 最近剧情（最后 N 条消息拼接，从尾部截断控制长度） */
function buildRecentContext(maxChars = 6000, maxMsgs = 10) {
    try {
        const ctx = getContext();
        const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
        const parts = [];
        for (let i = Math.max(0, chat.length - maxMsgs); i < chat.length; i++) {
            const m = chat[i];
            if (!m || m.is_system || !m.mes) {
                continue;
            }
            parts.push(`【${m.name}】\n${String(m.mes).slice(0, 3000)}`);
        }
        let s = parts.join('\n\n');
        if (s.length > maxChars) {
            s = '…' + s.slice(s.length - maxChars);
        }
        return s;
    } catch (err) {
        return '';
    }
}

/* 独立通道：走酒馆服务器代理（/api/backends/chat-completions/generate），支持任意 OpenAI 兼容端点 + 流式 */
async function quietDirectGenerate(systemText, userText, onDelta, maxTokensOverride) {
    const resp = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            chat_completion_source: 'openai',
            reverse_proxy: cfg.quietApiUrl,
            proxy_password: cfg.quietApiKey,
            model: cfg.quietModel,
            messages: [
                { role: 'system', content: systemText },
                { role: 'user', content: userText },
            ],
            max_tokens: maxTokensOverride || quietRequestBudget(),
            temperature: 0.6,
            stream: true,
        }),
    });
    if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        throw new Error('HTTP ' + resp.status + ' ' + String(t).slice(0, 160));
    }
    if (!resp.body) {
        throw new Error('无响应体（流式不可用）');
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let acc = '';
    let rawAll = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        const chunk = decoder.decode(value, { stream: true });
        rawAll += chunk;
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, '').trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) {
                continue;
            }
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') {
                continue;
            }
            try {
                const j = JSON.parse(payload);
                const d = j?.choices?.[0]?.delta?.content || j?.choices?.[0]?.message?.content || '';
                if (d) {
                    acc += d;
                    if (onDelta) {
                        onDelta(acc);
                    }
                }
            } catch (err) { /* 跳过非 JSON 片段 */ }
        }
    }
    /* 兜底：代理若返回整段 JSON（非流式），也能取出内容 */
    if (!acc && rawAll.trim()) {
        try {
            const j = JSON.parse(rawAll.trim());
            acc = j?.choices?.[0]?.message?.content || j?.choices?.[0]?.text || '';
        } catch (err) { /* 忽略 */ }
    }
    return acc;
}

/* ── 流式填卡：静默生成时把信息卡当作“另一个对话框”，随 token 渐进解析实时填写 ── */
function quietSnapshot(cs) {
    try {
        return JSON.stringify({
            fields: cs.fields || {}, relations: cs.relations || {},
            parts: cs.parts || {}, stats: cs.stats || {},
        });
    } catch (err) {
        return null;
    }
}

function quietRestore(cs) {
    if (!cs || !quietBefore) {
        return;
    }
    try {
        const snap = JSON.parse(quietBefore);
        cs.fields = snap.fields || cs.fields;
        cs.relations = snap.relations || cs.relations;
        cs.parts = snap.parts || cs.parts;
        cs.stats = snap.stats || cs.stats;
    } catch (err) { /* 忽略 */ }
}

function handleQuietStream(text) {
    if (typeof text !== 'string' || !text) {
        return;
    }
    quietStreamText = text;
    const now = Date.now();
    if (now - lastQuietRender < 600) {
        return;
    }
    lastQuietRender = now;
    try {
        const $card = $('#rpg-info-card');
        if ($card.length) {
            $card.attr('data-rpg-live', '⟳ 接收状态 ' + quietStreamText.length + ' 字…');
        }
        const ctx = getContext();
        const store = getCardStore();
        if (!store) {
            return;
        }
        const name = store.locked || store.active || ctx.name2 || '角色';
        const cs = store.chars[name];
        if (!cs) {
            return;
        }
        const partial = parseBlock(quietStreamText);
        if (partial) {
            mergeIntoStore(store, name, partial, quietIdx >= 0 ? quietIdx : undefined);
            $card.removeData('sig');
            updateCard();
        }
    } catch (err) { /* 忽略 */ }
}

async function runQuietStatus() {
    if (!cfg.quietStatus || quietBusy || !cfg.enabled || !cfg.infoCard) {
        return;
    }
    const ctx = getContext();
    const store = getCardStore();
    const hasCharacter = (ctx.characterId !== undefined && ctx.characterId !== null && ctx.characterId !== '')
        || !!ctx.groupId;
    if (!store || !hasCharacter || !Array.isArray(ctx.chat) || !ctx.chat.length) {
        return;
    }
    const name = store.locked || store.active || ctx.name2 || '角色';
    const userName = (ctx.name1 && !/^user$/i.test(ctx.name1)) ? ctx.name1 : '玩家';
    /* 提示词里使用的角色名：优先采用剧情角色名（如 米娅/Mia），保证每轮称呼一致 */
    const forName = (store.chars[name]?.title) || name;
    /* 上一版信息卡参考：锚定时间线连续性，避免每次生成时间跳来跳去 */
    const prevCs = store.chars[name] || {};
    const prevRef = [
        `主视角角色：${forName}`,
        prevCs.fields?.time ? `时间：${prevCs.fields.time}` : null,
        prevCs.fields?.place ? `地点：${prevCs.fields.place}` : null,
        prevCs.fields?.pregnant ? `怀孕状态：${[
            prevCs.fields.pregnant,
            prevCs.fields.ovulation ? `排卵/受精：${prevCs.fields.ovulation}` : null,
            prevCs.fields.bioFather ? `生物学父亲：${prevCs.fields.bioFather}` : null,
        ].filter(Boolean).join(' | ')}` : null,
        prevCs.fields?.desire ? `性欲值：${prevCs.fields.desire}` : null,
        prevCs.fields?.sexFreq ? `性爱总次数：${prevCs.fields.sexFreq}` : null,
        prevCs.fields?.favPenis ? `最喜欢的阴茎：${prevCs.fields.favPenis}` : null,
        prevCs.fields?.money ? `金钱：${prevCs.fields.money}` : null,
    ].filter(Boolean).join('；');
    /* 流式填卡状态初始化 + 失败回滚快照 */
    quietIdx = ctx.chat.length - 1;
    quietStreamText = '';
    lastQuietRender = 0;
    quietBefore = quietSnapshot(prevCs);
    quietBusy = true;
    suppressEnded = true;
    ensureQuietFilter();
    $('#rpg-info-card').addClass('rpg-ic-busy').attr('data-rpg-live', '⟳ 状态更新中…');
    let gotAny = false;
    try {
        /* ── v1.6 静默引擎：独立通道（可选：任意端点+密钥+模型，真流式）→ 否则酒馆主连接分块填卡 ── */
        const useDirect = !!(cfg.quietApiUrl && cfg.quietApiKey && cfg.quietModel);
        const customTpl = getCustomTemplate(forName, userName);
        const combined = { fields: {}, relations: {}, parts: {}, stats: [], key: name };
        let blocks = 0;
        const absorb = (parsed) => {
            /* 静默更新固定附加到卡片当前锁定的角色（避免“人物”字段写法不同导致条目碎裂） */
            mergeIntoStore(store, name, parsed, quietIdx >= 0 ? quietIdx : undefined);
            Object.assign(combined.fields, parsed.fields || {});
            Object.assign(combined.relations, parsed.relations || {});
            Object.assign(combined.parts, parsed.parts || {});
            combined.stats = combined.stats.concat(parsed.stats || []);
            if (parsed.name) {
                combined.name = parsed.name;
            }
            gotAny = true;
            blocks++;
            /* 数据到达 → 立即刷新卡片（渐进式“流式”填写） */
            $('#rpg-info-card').removeData('sig');
            updateCard();
        };
        const rollbackPreview = () => {
            if (!gotAny) {
                const csR = store.chars[name];
                if (csR && quietBefore) {
                    quietRestore(csR);
                    $('#rpg-info-card').removeData('sig');
                }
            }
        };
        const runSTPath = async () => {
            const parts = customTpl ? [null] : ((cfg.quietSplit === false) ? [null] : ['base', 'story']);
            for (const part of parts) {
                const tag = part ? '/' + part : '';
                let text = await quietGenerate(forName, userName, false, prevRef, part, customTpl);
                let parsed = parseBlock(String(text || ''));
                if (!quietLooksOk(parsed, part, !!customTpl)) {
                    console.warn('[RPG-UI] quiet' + tag + ' 数据不完整/无法解析，强制重试。片段:', String(text || '').slice(0, 160));
                    rollbackPreview();
                    quietStreamText = '';
                    lastQuietRender = 0;
                    text = await quietGenerate(forName, userName, true, prevRef, part, customTpl);
                    parsed = parseBlock(String(text || ''));
                }
                console.debug('[RPG-UI] quiet' + tag + ' 原始输出:', String(text || '').slice(0, 160));
                if (!quietLooksOk(parsed, part, !!customTpl)) {
                    console.warn('[RPG-UI] quiet' + tag + ' 仍不完整（跳过本块）');
                    continue;
                }
                absorb(parsed);
            }
        };
        if (useDirect) {
            /* 独立通道：单次生成 + 真流式（走酒馆服务器代理，支持任意 OpenAI 兼容端点） */
            const tpl = customTpl || QUIET_PROTOCOL(forName, userName);
            const profile = getCharProfile();
            const context = buildRecentContext();
            const systemText = '你是“人物信息卡”后台更新系统：阅读剧情与角色简历，为角色「' + forName + '」输出最新【状态栏】（供系统解析，不会展示给任何人）。\n'
                + '硬性规则：① 只输出一条【状态栏】，从“【状态栏】”开始到最后一个字段结束，禁止任何其他文字、解释或表格代码；② 所有字段都要填写，数值与最近正文一致并随时间连续推进（时间不得倒退）；③「人物」字段写角色本人的名字（如“米娅”），不写角色卡名。\n'
                + (profile ? '\n' + profile + '\n' : '')
                + (prevRef ? '\n【上一版信息卡（时间线必须从这里连续向前推进）】\n' + prevRef + '\n' : '')
                + '\n输出格式（照抄字段与顺序，尖括号内为占位内容）：\n' + tpl;
            const userText = '【最近剧情】\n' + context + '\n\n以上是最近剧情。现在只输出角色「' + forName + '」的最新【状态栏】（从“【状态栏】”开始，只含字段内容，不要任何其他文字）。';
            try {
                const acc = await quietDirectGenerate(systemText, userText, (t) => handleQuietStream(t));
                let parsed = parseBlock(String(acc || ''));
                if (!quietLooksOk(parsed, null, !!customTpl)) {
                    console.warn('[RPG-UI] 独立通道输出不完整，重试一次。片段:', String(acc || '').slice(0, 160));
                    rollbackPreview();
                    quietStreamText = '';
                    lastQuietRender = 0;
                    const acc2 = await quietDirectGenerate(systemText, userText, (t) => handleQuietStream(t));
                    parsed = parseBlock(String(acc2 || ''));
                }
                if (quietLooksOk(parsed, null, !!customTpl)) {
                    absorb(parsed);
                } else {
                    console.warn('[RPG-UI] 独立通道仍不完整（放弃本轮）');
                }
            } catch (errDirect) {
                console.warn('[RPG-UI] 独立通道失败：', errDirect);
                /* 400（多为 max_tokens 超限）→ 自动降档重试一次，再不行才回退酒馆主连接 */
                let recovered = false;
                if (/400|max.?tokens|Bad Request/i.test(String(errDirect && errDirect.message || errDirect))) {
                    try {
                        rollbackPreview();
                        quietStreamText = '';
                        lastQuietRender = 0;
                        console.warn('[RPG-UI] 以 16000 上限重试独立通道…');
                        const acc3 = await quietDirectGenerate(systemText, userText, (t) => handleQuietStream(t), 16000);
                        const parsed3 = parseBlock(String(acc3 || ''));
                        if (quietLooksOk(parsed3, null, !!customTpl)) {
                            absorb(parsed3);
                            recovered = true;
                        }
                    } catch (errRetry) {
                        console.warn('[RPG-UI] 独立通道降档重试仍失败：', errRetry);
                    }
                }
                if (!recovered) {
                    console.warn('[RPG-UI] 改用酒馆主连接重试');
                    rollbackPreview();
                    quietStreamText = '';
                    lastQuietRender = 0;
                    await runSTPath();
                }
            }
        } else {
            await runSTPath();
        }
        if (gotAny) {
            const idx = ctx.chat.length - 1;
            store.history = store.history || {};
            store.history[idx] = combined;
            /* 历史快照数量保护 */
            const keys = Object.keys(store.history);
            if (keys.length > 250) {
                keys.sort((a, b) => Number(a) - Number(b));
                for (const k of keys.slice(0, keys.length - 250)) {
                    delete store.history[k];
                }
            }
            persistCard();
            $('#rpg-info-card').removeData('sig');
            updateCard();
            console.debug('[RPG-UI] 后台状态已更新（消息 #' + idx + '，' + blocks + ' 块' + (useDirect ? '·独立通道' : '') + '）');
        } else {
            rollbackPreview();
            updateCard();
            console.warn('[RPG-UI] 本轮静默未获得任何数据');
        }
    } catch (err) {
        console.warn('[RPG-UI] 后台状态更新失败', err);
        const isTimeout = String(err && err.message || err || '').includes('超时');
        if (isTimeout) {
            /* 生成仍在后台进行（接口慢）：保持等待其自然结束，避免结束时再触发一次静默造成叠加循环 */
            quietOrphan = true;
            console.warn('[RPG-UI] 静默超时——等待其自然结束（本轮不再叠加新的静默更新）');
            setTimeout(() => {
                if (quietOrphan) {
                    quietOrphan = false;
                    quietBusy = false;
                    suppressEnded = false;
                    $('#rpg-info-card').removeClass('rpg-ic-busy').removeAttr('data-rpg-live');
                    try { getContext().saveMetadataDebounced?.(); } catch (err11) { /* 忽略 */ }
                    console.warn('[RPG-UI] 超时静默兜底解除（未等到结束事件）');
                }
            }, 360000);
        }
        try {
            const csE = store.chars[name];
            if (csE && quietBefore && !gotAny) {
                quietRestore(csE);
                $('#rpg-info-card').removeData('sig');
                updateCard();
            }
        } catch (err9) { /* 忽略 */ }
    } finally {
        if (!quietOrphan) {
            $('#rpg-info-card').removeClass('rpg-ic-busy').removeAttr('data-rpg-live');
        }
        quietStreamText = '';
        quietBefore = null;
        quietIdx = -1;
        lastQuietEndedAt = Date.now();
        if (!quietOrphan) {
            setTimeout(() => {
                quietBusy = false;
                suppressEnded = false;
            }, 400);
        }
    }
}

function scheduleQuietStatus() {
    if (!cfg.quietStatus || quietBusy) {
        return;
    }
    const now = Date.now();
    if (now - lastQuietAt < 8000 || now - lastQuietEndedAt < 5000) {
        return;
    }
    lastQuietAt = now;
    setTimeout(() => {
        runQuietStatus();
    }, 1500);
}

/* ═══════════════════ 扩展设置面板 ═══════════════════ */
function renderSettings() {
    if ($('#rpg_ui_settings_root').length || !$('#extensions_settings').length) {
        return;
    }
    const html = `
    <div id="rpg_ui_settings_root">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>RPG 人物信息卡 · 界面增强</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" title="聊天窗口外层的悬浮人物信息卡（可拖动，实时解析并更新）">
                    <input type="checkbox" id="rpg_ui_card"> 人物信息卡（可拖动悬浮）
                </label>
                <label class="checkbox_label" title="随聊天窗口切换，自动显示该窗口内最活跃的角色">
                    <input type="checkbox" id="rpg_ui_cardauto"> 自动跟随最活跃角色
                </label>
                <label class="checkbox_label" title="在每条消息底部显示状态小条（旧版样式）">
                    <input type="checkbox" id="rpg_ui_strips"> 每楼状态小条（旧版）
                </label>
                <label class="checkbox_label" title="聊天顶部的粘性状态横幅">
                    <input type="checkbox" id="rpg_ui_hud"> 显示顶部「冒险手记」横幅
                </label>
                <label class="checkbox_label" title="玩家自己的消息也显示状态小条">
                    <input type="checkbox" id="rpg_ui_onuser"> 玩家消息同样显示小条
                </label>
                <label class="checkbox_label" title="自动识别 生命/魔力/体力/理智/性欲 等数值并渲染进度条">
                    <input type="checkbox" id="rpg_ui_parse"> 解析数值状态条
                </label>
                <div class="flex-container">
                    <div class="menu_button" id="rpg_ui_restore" title="恢复被 🗑 从信息卡删除的角色">恢复被删除的角色</div>
                </div>
                <label class="checkbox_label" title="状态小条隐藏楼层号与字数段">
                    <input type="checkbox" id="rpg_ui_compact"> 小条紧凑模式
                </label>
                <label class="checkbox_label" title="仅当从未设置过界面语言时才生效">
                    <input type="checkbox" id="rpg_ui_lang"> 首选简体中文界面
                </label>
                <label class="checkbox_label" title="主题为「RPG 冒险者酒馆」时，若配色/背景/头像被其他标签页或扩展覆盖，自动恢复为 RPG 视觉">
                    <input type="checkbox" id="rpg_ui_guard"> RPG 视觉守护（自动修复被覆盖的配色/头像；v2.0.2 起不再接管背景）
                </label>
                <small>信息卡直接取自 AI 回复末尾的状态块（自动隐藏、不出现在对话里）——一次回复同时完成剧情与填卡，无需第二次请求。卡片头部：拖动｜✎ 修改信息（全卡编辑，改完💾保存）｜✨ 推演补全｜🗑 删除｜↺ 重置｜－/＋ 缩放。删除消息时卡片自动回退。</small>
                <hr style="border-color:#3f5f4a;margin:10px 0;">
                <b>🎴 卡片模板（自由编辑：卡片显示的内容 = 发给 AI 的字段格式）</b>
                <small>「## 标题」= 分区标题；「字段名：&lt;说明&gt;」= 卡片上的一行。可随意增删改——删除整行 → 卡片不再显示且 AI 不再填写；新增字段 → 自动显示在卡片"自定义"区；改标题/排序 → 卡片版面随之变化。保存后下次回复起生效。</small>
                <textarea class="text_pole" id="rpg_ui_tpl" rows="14" style="width:100%;font-size:12px;"></textarea>
                <div style="margin:4px 0;">
                    <span class="menu_button" id="rpg_ui_tplsave">💾 保存模板</span>
                    <span class="menu_button" id="rpg_ui_tplreset">↺ 恢复默认模板</span>
                </div>
                <hr style="border-color:#3f5f4a;margin:10px 0;">
                <b>📝 字段填写说明（随协议发送给 AI，像世界书一样）</b>
                <small>这里写每个条目的"解释与变化规则"——保存后每次回复都会随卡片协议一起发给 AI 指导填写；卡片模板本身只保留字段格式。可自由编辑、增删。</small>
                <textarea class="text_pole" id="rpg_ui_notes" rows="10" style="width:100%;font-size:12px;"></textarea>
                <div style="margin:4px 0;">
                    <span class="menu_button" id="rpg_ui_notessave">💾 保存说明</span>
                    <span class="menu_button" id="rpg_ui_notesreset">↺ 恢复默认说明</span>
                </div>
                <hr style="border-color:#3f5f4a;margin:10px 0;">
                <b>🧹 隐藏状态栏正则（仅显示层·已内置）</b>
                <small>回复末尾的【状态栏】块靠这条规则从聊天显示里隐藏——已内置在人物信息卡内，不再占用酒馆的「正则」扩展。只影响显示，绝不影响发给 AI 的内容；如需自定义可在此修改（改动对之后渲染的消息生效）。</small>
                <textarea class="text_pole" id="rpg_ui_hideregex" rows="3" style="width:100%;font-size:12px;"></textarea>
                <div style="margin:4px 0;">
                    <span class="menu_button" id="rpg_ui_hideregexsave">💾 保存正则</span>
                    <span class="menu_button" id="rpg_ui_hideregexreset">↺ 恢复默认正则</span>
                </div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings').append(html);

    const bind = (id, key, after) => {
        $(id).prop('checked', !!cfg[key]).on('change', function () {
            cfg[key] = this.checked;
            save();
            if (after) {
                after();
            }
        });
    };

    bind('#rpg_ui_card', 'infoCard', () => updateCard());
    bind('#rpg_ui_cardauto', 'cardAuto', () => {
        const store = getCardStore();
        if (store) {
            store.auto = !!cfg.cardAuto;
            persistCard();
        }
        updateCard();
    });
    bind('#rpg_ui_strips', 'strips', () => processAll());
    bind('#rpg_ui_hud', 'hudEnabled', () => updateHud());
    bind('#rpg_ui_onuser', 'onUser', () => processAll());
    bind('#rpg_ui_parse', 'parseStats', () => processAll());
    $('#rpg_ui_restore').on('click', () => {
        const st = getCardStore();
        if (st) {
            st.hidden = {};
            persistCard();
        }
        rebuildCardStore();
    });
    bind('#rpg_ui_compact', 'compact', () => processAll());
    bind('#rpg_ui_lang', 'langForce');
    bind('#rpg_ui_guard', 'visualGuard', () => visualGuard());

    /* ── v1.7：卡片模板（卡片显示 + AI 输出格式，一份模板两用） ── */
    $('#rpg_ui_tpl').val((cfg.cardTemplate && String(cfg.cardTemplate).trim()) ? cfg.cardTemplate : DEFAULT_CARD_TEMPLATE);
    $('#rpg_ui_tplsave').on('click', () => {
        let t = String($('#rpg_ui_tpl').val() || '');
        if (t.trim().replace(/\s+/g, '') === DEFAULT_CARD_TEMPLATE.replace(/\s+/g, '')) {
            t = ''; /* 与默认一致 → 存为空 */
        }
        cfg.cardTemplate = t;
        cfg.tplUser = t ? CUSTOM_EPOCH : ''; /* 已保存自定义模板：冻结自动迁移 */
        save();
        applyProtocolPrompt();
        $('#rpg_ui_tpl').val(t || DEFAULT_CARD_TEMPLATE);
        $('#rpg-info-card').removeData('sig');
        updateCard();
        if (typeof toastr !== 'undefined') { toastr.success('卡片模板已保存（下次回复起按新格式填写）'); }
    });
    $('#rpg_ui_tplreset').on('click', () => {
        cfg.cardTemplate = '';
        cfg.tplUser = ''; /* 恢复默认：解除冻结，跟随系统版本 */
        save();
        applyProtocolPrompt();
        $('#rpg_ui_tpl').val(DEFAULT_CARD_TEMPLATE);
        $('#rpg-info-card').removeData('sig');
        updateCard();
        if (typeof toastr !== 'undefined') { toastr.success('已恢复默认模板（框内为默认内容，可继续编辑）'); }
    });

    /* ── v1.9d：字段填写说明（随协议发送给 AI） ── */
    $('#rpg_ui_notes').val((cfg.fieldNotes && String(cfg.fieldNotes).trim()) ? cfg.fieldNotes : DEFAULT_NOTES);
    $('#rpg_ui_notessave').on('click', () => {
        let t = String($('#rpg_ui_notes').val() || '');
        if (t.trim().replace(/\s+/g, '') === DEFAULT_NOTES.replace(/\s+/g, '')) {
            t = ''; /* 与默认一致 → 存为空（跟随默认） */
        }
        cfg.fieldNotes = t;
        cfg.notesUser = t ? CUSTOM_EPOCH : ''; /* 已保存自定义说明：冻结自动迁移 */
        save();
        applyProtocolPrompt();
        $('#rpg_ui_notes').val(t || DEFAULT_NOTES);
        if (typeof toastr !== 'undefined') { toastr.success('字段说明已保存（下次回复起随协议发送给 AI）'); }
    });
    $('#rpg_ui_notesreset').on('click', () => {
        cfg.fieldNotes = '';
        cfg.notesUser = ''; /* 恢复默认：解除冻结 */
        save();
        applyProtocolPrompt();
        $('#rpg_ui_notes').val(DEFAULT_NOTES);
        if (typeof toastr !== 'undefined') { toastr.success('已恢复默认字段说明'); }
    });

    /* ── v1.9f：隐藏状态栏正则（仅显示层，内置） ── */
    $('#rpg_ui_hideregex').val((cfg.hideRegex && String(cfg.hideRegex).trim()) ? cfg.hideRegex : DEFAULT_HIDE_REGEX);
    $('#rpg_ui_hideregexsave').on('click', () => {
        let t = String($('#rpg_ui_hideregex').val() || '');
        if (t.trim() === DEFAULT_HIDE_REGEX) {
            t = ''; /* 与默认一致 → 存为空（跟随默认） */
        }
        cfg.hideRegex = t;
        save();
        $('#rpg_ui_hideregex').val(t || DEFAULT_HIDE_REGEX);
        if (typeof toastr !== 'undefined') { toastr.success('隐藏正则已保存（对之后渲染的消息生效）'); }
    });
    $('#rpg_ui_hideregexreset').on('click', () => {
        cfg.hideRegex = '';
        save();
        $('#rpg_ui_hideregex').val(DEFAULT_HIDE_REGEX);
        if (typeof toastr !== 'undefined') { toastr.success('已恢复默认隐藏正则'); }
    });
}

/* ═══════════════════ 启动 ═══════════════════ */
jQuery(() => {
    try {
        migrateCardTemplateV18();
        migrateCardTemplateV19();
        migrateCardTemplateV19b();
        migrateCardTemplateV19c();
        migrateCardTemplateV19d();
        migrateCardTemplateV19e();
        migrateCardTemplateV19g();
        migrateCardTemplateChgMark();
        migrateCardTemplateV19j();
        migrateCardTemplateV19k();
        renderSettings();
        processAll();
        applyProtocolPrompt();
        registerHideHook();
    } catch (err) {
        console.warn('[RPG-UI] 初始化失败', err);
    }
});

eventSource.on(event_types.APP_READY, () => schedule(() => {
    resetCardAuto();
    migrateCardTemplateV18();
    migrateCardTemplateV19();
    migrateCardTemplateV19b();
    migrateCardTemplateV19c();
    migrateCardTemplateV19d();
    migrateCardTemplateV19e();
    migrateCardTemplateV19g();
    migrateCardTemplateChgMark();
    migrateCardTemplateV19j();
    migrateCardTemplateV19k();
    renderSettings();
    processAll();
    applyProtocolPrompt();
    registerHideHook();
    visualGuard();
}, 200));

/* 看门狗：应显示卡片却缺失时自动重建（进入新聊天 / 切换角色卡等场景） */
setInterval(() => {
    try {
        if (!cfg.enabled || !cfg.infoCard) {
            return;
        }
        const ctx2 = getContext();
        const hasChar = (ctx2.characterId !== undefined && ctx2.characterId !== null && ctx2.characterId !== '')
            || !!ctx2.groupId;
        if (hasChar && !$('#rpg-info-card').length) {
            updateCard();
        }
    } catch (err) { /* 忽略 */ }
}, 5000);

/* 调试入口（控制台可用） */
window.rpgUI = {
    cfg,
    parseBlock,
    scanChat,
    updateCard,
    getCardStore,
    fmtFull,
    requestFill,
    rebuildCardStore,
    runQuietStatus,
    syncPrevCardPrompt,
    buildPrevCardText,
    version: '1.8.0',
};
