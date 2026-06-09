/**
 * One-time migration: SDC Scheduler SQLite → MySQL
 * Run: node migrate-to-mysql.js
 */
require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const mysql = require('mysql2/promise');
const path = require('path');

const SQLITE_PATH = path.join(__dirname, 'scheduler.db');

async function migrate() {
    console.log('=== SDC Scheduler SQLite → MySQL Migration ===\n');

    // ── SQLite source ──────────────────────────────────────────────────────────
    const sqlite = new DatabaseSync(SQLITE_PATH);
    console.log(`SQLite: ${SQLITE_PATH}`);

    // ── MySQL target ───────────────────────────────────────────────────────────
    const pool = await mysql.createPool({
        host:     process.env.MYSQL_HOST     || 'localhost',
        port:     Number(process.env.MYSQL_PORT) || 3306,
        user:     process.env.MYSQL_USER     || 'root',
        password: process.env.MYSQL_PASSWORD || '',
        database: process.env.MYSQL_DATABASE || 'sdc_scheduler',
        waitForConnections: true,
        connectionLimit: 5,
        timezone: 'Z',
        multipleStatements: false,
    });
    const conn = await pool.getConnection();
    console.log(`MySQL:  ${process.env.MYSQL_HOST || 'localhost'}/${process.env.MYSQL_DATABASE || 'sdc_scheduler'}\n`);

    let totalMigrated = 0;

    try {
        // ── projects ──────────────────────────────────────────────────────────
        console.log('Migrating projects...');
        const projects = sqlite.prepare('SELECT * FROM projects').all();
        if (projects.length) {
            await conn.beginTransaction();
            for (const r of projects) {
                await conn.execute(
                    `INSERT IGNORE INTO projects (id,name,status,is_template,job_number,workspace,created_at)
                     VALUES (?,?,?,?,?,?,?)`,
                    [r.id, r.name, r.status||'active', r.is_template||0, r.job_number||null, r.workspace||'default', r.created_at||null]
                );
            }
            await conn.commit();
            console.log(`  projects: ${projects.length} rows`);
            totalMigrated += projects.length;
        } else { console.log('  projects: 0 rows'); }

        // ── tasks ─────────────────────────────────────────────────────────────
        console.log('Migrating tasks...');
        const tasks = sqlite.prepare('SELECT * FROM tasks').all();
        if (tasks.length) {
            await conn.beginTransaction();
            for (const r of tasks) {
                await conn.execute(
                    `INSERT IGNORE INTO tasks
                     (id,name,project,phase,phase_group,department,sub_department,assignee,
                      start_date,end_date,duration_days,predecessors,is_milestone,is_action,
                      progress,allocation,priority,notes,sort_order,anchor_key,
                      baseline_start_date,baseline_end_date,duration_link_task_id,
                      completed_on,machine,version,created_at,updated_at,updated_by)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [r.id, r.name, r.project||null, r.phase||null, r.phase_group||null,
                     r.department||null, r.sub_department||null, r.assignee||null,
                     r.start_date||null, r.end_date||null, r.duration_days||null,
                     r.predecessors||null, r.is_milestone||0, r.is_action||0,
                     r.progress||0, r.allocation||90, r.priority||null,
                     r.notes||null, r.sort_order||null, r.anchor_key||null,
                     r.baseline_start_date||null, r.baseline_end_date||null,
                     r.duration_link_task_id||null, r.completed_on||null,
                     r.machine||null, r.version||0,
                     r.created_at||null, r.updated_at||null, r.updated_by||null]
                );
            }
            await conn.commit();
            console.log(`  tasks: ${tasks.length} rows`);
            totalMigrated += tasks.length;
        } else { console.log('  tasks: 0 rows'); }

        // ── team_members ──────────────────────────────────────────────────────
        console.log('Migrating team_members...');
        const members = sqlite.prepare('SELECT * FROM team_members').all();
        if (members.length) {
            await conn.beginTransaction();
            for (const r of members) {
                await conn.execute(
                    `INSERT IGNORE INTO team_members (id,name,discipline,active,sort_order,is_lead,specialty,created_at)
                     VALUES (?,?,?,?,?,?,?,?)`,
                    [r.id, r.name, r.discipline, r.active??1, r.sort_order||null, r.is_lead||0, r.specialty||null, r.created_at||null]
                );
            }
            await conn.commit();
            console.log(`  team_members: ${members.length} rows`);
            totalMigrated += members.length;
        } else { console.log('  team_members: 0 rows'); }

        // ── settings ──────────────────────────────────────────────────────────
        console.log('Migrating settings...');
        const settings = sqlite.prepare('SELECT * FROM settings').all();
        if (settings.length) {
            await conn.beginTransaction();
            for (const r of settings) {
                await conn.execute(
                    `INSERT INTO settings (\`key\`,value,updated_at) VALUES (?,?,?)
                     ON DUPLICATE KEY UPDATE value=VALUES(value), updated_at=VALUES(updated_at)`,
                    [r.key, r.value, r.updated_at||null]
                );
            }
            await conn.commit();
            console.log(`  settings: ${settings.length} rows`);
            totalMigrated += settings.length;
        } else { console.log('  settings: 0 rows'); }

        // ── project_financials ────────────────────────────────────────────────
        console.log('Migrating project_financials...');
        const fins = sqlite.prepare('SELECT * FROM project_financials').all();
        if (fins.length) {
            await conn.beginTransaction();
            for (const r of fins) {
                await conn.execute(
                    `INSERT IGNORE INTO project_financials
                     (id,project,name,percent,amount,due_date,paid,predecessors,sync_to_anchor,sort_order,created_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                    [r.id, r.project, r.name, r.percent??null, r.amount??null,
                     r.due_date||null, r.paid||0, r.predecessors||null,
                     r.sync_to_anchor||null, r.sort_order||null, r.created_at||null]
                );
            }
            await conn.commit();
            console.log(`  project_financials: ${fins.length} rows`);
            totalMigrated += fins.length;
        } else { console.log('  project_financials: 0 rows'); }

        // ── task_history ──────────────────────────────────────────────────────
        console.log('Migrating task_history...');
        const history = sqlite.prepare('SELECT * FROM task_history').all();
        if (history.length) {
            await conn.beginTransaction();
            for (const r of history) {
                await conn.execute(
                    `INSERT IGNORE INTO task_history
                     (id,task_id,project,action,changed_by,changed_at,before_json,after_json,changed_fields)
                     VALUES (?,?,?,?,?,?,?,?,?)`,
                    [r.id, r.task_id||null, r.project||null, r.action,
                     r.changed_by||null, r.changed_at||null,
                     r.before_json||null, r.after_json||null, r.changed_fields||null]
                );
            }
            await conn.commit();
            console.log(`  task_history: ${history.length} rows`);
            totalMigrated += history.length;
        } else { console.log('  task_history: 0 rows'); }

        // ── task_comments ─────────────────────────────────────────────────────
        console.log('Migrating task_comments...');
        const comments = sqlite.prepare('SELECT * FROM task_comments').all();
        if (comments.length) {
            await conn.beginTransaction();
            for (const r of comments) {
                await conn.execute(
                    `INSERT IGNORE INTO task_comments
                     (id,task_id,project,author_id,author_name,body,mentions,created_at,updated_at)
                     VALUES (?,?,?,?,?,?,?,?,?)`,
                    [r.id, r.task_id, r.project||null, r.author_id||null,
                     r.author_name, r.body, r.mentions||null,
                     r.created_at||null, r.updated_at||null]
                );
            }
            await conn.commit();
            console.log(`  task_comments: ${comments.length} rows`);
            totalMigrated += comments.length;
        } else { console.log('  task_comments: 0 rows'); }

        // ── notification_log ──────────────────────────────────────────────────
        console.log('Migrating notification_log...');
        const notifs = sqlite.prepare('SELECT * FROM notification_log').all();
        if (notifs.length) {
            await conn.beginTransaction();
            for (const r of notifs) {
                await conn.execute(
                    `INSERT IGNORE INTO notification_log (id,user_email,type,task_id,sent_at,reference_key)
                     VALUES (?,?,?,?,?,?)`,
                    [r.id, r.user_email, r.type, r.task_id||null, r.sent_at||null, r.reference_key||null]
                );
            }
            await conn.commit();
            console.log(`  notification_log: ${notifs.length} rows`);
            totalMigrated += notifs.length;
        } else { console.log('  notification_log: 0 rows'); }

        // ── users ─────────────────────────────────────────────────────────────
        console.log('Migrating users...');
        const users = sqlite.prepare('SELECT * FROM users').all();
        if (users.length) {
            await conn.beginTransaction();
            for (const r of users) {
                await conn.execute(
                    `INSERT IGNORE INTO users
                     (id,email,name,password_hash,role,avatar_color,active,created_at,last_login)
                     VALUES (?,?,?,?,?,?,?,?,?)`,
                    [r.id, r.email, r.name, r.password_hash,
                     r.role||'editor', r.avatar_color||'#1574c4', r.active??1,
                     r.created_at||null, r.last_login||null]
                );
            }
            await conn.commit();
            console.log(`  users: ${users.length} rows`);
            totalMigrated += users.length;
        } else { console.log('  users: 0 rows'); }

        // ── fix AUTO_INCREMENT to avoid PK collisions ─────────────────────────
        console.log('\nFixing AUTO_INCREMENT counters...');
        const tables = ['projects','tasks','team_members','project_financials','task_history','task_comments','notification_log','users'];
        for (const t of tables) {
            const [[maxRow]] = await conn.execute(`SELECT COALESCE(MAX(id),0)+1 AS next FROM \`${t}\``);
            await conn.execute(`ALTER TABLE \`${t}\` AUTO_INCREMENT = ${maxRow.next}`);
        }
        console.log('  AUTO_INCREMENT counters updated.');

        // ── verify ────────────────────────────────────────────────────────────
        console.log('\n=== Verification ===');
        const allTables = ['projects','tasks','team_members','settings','project_financials','task_history','task_comments','notification_log','users'];
        for (const t of allTables) {
            const [[row]] = await conn.execute(`SELECT COUNT(*) AS n FROM \`${t}\``);
            console.log(`  ${t}: ${row.n} rows`);
        }

        console.log(`\n✓ Migration complete — ${totalMigrated} total rows migrated.`);

    } catch (err) {
        await conn.rollback().catch(() => {});
        console.error('\n✗ Migration FAILED:', err.message);
        process.exit(1);
    } finally {
        conn.release();
        await pool.end();
        sqlite.close();
    }
}

migrate();
