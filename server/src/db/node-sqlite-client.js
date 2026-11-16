import { createRequire } from 'node:module';

/**
 * Knex client for SQLite that uses Node's built-in `node:sqlite` module.
 * Local development only. No native npm package is needed, so `npm install`
 * works on Windows without Python or Visual Studio build tools.
 */
const require = createRequire(import.meta.url);
const ClientBetterSQLite3 = require('knex/lib/dialects/better-sqlite3');

export class NodeSqliteClient extends ClientBetterSQLite3 {
  _driver() {
    // loaded lazily so production (Azure SQL / PostgreSQL) never touches it
    return require('node:sqlite');
  }

  async acquireRawConnection() {
    return new this.driver.DatabaseSync(this.connectionSettings.filename);
  }

  async destroyRawConnection(connection) {
    connection.close();
  }

  async _query(connection, obj) {
    if (!obj.sql) throw new Error('The query is empty');
    if (!connection) throw new Error('No connection provided');

    const statement = connection.prepare(obj.sql);
    const bindings = this._formatBindings(obj.bindings);

    // statements that return rows have result columns
    if (statement.columns().length > 0) {
      obj.response = statement.all(...bindings);
      return obj;
    }
    const response = statement.run(...bindings);
    obj.response = response;
    obj.context = { lastID: response.lastInsertRowid, changes: response.changes };
    return obj;
  }

  _formatBindings(bindings) {
    return super._formatBindings(bindings).map((b) => (b === undefined ? null : b));
  }
}

Object.assign(NodeSqliteClient.prototype, { driverName: 'node:sqlite' });
