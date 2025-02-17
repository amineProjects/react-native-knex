// SQLite3
// -------
import Promise from "bluebird";

import inherits from "inherits";
import { isUndefined, map, assign, defaults } from "lodash";

import Client from "../../client";
import * as helpers from "../../helpers";

import QueryCompiler from "./query/compiler";
import SchemaCompiler from "./schema/compiler";
import ColumnCompiler from "./schema/columncompiler";
import TableCompiler from "./schema/tablecompiler";
import SQLite3_DDL from "./schema/ddl";

function Client_SQLite3(config) {
  Client.call(this, config);
  if (isUndefined(config.useNullAsDefault)) {
    helpers.warn(
      "sqlite does not support inserting default values. Set the " +
        "`useNullAsDefault` flag to hide this warning. " +
        "(see docs http://knexjs.org/#Builder-insert)."
    );
  }
}
inherits(Client_SQLite3, Client);

assign(Client_SQLite3.prototype, {
  dialect: "sqlite3",

  driverName: "sqlite3",

  _driver() {
    return require("sqlite3");
  },

  schemaCompiler() {
    return new SchemaCompiler(this, ...arguments);
  },

  queryCompiler() {
    return new QueryCompiler(this, ...arguments);
  },

  columnCompiler() {
    return new ColumnCompiler(this, ...arguments);
  },

  tableCompiler() {
    return new TableCompiler(this, ...arguments);
  },

  ddl(compiler, pragma, connection) {
    return new SQLite3_DDL(this, compiler, pragma, connection);
  },

  wrapIdentifierImpl(value) {
    return value !== "*" ? `\`${value?.replace(/`/g, "``")}\`` : "*";
  },

  // Get a raw connection from the database, returning a promise with the connection object.
  acquireRawConnection() {
    return new Promise((resolve, reject) => {
      const db = new this.driver.Database(
        this.connectionSettings.filename,
        (err) => {
          if (err) {
            return reject(err);
          }
          resolve(db);
        }
      );
    });
  },

  // Used to explicitly close a connection, called internally by the pool when
  // a connection times out or the pool is shutdown.
  destroyRawConnection(connection) {
    return Promise.fromCallback(connection.close.bind(connection));
  },

  // Runs the query on the specified connection, providing the bindings and any
  // other necessary prep work.
  _query(connection, obj) {
    const { method } = obj;
    let callMethod;
    switch (method) {
      case "insert":
      case "update":
      case "counter":
      case "del":
        callMethod = "run";
        break;
      default:
        callMethod = "all";
    }
    return new Promise(function (resolver, rejecter) {
      if (!connection || !connection[callMethod]) {
        return rejecter(
          new Error(`Error calling ${callMethod} on connection.`)
        );
      }
      connection[callMethod](obj.sql, obj.bindings, function (err, response) {
        if (err) return rejecter(err);
        obj.response = response;

        // We need the context here, as it contains
        // the "this.lastID" or "this.changes"
        obj.context = this;
        return resolver(obj);
      });
    });
  },

  _stream(connection, sql, stream) {
    const client = this;
    return new Promise(function (resolver, rejecter) {
      stream.on("error", rejecter);
      stream.on("end", resolver);
      return client
        ._query(connection, sql)
        .then((obj) => obj.response)
        .map(function (row) {
          stream.write(row);
        })
        .catch(function (err) {
          stream.emit("error", err);
        })
        .then(function () {
          stream.end();
        });
    });
  },

  // Ensures the response is returned in the same format as other clients.
  processResponse(obj, runner) {
    const ctx = obj.context;
    let { response } = obj;
    if (obj.output) return obj.output.call(runner, response);
    switch (obj.method) {
      case "select":
      case "pluck":
      case "first":
        response = helpers.skim(response);
        if (obj.method === "pluck") response = map(response, obj.pluck);
        return obj.method === "first" ? response[0] : response;
      case "insert":
        return [ctx.lastID];
      case "del":
      case "update":
      case "counter":
        return ctx.changes;
      default:
        return response;
    }
  },

  poolDefaults() {
    return defaults(
      { min: 1, max: 1 },
      Client.prototype.poolDefaults.call(this)
    );
  },
});

export default Client_SQLite3;
