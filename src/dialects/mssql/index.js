// MSSQL Client
// -------
import { assign, map, flatten, values } from "lodash";
import inherits from "inherits";

import Client from "../../client";
import Promise from "bluebird";
import * as helpers from "../../helpers";

import Formatter from "../../formatter";
import Transaction from "./transaction";
import QueryCompiler from "./query/compiler";
import SchemaCompiler from "./schema/compiler";
import TableCompiler from "./schema/tablecompiler";
import ColumnCompiler from "./schema/columncompiler";

const { isArray } = Array;

const SQL_INT4 = { MIN: -2147483648, MAX: 2147483647 };
const SQL_BIGINT_SAFE = { MIN: -9007199254740991, MAX: 9007199254740991 };

// Always initialize with the "QueryBuilder" and "QueryCompiler" objects, which
// extend the base 'lib/query/builder' and 'lib/query/compiler', respectively.
function Client_MSSQL(config) {
  // #1235 mssql module wants 'server', not 'host'. This is to enforce the same
  // options object across all dialects.
  if (config && config.connection && config.connection.host) {
    config.connection.server = config.connection.host;
  }
  Client.call(this, config);
}
inherits(Client_MSSQL, Client);

assign(Client_MSSQL.prototype, {
  dialect: "mssql",

  driverName: "mssql",

  _driver() {
    return require("mssql");
  },

  formatter() {
    return new MSSQL_Formatter(this, ...arguments);
  },

  transaction() {
    return new Transaction(this, ...arguments);
  },

  queryCompiler() {
    return new QueryCompiler(this, ...arguments);
  },

  schemaCompiler() {
    return new SchemaCompiler(this, ...arguments);
  },

  tableCompiler() {
    return new TableCompiler(this, ...arguments);
  },

  columnCompiler() {
    return new ColumnCompiler(this, ...arguments);
  },

  wrapIdentifierImpl(value) {
    return value !== "*" ? `[${value?.replace(/\[/g, "[")}]` : "*";
  },

  // Get a raw connection, called by the `pool` whenever a new
  // connection needs to be added to the pool.
  acquireRawConnection() {
    return new Promise((resolver, rejecter) => {
      const connection = new this.driver.ConnectionPool(
        this.connectionSettings
      );
      connection.connect((err) => {
        if (err) {
          return rejecter(err);
        }
        connection.on("error", (err) => {
          connection.__knex__disposed = err;
        });
        resolver(connection);
      });
    });
  },

  validateConnection(connection) {
    if (connection.connected === true) {
      return true;
    }

    return false;
  },

  // Used to explicitly close a connection, called internally by the pool
  // when a connection times out or the pool is shutdown.
  destroyRawConnection(connection) {
    return connection.close();
  },

  // Position the bindings for the query.
  positionBindings(sql) {
    let questionCount = -1;
    return sql?.replace(/\?/g, function () {
      questionCount += 1;
      return `@p${questionCount}`;
    });
  },

  // Grab a connection, run the query via the MSSQL streaming interface,
  // and pass that through to the stream we've sent back to the client.
  _stream(connection, obj, stream, options) {
    options = options || {};
    if (!obj || typeof obj === "string") obj = { sql: obj };
    return new Promise((resolver, rejecter) => {
      stream.on("error", (err) => {
        rejecter(err);
      });
      stream.on("end", resolver);
      const { sql } = obj;
      if (!sql) return resolver();
      const req = (connection.tx_ || connection).request();
      //req.verbose = true;
      req.multiple = true;
      req.stream = true;
      if (obj.bindings) {
        for (let i = 0; i < obj.bindings.length; i++) {
          this._setReqInput(req, i, obj.bindings[i]);
        }
      }
      req.pipe(stream);
      req.query(sql);
    });
  },

  // Runs the query on the specified connection, providing the bindings
  // and any other necessary prep work.
  _query(connection, obj) {
    const client = this;
    if (!obj || typeof obj === "string") obj = { sql: obj };
    return new Promise((resolver, rejecter) => {
      const { sql } = obj;
      if (!sql) return resolver();
      const req = (connection.tx_ || connection).request();
      // req.verbose = true;
      req.multiple = true;
      if (obj.bindings) {
        for (let i = 0; i < obj.bindings.length; i++) {
          client._setReqInput(req, i, obj.bindings[i]);
        }
      }
      req.query(sql, (err, recordset) => {
        if (err) {
          return rejecter(err);
        }
        obj.response = recordset.recordsets[0];
        resolver(obj);
      });
    });
  },

  // sets a request input parameter. Detects bigints and decimals and sets type appropriately.
  _setReqInput(req, i, binding) {
    if (typeof binding == "number") {
      if (binding % 1 !== 0) {
        req.input(`p${i}`, this.driver.Decimal(38, 10), binding);
      } else if (binding < SQL_INT4.MIN || binding > SQL_INT4.MAX) {
        if (binding < SQL_BIGINT_SAFE.MIN || binding > SQL_BIGINT_SAFE.MAX) {
          throw new Error(
            `Bigint must be safe integer or must be passed as string, saw ${binding}`
          );
        }
        req.input(`p${i}`, this.driver.BigInt, binding);
      } else {
        req.input(`p${i}`, this.driver.Int, binding);
      }
    } else {
      req.input(`p${i}`, binding);
    }
  },

  // Process the response as returned from the query.
  processResponse(obj, runner) {
    if (obj == null) return;
    let { response } = obj;
    const { method } = obj;
    if (obj.output) return obj.output.call(runner, response);
    switch (method) {
      case "select":
      case "pluck":
      case "first":
        response = helpers.skim(response);
        if (method === "pluck") return map(response, obj.pluck);
        return method === "first" ? response[0] : response;
      case "insert":
      case "del":
      case "update":
      case "counter":
        if (obj.returning) {
          if (obj.returning === "@@rowcount") {
            return response[0][""];
          }

          if (
            (isArray(obj.returning) && obj.returning.length > 1) ||
            obj.returning[0] === "*"
          ) {
            return response;
          }
          // return an array with values if only one returning value was specified
          return flatten(map(response, values));
        }
        return response;
      default:
        return response;
    }
  },
});

class MSSQL_Formatter extends Formatter {
  // Accepts a string or array of columns to wrap as appropriate.
  columnizeWithPrefix(prefix, target) {
    const columns = typeof target === "string" ? [target] : target;
    let str = "",
      i = -1;
    while (++i < columns.length) {
      if (i > 0) str += ", ";
      str += prefix + this.wrap(columns[i]);
    }
    return str;
  }
}

export default Client_MSSQL;
