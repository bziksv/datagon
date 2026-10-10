#!/usr/bin/env node
/**
 * Импорт данных work.prime-ltd.su из SQL dump в таблицы work_*.
 *
 * Usage:
 *   node scripts/import-work-prime.mjs [/path/to/bziksv_pr_work.sql]
 *   npm run import:work-prime
 *
 * Dump не коммитить. По умолчанию: ~/Downloads/work/bziksv_pr_work.sql
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import readline from 'readline';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');
const config = require('../config');
const { ensureWorkPrimeSchema } = require('../lib/datagonWorkPrimeSchema');
const { matchStaffToUsers } = require('../routes/work');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DUMP = path.join(
    process.env.HOME || '',
    'Downloads/work/bziksv_pr_work.sql'
);

const TABLE_MAP = {
    project_seos: {
        table: 'work_seo_projects',
        // dump cols → our cols; id → legacy_id
        cols: [
            'id',
            'status',
            'our_project',
            'procent_bonus',
            'count_day_fine',
            'procent_fine',
            'procent_for_fine',
            'bonus_add',
            'bonus_enable',
            'positions',
            'enable_procent_seo',
            'name_project',
            'promotion_type',
            'budget',
            'osvoeno',
            'osvoeno_procent',
            'id_glavn_user',
            'procent_seo',
            'summa_zp',
            'startpoint',
            'lp',
            'start',
            'end',
            'aim',
            'region',
            'dogovor_number',
            'contact_person',
            'phone_person',
            'e_mail',
            'value_serialize',
            'created_at',
            'updated_at',
        ],
        legacyKey: 'id',
    },
    pass_seos: {
        table: 'work_seo_passwords',
        cols: [
            'id',
            'status',
            'positions',
            'name_project',
            'id_glavn_user',
            'ssa',
            'ftp',
            'admin_url',
            'admin_login',
            'admin_pass',
            'login',
            'password',
            'value_serialize',
            'created_at',
            'updated_at',
        ],
        legacyKey: 'id',
    },
    pass_devs: {
        table: 'work_dev_passwords',
        cols: [
            'id',
            'status',
            'positions',
            'name_project',
            'id_glavn_user',
            'admin_url',
            'admin_login',
            'admin_pass',
            'ssa',
            'ftp',
            'login',
            'password',
            'value_serialize',
            'created_at',
            'updated_at',
        ],
        legacyKey: 'id',
    },
    project_contexts: {
        table: 'work_context_projects',
        cols: [
            'id',
            'status',
            'our_project',
            'positions',
            'enable_procent_seo',
            'name_project',
            'ya_direct',
            'go_advords',
            'MyTarget',
            'ost_bslsnse_ya',
            'ost_bslsnse_go',
            'id_glavn_user',
            'procent_seo',
            'dogovor_number',
            'contact_person',
            'phone_person',
            'e_mail',
            'value_serialize',
            'created_at',
            'updated_at',
        ],
        legacyKey: 'id',
    },
    pass_contexts: {
        table: 'work_context_passwords',
        cols: [
            'id',
            'status',
            'positions',
            'name_project',
            'id_glavn_user',
            'loginYandex',
            'passYandex',
            'loginGoogle',
            'passGoogle',
            'loginMyTarget',
            'passMyTarget',
            'value_serialize',
            'created_at',
            'updated_at',
        ],
        legacyKey: 'id',
    },
    service_and_passes: {
        table: 'work_services',
        cols: [
            'id',
            'status',
            'positions',
            'name_project',
            'login',
            'password',
            'dop_infa',
            'created_at',
            'updated_at',
        ],
        legacyKey: 'id',
    },
    users: {
        table: 'work_seo_staff',
        cols: [
            'id',
            'positions',
            'name',
            'specialism',
            'level',
            'personal_specialism',
            'seo_procent',
            'sum_many_first',
            'contecst_procent',
            'sum_many_last',
            'itog',
            'email',
            'password',
            'status',
            'visibal',
            'admin',
            'remember_token',
            'created_at',
            'updated_at',
        ],
        legacyKey: 'id',
        isStaff: true,
    },
    sorts: {
        table: 'work_assignees',
        cols: ['id', 'id_user', 'id_table', 'id_type', 'created_at', 'updated_at'],
        legacyKey: 'id',
        isSorts: true,
    },
};

function parseValueTuples(valuesChunk) {
    const rows = [];
    let i = 0;
    const s = valuesChunk;
    while (i < s.length) {
        while (i < s.length && (s[i] === ',' || /\s/.test(s[i]))) i++;
        if (i >= s.length) break;
        if (s[i] !== '(') break;
        i++;
        const fields = [];
        while (i < s.length) {
            while (i < s.length && /\s/.test(s[i])) i++;
            if (s[i] === ')') {
                i++;
                break;
            }
            if (s[i] === ',') {
                i++;
                continue;
            }
            if (s.slice(i, i + 4).toUpperCase() === 'NULL' && !/[A-Za-z0-9_]/.test(s[i + 4] || '')) {
                fields.push(null);
                i += 4;
                continue;
            }
            if (s[i] === "'" || s[i] === '"') {
                const q = s[i++];
                let out = '';
                while (i < s.length) {
                    if (s[i] === '\\') {
                        out += s[i + 1] ?? '';
                        i += 2;
                        continue;
                    }
                    if (s[i] === q) {
                        i++;
                        break;
                    }
                    out += s[i++];
                }
                fields.push(out);
                continue;
            }
            let j = i;
            while (j < s.length && /[0-9eE+.\-]/.test(s[j])) j++;
            fields.push(s.slice(i, j));
            i = j;
        }
        rows.push(fields);
    }
    return rows;
}

async function upsertBatch(db, map, headerCols, rows, stats) {
    if (!rows.length) return;
    for (const fields of rows) {
        const obj = {};
        headerCols.forEach((c, idx) => {
            obj[c] = fields[idx] !== undefined ? fields[idx] : null;
        });
        try {
            if (map.isStaff) {
                const legacyId = Number(obj.id);
                await db.query(
                    `INSERT INTO work_seo_staff
                      (legacy_user_id, name, email, specialism, level, personal_specialism,
                       seo_procent, sum_many_first, contecst_procent, sum_many_last, itog,
                       status, positions, created_at, updated_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                     ON DUPLICATE KEY UPDATE
                       name=VALUES(name), email=VALUES(email), specialism=VALUES(specialism),
                       level=VALUES(level), personal_specialism=VALUES(personal_specialism),
                       seo_procent=VALUES(seo_procent), sum_many_first=VALUES(sum_many_first),
                       contecst_procent=VALUES(contecst_procent), sum_many_last=VALUES(sum_many_last),
                       itog=VALUES(itog), status=VALUES(status), positions=VALUES(positions),
                       updated_at=VALUES(updated_at)`,
                    [
                        legacyId,
                        obj.name || '',
                        obj.email || '',
                        obj.specialism || '',
                        obj.level || '',
                        obj.personal_specialism || '',
                        obj.seo_procent || '',
                        obj.sum_many_first || '',
                        obj.contecst_procent || '',
                        obj.sum_many_last || '',
                        obj.itog || '',
                        Number(obj.status) ? 1 : 0,
                        Number(obj.positions) || 0,
                        obj.created_at || null,
                        obj.updated_at || null,
                    ]
                );
                stats.staff += 1;
            } else if (map.isSorts) {
                await db.query(
                    `INSERT INTO work_assignees
                      (legacy_id, entity_type, entity_legacy_id, legacy_user_id, created_at, updated_at)
                     VALUES (?,?,?,?,?,?)
                     ON DUPLICATE KEY UPDATE
                       entity_type=VALUES(entity_type), entity_legacy_id=VALUES(entity_legacy_id),
                       legacy_user_id=VALUES(legacy_user_id), updated_at=VALUES(updated_at)`,
                    [
                        Number(obj.id),
                        Number(obj.id_type),
                        Number(obj.id_table),
                        Number(obj.id_user),
                        obj.created_at || null,
                        obj.updated_at || null,
                    ]
                );
                stats.assignees += 1;
            } else {
                const legacyId = Number(obj.id);
                const skip = new Set(['id']);
                const destCols = ['legacy_id'];
                const vals = [legacyId];
                for (const c of map.cols) {
                    if (skip.has(c)) continue;
                    if (c === 'created_at' || c === 'updated_at') continue;
                    destCols.push(c);
                    vals.push(obj[c] != null ? obj[c] : c === 'ost_bslsnse_go' ? 0 : '');
                }
                destCols.push('created_at', 'updated_at');
                vals.push(obj.created_at || null, obj.updated_at || null);
                const placeholders = destCols.map(() => '?').join(',');
                const qcols = destCols.map((c) => `\`${c}\``).join(',');
                const updates = destCols
                    .filter((c) => c !== 'legacy_id')
                    .map((c) => `\`${c}\`=VALUES(\`${c}\`)`)
                    .join(', ');
                await db.query(
                    `INSERT INTO \`${map.table}\` (${qcols}) VALUES (${placeholders})
                     ON DUPLICATE KEY UPDATE ${updates}`,
                    vals
                );
                stats[map.table] = (stats[map.table] || 0) + 1;
            }
        } catch (e) {
            stats.errors += 1;
            if (stats.errors < 8) {
                console.warn('row error', map.table, e.message);
            }
        }
    }
}

async function streamImport(dumpPath, db) {
    const stats = { staff: 0, assignees: 0, errors: 0 };
    const wanted = new Set(Object.keys(TABLE_MAP));
    let buf = '';
    let currentTable = null;
    let headerCols = null;
    let inInsert = false;

    const rl = readline.createInterface({
        input: fs.createReadStream(dumpPath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });

    async function flushInsert() {
        if (!inInsert || !currentTable || !buf) {
            buf = '';
            inInsert = false;
            currentTable = null;
            headerCols = null;
            return;
        }
        const map = TABLE_MAP[currentTable];
        const m = buf.match(/INSERT\s+INTO\s+`?[a-z0-9_]+`?\s*(?:\(([^)]*)\))?\s*VALUES\s*([\s\S]*)/i);
        if (m) {
            const hdr = m[1]
                ? m[1].split(',').map((x) => x.replace(/[`\s]/g, ''))
                : map.cols;
            let valuesPart = m[2].trim();
            if (valuesPart.endsWith(';')) valuesPart = valuesPart.slice(0, -1);
            const rows = parseValueTuples(valuesPart);
            await upsertBatch(db, map, hdr, rows, stats);
            process.stdout.write(`\r  ${currentTable}: +${rows.length}          `);
        }
        buf = '';
        inInsert = false;
        currentTable = null;
        headerCols = null;
    }

    for await (const line of rl) {
        if (!inInsert) {
            const im = line.match(/^INSERT\s+INTO\s+`?([a-z0-9_]+)`?/i);
            if (im && wanted.has(im[1])) {
                inInsert = true;
                currentTable = im[1];
                buf = line;
                if (line.trim().endsWith(';')) {
                    await flushInsert();
                }
            }
            continue;
        }
        buf += '\n' + line;
        if (line.trim().endsWith(';')) {
            await flushInsert();
        }
        // safety: huge statement
        if (buf.length > 80 * 1024 * 1024) {
            console.warn('\nbuffer too large, skipping rest of insert for', currentTable);
            buf = '';
            inInsert = false;
            currentTable = null;
        }
    }
    await flushInsert();
    console.log('');
    return stats;
}

async function linkAssigneeEntityIds(db) {
    const typeToTable = {
        1: 'work_seo_passwords',
        2: 'work_context_passwords',
        3: 'work_dev_passwords',
        4: 'work_seo_projects',
        5: 'work_context_projects',
        6: 'work_services',
    };
    for (const [type, table] of Object.entries(typeToTable)) {
        await db.query(
            `UPDATE work_assignees a
             JOIN ${table} t ON t.legacy_id = a.entity_legacy_id
             SET a.entity_id = t.id
             WHERE a.entity_type = ?`,
            [Number(type)]
        );
    }
    await db.query(
        `UPDATE work_assignees a
         JOIN work_seo_staff s ON s.legacy_user_id = a.legacy_user_id
         SET a.datagon_user_id = s.datagon_user_id
         WHERE s.datagon_user_id IS NOT NULL`
    );
}

async function main() {
    const dumpPath = path.resolve(process.argv[2] || DEFAULT_DUMP);
    if (!fs.existsSync(dumpPath)) {
        console.error('Dump not found:', dumpPath);
        process.exit(1);
    }
    console.log('Dump:', dumpPath);
    const db = await mysql.createConnection({
        host: config.db.host,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
        multipleStatements: false,
    });
    const started = new Date();
    await ensureWorkPrimeSchema(db);
    const [metaIns] = await db.query(
        `INSERT INTO work_import_meta (source, started_at, ok) VALUES (?, NOW(), 0)`,
        [dumpPath]
    );
    const metaId = metaIns.insertId;
    try {
        console.log('Streaming import…');
        const stats = await streamImport(dumpPath, db);
        console.log('Matching staff → Datagon users…');
        const match = await matchStaffToUsers(db);
        console.log('Linking assignees…');
        await linkAssigneeEntityIds(db);
        const payload = { ...stats, match };
        await db.query(
            `UPDATE work_import_meta SET finished_at=NOW(), ok=1, stats_json=? WHERE id=?`,
            [JSON.stringify(payload), metaId]
        );
        console.log('Done in', ((Date.now() - started.getTime()) / 1000).toFixed(1), 's');
        console.log(JSON.stringify(payload, null, 2));
    } catch (e) {
        await db.query(
            `UPDATE work_import_meta SET finished_at=NOW(), ok=0, error_text=? WHERE id=?`,
            [String(e && e.message ? e.message : e).slice(0, 2000), metaId]
        );
        throw e;
    } finally {
        await db.end();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
