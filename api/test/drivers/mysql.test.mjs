import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { MySQLConnectionManager } from '../../drivers/mysql/connection.js';
import { UsersDriver } from '../../drivers/mysql/users.js';
import { OrdersDriver } from '../../drivers/mysql/orders.js';
import { bootstrapMySQLDrivers, getMySQLDrivers } from '../../drivers/mysql/index.js';

// ---------------------------------------------------------------------------
// MySQLConnectionManager — buildConfig (pure, no I/O)
// ---------------------------------------------------------------------------

test('buildConfig returns false enabled by default', () => {
    const mgr = new MySQLConnectionManager();
    const cfg = mgr.buildConfig({});
    assert.equal(cfg.enabled, false);
});

test('buildConfig enables when MYSQL_ENABLED=true', () => {
    const mgr = new MySQLConnectionManager();
    const cfg = mgr.buildConfig({ MYSQL_ENABLED: 'true' });
    assert.equal(cfg.enabled, true);
});

test('buildConfig is case-insensitive for MYSQL_ENABLED', () => {
    const mgr = new MySQLConnectionManager();
    assert.equal(mgr.buildConfig({ MYSQL_ENABLED: 'TRUE' }).enabled, true);
    assert.equal(mgr.buildConfig({ MYSQL_ENABLED: 'True' }).enabled, true);
    assert.equal(mgr.buildConfig({ MYSQL_ENABLED: 'false' }).enabled, false);
    assert.equal(mgr.buildConfig({ MYSQL_ENABLED: '0' }).enabled, false);
});

test('buildConfig applies env overrides for all connection fields', () => {
    const mgr = new MySQLConnectionManager();
    const cfg = mgr.buildConfig({
        MYSQL_ENABLED: 'true',
        MYSQL_HOST: 'db.host',
        MYSQL_PORT: '5506',
        MYSQL_USER: 'app_user',
        MYSQL_PASSWORD: 's3cr3t',
        MYSQL_DATABASE: 'mydb',
        MYSQL_CONNECTION_LIMIT: '20',
        MYSQL_WAIT_FOR_CONNECTIONS: 'false',
        MYSQL_QUEUE_LIMIT: '5'
    });

    assert.equal(cfg.host, 'db.host');
    assert.equal(cfg.port, 5506);
    assert.equal(cfg.user, 'app_user');
    assert.equal(cfg.password, 's3cr3t');
    assert.equal(cfg.database, 'mydb');
    assert.equal(cfg.connectionLimit, 20);
    assert.equal(cfg.waitForConnections, false);
    assert.equal(cfg.queueLimit, 5);
});

test('buildConfig uses safe defaults for missing env vars', () => {
    const mgr = new MySQLConnectionManager();
    const cfg = mgr.buildConfig({});
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.port, 3306);
    assert.equal(cfg.user, 'root');
    assert.equal(cfg.password, '');
    assert.equal(cfg.database, 'orderbook');
    assert.equal(cfg.connectionLimit, 10);
    assert.equal(cfg.waitForConnections, true);
    assert.equal(cfg.queueLimit, 0);
});

// ---------------------------------------------------------------------------
// MySQLConnectionManager — getPool guard
// ---------------------------------------------------------------------------

test('getPool throws when pool is not initialized', () => {
    const mgr = new MySQLConnectionManager();
    assert.throws(() => mgr.getPool(), /MySQL pool is not initialized/);
});

// ---------------------------------------------------------------------------
// MySQLConnectionManager — escapeIdentifier
// ---------------------------------------------------------------------------

test('escapeIdentifier wraps value in backticks', () => {
    const mgr = new MySQLConnectionManager();
    assert.equal(mgr.escapeIdentifier('mydb'), '`mydb`');
});

test('escapeIdentifier escapes embedded backticks', () => {
    const mgr = new MySQLConnectionManager();
    assert.equal(mgr.escapeIdentifier('my`db'), '`my``db`');
});

