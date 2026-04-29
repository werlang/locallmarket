import mysql from 'mysql2/promise';
import { CustomError } from './error.js';
import mysqldump from 'mysqldump';

export class Mysql {
        
    static connected = false;
    static connection = null;
    static config = {
        host: 'mysql',
        user: 'root',
        password: process.env.MYSQL_ROOT_PASSWORD,
        database: process.env.MYSQL_DATABASE,
        port: 3306,
    }

    /**
     * Opens the shared MySQL connection pool when needed.
     */
    static async connect(config = {}) {
        if (Mysql.connected) return this;

        if (process.env.NODE_ENV == 'test') {
            Mysql.originalDatabase = process.env.MYSQL_DATABASE;
            Mysql.config.database = Mysql.originalDatabase + '_test_' + process.env.TEST_DATABASE_ID;
        }

        Mysql.connection = mysql.createPool({ ...config, ...Mysql.config });
        Mysql.connected = true;
        return this;
    }

    /**
     * Closes the shared MySQL connection pool.
     */
    static async close() {
        if (!Mysql.connected) return this;
        Mysql.connection.end();
        Mysql.connected = false;
    }

    /**
     * Quotes a SQL identifier, including dotted table/column references.
     */
    static #quoteIdentifier(identifier) {
        return String(identifier)
            .split('.')
            .map(part => part === '*' ? '*' : `\`${part}\``)
            .join('.');
    }

    /**
     * Executes a formatted SQL statement through mysql2.
     */
    static async #query(sql, data) {
        // console.log(sql, data);
        await Mysql.connect();

        const raw = Mysql.formatRaw(sql, data);
        // console.log(raw);
        // console.log(Mysql.format(sql, data));
        try {
            const result = await Mysql.connection.execute(raw.sql.trim(), raw.data);
            if (result) return result[0];
            return result;
        }
        catch (error) {
            throw new CustomError(error.message, {
                sql: raw.sql,
                data: raw.data,
                error,
            });
        }
    }

    /**
     * Inserts one or many rows into the provided table.
     */
    static async insert(table, data) {
        if (!data) {
            throw new CustomError('Invalid data for insert operation.');
        }
        if (!Array.isArray(data)) data = [ data ];

        return Promise.all(data.map(row => {
            const values = Object.values(row);
            const fields = Object.keys(row).map(k => `\`${k}\``);
            let sql = `INSERT INTO \`${table}\` (${fields.join(',')}) VALUES (${values.map(() => '?').join(',')})`;
            return Mysql.#query(sql, values);
        }));
    }

    /**
     * Updates rows in the provided table using an id or filter clause.
     */
    static async update(table, data, id) {
        if (!id) {
            throw new CustomError('No identifier provided for update.');
        }
        if (!Object.keys(data).length) {
            throw new CustomError('No data to update.');
        }

        // remove undefined values
        data = Object.fromEntries(Object.entries(data).filter(([k,v]) => v !== undefined));

        const values = Object.values(data);
        const fielsdSql = Object.entries(data).map(([k,v],i) => {
            if (v !== null && typeof v === 'object') {
                if (Object.keys(v)[0] === 'inc'){
                    values[i] = v.inc;
                    return `\`${k}\` = ${k} + ?`;
                }
                else if (Object.keys(v)[0] === 'dec'){
                    values[i] = v.dec;
                    return `\`${k}\` = ${k} - ?`;
                }
                else {
                    throw new CustomError('Invalid update operation.');
                }
            }

            return `\`${k}\` = ?`;
        }).join(', ');

        if (typeof id === 'object') {
            const { statement, values: v } = this.getWhereStatements(id);
            id = statement;
            values.push(...v);
        }
        else {
            values.push(id);
            id = '\`id\` = ?';
        }

        const sql = `UPDATE \`${table}\` SET ${fielsdSql} WHERE ${id}`;
        // console.log(Mysql.format(sql, data));
        // replicateDB.saveUpdate(table, sql, data, this);
        return Mysql.#query(sql, values);
    }

    /**
     * Deletes rows in the provided table using an id or filter clause.
     */
    static async delete(table, clause, opt={}) {
        if (!clause) {
            throw new CustomError('Invalid clause for delete operation.');
        }

        const limit = opt.limit ? `LIMIT ${ opt.limit }` : '';

        let sql = '';
        const data = [];

        // check if clause is an object
        if (typeof clause === 'object'){
            const { statement, values } = Mysql.getWhereStatements(clause);
            sql = `DELETE FROM \`${table}\` WHERE ${statement} ${limit}`;
            data.push(...values);
        }
        else {
            sql = `DELETE FROM \`${table}\` WHERE id = ?`;
            data.push(clause);
        }
        
        return Mysql.#query(sql, data);
    }

    /**
     * Builds a SQL WHERE clause and placeholder values from a filter object.
     */
    static getWhereStatements(filter) {
        let values = [];

        const statement = Object.entries(filter).map(([k,v],i) => {
            // email: null
            if (v === null) return `${Mysql.#quoteIdentifier(k)} IS NULL`;

            if (Array.isArray(v)){
                // age: [18, 19, 20]
                if (v.length === 0) return '1=0';
                
                // add all values to the values array
                values.push(...v);
                return `${Mysql.#quoteIdentifier(k)} IN (${v.map(() => '?').join(',')})`;
            }
            else if (typeof v === 'object'){
                // age: { in: [18, 19, 20] }
                if (Object.keys(v)[0] === 'in'){
                    if (!Array.isArray(v.in) || v.in.length === 0) return '1=0';
                    
                    // add all values to the values array
                    values.push(...v.in);
                    return `${Mysql.#quoteIdentifier(k)} IN (${v.in.map(() => '?').join(',')})`;
                }

                // age: { between: [18, 20] }
                if (Object.keys(v)[0] === 'between'){
                    // add 2 values to the values array
                    values.push(v.between[0], v.between[1]);
                    return `${Mysql.#quoteIdentifier(k)} BETWEEN ? AND ?`;
                }

                // name: { like: '%John%' }
                if (Object.keys(v)[0] === 'like'){
                    // replace the value with the like value
                    values.push(`%${v.like}%`);
                    return `${Mysql.#quoteIdentifier(k)} LIKE ?`;
                }

                // name: { not: 'John' }
                if (Object.keys(v)[0] === 'not'){
                    // name: { not: null }
                    if (v.not === null) return `${Mysql.#quoteIdentifier(k)} IS NOT NULL`;
                    values.push(v.not);
                    return `${Mysql.#quoteIdentifier(k)} != ?`;
                }

                // age: { '>=': 18 }
                const e = Object.keys(v)[0];
                values.push(Object.values(v)[0]);
                return `${Mysql.#quoteIdentifier(k)} ${e} ?`;
            }

            // name: 'John'
            values.push(v);
            return `${Mysql.#quoteIdentifier(k)} = ?`;
        }).join(' AND ');

        return { statement, values };
    }

    /**
     * Finds rows in the provided table using filter, projection, and paging options.
     */
    static async find(table, { filter={}, view=[], opt={}} = {}) {
        view = Array.isArray(view) ? view : [ view ];
        view = view.length > 0 ? view.map(v => Mysql.#quoteIdentifier(v)).join(',') : '*';

        // filter not an object
        if (typeof filter !== 'object') {
            throw new CustomError('Invalid filter for find operation.');
        }

        const filterNames = Object.keys(filter);
        let values = Object.values(filter);
        // WHERE name = ? AND age >= ?
        const {
            statement: whereStatements,
            values: whereValues,
        } = Mysql.getWhereStatements(filter);
        values = whereValues;

        const where = filterNames.length > 0 ? `WHERE ${ whereStatements }` : '';

        // ORDER BY id DESC
        const order = opt.order
            ? `ORDER BY ${ Mysql.#quoteIdentifier(Object.keys(opt.order)[0]) } ${ Object.values(opt.order)[0] === 1 ? 'ASC' : 'DESC' }`
            : '';
        
        // LIMIT 10
        const limit = opt.limit ? `LIMIT ${ opt.limit }` : '';
        
        // OFFSET 10
        const offset = opt.skip ? `OFFSET ${ opt.skip }` : '';

        const sql = `SELECT ${view} FROM \`${table}\` ${where} ${order} ${limit} ${offset}`;
        // console.log(sql, values);
        return Mysql.#query(sql, values);
    }

    /**
     * Wraps a raw SQL fragment so mysql2 preserves it during formatting.
     */
    static raw(str) {
        return { toSqlString: () => str };
    }

    /**
     * Expands raw SQL fragments before mysql2 executes the statement.
     */
    static formatRaw(sql, data) {
        const originalSql = sql;
        const pieces = sql.split('?');

        if (pieces.length > 1){
            let join = pieces.shift();
            
            try {
                data.forEach(d => {
                    if (d && d.toSqlString){
                        join += d.toSqlString();
                    }
                    else{
                        join += '?';
                    }
                    join += pieces.shift();
                });

                sql = join;
            }
            catch(error) {
                sql = originalSql;
            }

                data = Array.isArray(data)
                    ? data.filter(e => !e || !e.toSqlString)
                    : data;
        }
        
        return { sql, data };
    }

    /**
     * Delegates SQL formatting to the active mysql2 connection.
     */
    static format(sql, data) {
        if (!Mysql.connection) {
            throw new CustomError('Database not connected.');
        }
        return Mysql.connection.format(sql, data);
    }

    /**
     * Converts a timestamp-like value into MySQL DATETIME format.
     */
    static toDateTime(timestamp) {
        return new Date(timestamp).toISOString().replace('T', ' ').replace('Z', '');
    }

    /**
     * Builds a LIKE filter helper.
     */
    static like(str) {
        return { like: str };
    }

    /**
     * Builds a BETWEEN filter helper.
     */
    static between(a, b) {
        return { between: [ a, b ] };
    }

    /**
     * Builds a not equal filter helper.
     */
    static ne(value) {
        return { not: value };
    }

    /**
     * Builds a less-than filter helper.
     */
    static lt(value) {
        return { '<': value };
    }

    /**
     * Builds a greater-than filter helper.
     */
    static gt(value) {
        return { '>': value };
    }

    /**
     * Builds a less-than-or-equal filter helper.
     */
    static lte(value) {
        return { '<=': value };
    }

    /**
     * Builds a greater-than-or-equal filter helper.
     */
    static gte(value) {
        return { '>=': value };
    }
}