test('escapeIdentifier coerces non-string values', () => {
    const mgr = new MySQLConnectionManager();
    assert.equal(mgr.escapeIdentifier(42), '`42`');
});

// ---------------------------------------------------------------------------
// MySQLConnectionManager — initializeFromEnv with MYSQL_ENABLED=false
// ---------------------------------------------------------------------------

test('initializeFromEnv returns false when MYSQL_ENABLED=false', async () => {
    const mgr = new MySQLConnectionManager();
    const messages = [];
    const logger = { log: (m) => messages.push(m) };
    const result = await mgr.initializeFromEnv({ env: {}, logger });
    assert.equal(result, false);
    assert.equal(mgr.pool, null);
    assert.ok(messages.some((m) => /MYSQL_ENABLED=false/i.test(m)));
});

test('initializeFromEnv is idempotent after disabled init', async () => {
    const mgr = new MySQLConnectionManager();
    const logger = { log: () => {} };
    await mgr.initializeFromEnv({ env: {}, logger });
    const second = await mgr.initializeFromEnv({ env: {}, logger });
    assert.equal(second, false);
});

// ---------------------------------------------------------------------------
// bootstrapMySQLDrivers / getMySQLDrivers — disabled path
// ---------------------------------------------------------------------------

test('bootstrapMySQLDrivers returns null when MYSQL_ENABLED=false', async () => {
    const result = await bootstrapMySQLDrivers({ env: {}, logger: { log: () => {} } });
    assert.equal(result, null);
});

test('getMySQLDrivers throws when drivers are not initialized', () => {
    assert.throws(() => getMySQLDrivers(), /MySQL drivers are not initialized/);
});

// ---------------------------------------------------------------------------
// UsersDriver — constructor and public method surface
// ---------------------------------------------------------------------------

test('UsersDriver exposes required public methods', () => {
    const driver = new UsersDriver(() => {});
    const methods = ['createUser', 'getUserById', 'listUsers', 'updateUser', 'rechargeCredits', 'deleteUser'];
    for (const method of methods) {
        assert.equal(typeof driver[method], 'function', `UsersDriver.${method} should be a function`);
    }
});

// ---------------------------------------------------------------------------
// OrdersDriver — constructor and public method surface
// ---------------------------------------------------------------------------

test('OrdersDriver exposes required public methods', () => {
    const driver = new OrdersDriver(() => {});
    const methods = ['createOrder', 'getOrderById', 'listOrders', 'updateOrder', 'markOrderConsumed', 'consumeOrderForUse', 'unconsumOrderForUse'];
    for (const method of methods) {
        assert.equal(typeof driver[method], 'function', `OrdersDriver.${method} should be a function`);
    }
});

// ---------------------------------------------------------------------------
// SQL confinement — no SQL keywords outside api/drivers/mysql
// ---------------------------------------------------------------------------

const SQL_PATTERN = /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/i;

function collectJsFiles(dir, files = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue;
            collectJsFiles(full, files);
        } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
            files.push(full);
        }
    }
    return files;
}

test('no SQL keywords appear outside api/drivers/mysql', () => {
    const apiDir = new URL('../../', import.meta.url).pathname;
    const mysqlDriverDir = join(apiDir, 'drivers', 'mysql');

    const violations = [];

    for (const file of collectJsFiles(apiDir)) {
        const rel = relative(apiDir, file);
        // Skip the mysql driver files themselves and test files
        if (file.startsWith(mysqlDriverDir)) continue;
        if (rel.startsWith('test' + '/') || rel.startsWith('test\\')) continue;

        const src = readFileSync(file, 'utf8');
        const lines = src.split('\n');
        lines.forEach((line, i) => {
            if (SQL_PATTERN.test(line)) {
                violations.push(`${rel}:${i + 1}: ${line.trim()}`);
            }
        });
    }

    assert.deepEqual(violations, [], `SQL found outside drivers/mysql:\n${violations.join('\n')}`);
});
