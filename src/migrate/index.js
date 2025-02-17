// Migrator
// -------
// import fs from "fs";
import path from "path";
// import mkdirp from "mkdirp";
import Promise from "bluebird";
import * as helpers from "../helpers";
import {
  assign,
  bind,
  difference,
  each,
  filter,
  get,
  includes,
  isBoolean,
  isEmpty,
  isUndefined,
  map,
  max,
  // template,
} from "lodash";
import inherits from "inherits";

function LockError(msg) {
  this.name = "MigrationLocked";
  this.message = msg;
}
inherits(LockError, Error);

const CONFIG_DEFAULT = Object.freeze({
  extension: "js",
  loadExtensions: [
    ".co",
    ".coffee",
    ".eg",
    ".iced",
    ".js",
    ".litcoffee",
    ".ls",
    ".ts",
  ],
  tableName: "knex_migrations",
  directory: "./migrations",
  disableTransactions: true,
  migrationModules: {},
});

// The new migration we're performing, typically called from the `knex.migrate`
// interface on the main `knex` object. Passes the `knex` instance performing
// the migration.
export default class Migrator {
  constructor(knex) {
    this.knex = knex;
    this.config = this.setConfig(knex.client.config.migrations);

    this._activeMigration = {
      fileName: null,
    };
  }

  // Migrators to the latest configuration.
  latest(config) {
    this.config = this.setConfig(config);
    return this._migrationData()
      .tap(validateMigrationList)
      .spread((all, completed) => {
        const migrations = difference(all, completed);

        const transactionForAll =
          !this.config.disableTransactions &&
          isEmpty(
            filter(migrations, (name) => {
              const migration = this.config.migrationModules[name];
              return !this._useTransaction(migration);
            })
          );

        if (transactionForAll) {
          return this.knex.transaction((trx) =>
            this._runBatch(migrations, "up", trx)
          );
        } else {
          return this._runBatch(migrations, "up");
        }
      });
  }

  // Rollback the last "batch" of migrations that were run.
  rollback(config) {
    return Promise.try(() => {
      this.config = this.setConfig(config);
      return this._migrationData()
        .tap(validateMigrationList)
        .then((val) => this._getLastBatch(val))
        .then((migrations) => {
          return this._runBatch(map(migrations, "name"), "down");
        });
    });
  }

  status(config) {
    this.config = this.setConfig(config);

    return Promise.all([
      this.knex(this.config.tableName).select("*"),
      this._listAll(),
    ]).spread((db, code) => db.length - code.length);
  }

  // Retrieves and returns the current migration version we're on, as a promise.
  // If no migrations have been run yet, return "none".
  currentVersion(config) {
    this.config = this.setConfig(config);
    return this._listCompleted().then((completed) => {
      const val = max(map(completed, (value) => value.split("_")[0]));
      return isUndefined(val) ? "none" : val;
    });
  }

  forceFreeMigrationsLock(config) {
    this.config = this.setConfig(config);
    const lockTable = this._getLockTableName();
    return this.knex.schema
      .hasTable(lockTable)
      .then((exist) => exist && this._freeLock());
  }

  // Creates a new migration, with a given name.
  make(name, config) {
    this.config = this.setConfig(config);
    if (!name) {
      return Promise.reject(
        new Error("A name must be specified for the generated migration")
      );
    }

    return this._ensureFolder(config)
      .then((val) => this._generateStubTemplate(val))
      .then((val) => this._writeNewMigration(name, val));
    // .then((val) => this._updateMigrationModules(val));
  }

  // _updateMigrationModules(val) {
  //   console.log("in updateMigrationModules", val);
  //   const migs = Promise.promisify(fs.readdir, { context: fs })(
  //     this._absoluteConfigDir()
  //   ).then((migrations) => {
  //     return filter(migrations, function (value) {
  //       const extension = path.extname(value);
  //       return includes(loadExtensions, extension);
  //     }).sort();
  //   });
  //   const filename = "index.js";
  //   return Promise.promisify(fs.writeFile, { context: fs })(
  //     path.join(dir, filename),
  //     `
  //      ${migs
  //        .map((name) => {
  //          `import ${name.split("_")[1].split(".")[0]} from './${name}'`;
  //        })
  //        .join(";")}
  //      export const migrationModules = {
  //       ${migs
  //         .map((name) => `${name}:${name.split("_")[1].split(".")[0]}`)
  //         .join(",")}
  //      }
  //      `
  //   ).return(path.join(dir, filename));
  // }
  // Lists all available migration versions, as a sorted array.
  _listAll(config) {
    this.config = this.setConfig(config);
    const loadExtensions = this.config.loadExtensions;
    return filter(Object.keys(this.config.migrationModules), function (value) {
      const extension = path.extname(value);
      return includes(loadExtensions, extension);
    }).sort();
  }

  // Ensures a folder for the migrations exist, dependent on the migration
  // config settings.
  // _ensureFolder() {
  //   const dir = this._absoluteConfigDir();
  //   return Promise.promisify(fs.stat, { context: fs })(dir).catch(() =>
  //     Promise.promisify(mkdirp)(dir)
  //   );
  // }

  // Ensures that a proper table has been created, dependent on the migration
  // config settings.
  _ensureTable(trx = this.knex) {
    const table = this.config.tableName;
    const lockTable = this._getLockTableName();
    return trx.schema
      .hasTable(table)
      .then((exists) => !exists && this._createMigrationTable(table, trx))
      .then(() => trx.schema.hasTable(lockTable))
      .then(
        (exists) => !exists && this._createMigrationLockTable(lockTable, trx)
      )
      .then(() => trx.from(lockTable).select("*"))
      .then(
        (data) => !data.length && trx.into(lockTable).insert({ is_locked: 0 })
      );
  }

  _createMigrationTable(tableName, trx = this.knex) {
    return trx.schema.createTable(tableName, function (t) {
      t.increments();
      t.string("name");
      t.integer("batch");
      t.timestamp("migration_time");
    });
  }

  _createMigrationLockTable(tableName, trx = this.knex) {
    return trx.schema.createTable(tableName, function (t) {
      t.integer("is_locked");
    });
  }

  _getLockTableName() {
    return this.config.tableName + "_lock";
  }

  _isLocked(trx) {
    const tableName = this._getLockTableName();
    return this.knex(tableName)
      .transacting(trx)
      .forUpdate()
      .select("*")
      .then((data) => data[0].is_locked);
  }

  _lockMigrations(trx) {
    const tableName = this._getLockTableName();
    return this.knex(tableName).transacting(trx).update({ is_locked: 1 });
  }

  _getLock(trx) {
    const transact = trx ? (fn) => fn(trx) : (fn) => this.knex.transaction(fn);

    return transact((trx) => {
      return this._isLocked(trx)
        .then((isLocked) => {
          if (isLocked) {
            throw new Error("Migration table is already locked");
          }
        })
        .then(() => this._lockMigrations(trx));
    }).catch((err) => {
      throw new LockError(err.message);
    });
  }

  _freeLock(trx = this.knex) {
    const tableName = this._getLockTableName();
    return trx.table(tableName).update({ is_locked: 0 });
  }

  // Run a batch of current migrations, in sequence.
  _runBatch(migrations, direction, trx) {
    return (
      this._getLock(trx)
        // When there is a wrapping transaction, some migrations
        // could have been done while waiting for the lock:
        .then(() => (trx ? this._listCompleted(trx) : []))
        .then((completed) => (migrations = difference(migrations, completed)))
        .then(() =>
          Promise.all(
            map(migrations, bind(this._validateMigrationStructure, this))
          )
        )
        .then(() => this._latestBatchNumber(trx))
        .then((batchNo) => {
          if (direction === "up") batchNo++;
          return batchNo;
        })
        .then((batchNo) => {
          return this._waterfallBatch(batchNo, migrations, direction, trx);
        })
        .tap(() => this._freeLock(trx))
        .catch((error) => {
          let cleanupReady = Promise.resolve();

          if (error instanceof LockError) {
            // If locking error do not free the lock.
            helpers.warn(`Can't take lock to run migrations: ${error.message}`);
            helpers.warn(
              "If you are sure migrations are not running you can release the " +
                "lock manually by deleting all the rows from migrations lock " +
                "table: " +
                this._getLockTableName()
            );
          } else {
            if (this._activeMigration.fileName) {
              helpers.warn(
                `migration file "${this._activeMigration.fileName}" failed`
              );
            }
            helpers.warn(`migration failed with error: ${error.message}`);
            // If the error was not due to a locking issue, then remove the lock.
            cleanupReady = this._freeLock(trx);
          }

          return cleanupReady.finally(function () {
            throw error;
          });
        })
    );
  }

  // Validates some migrations by requiring and checking for an `up` and `down`
  // function.
  _validateMigrationStructure(name) {
    const migration = this.config.migrationModules[name];
    if (
      typeof migration.up !== "function" ||
      typeof migration.down !== "function"
    ) {
      throw new Error(
        `Invalid migration: ${name} must have both an up and down function`
      );
    }
    return name;
  }

  // Lists all migrations that have been completed for the current db, as an
  // array.
  _listCompleted(trx = this.knex) {
    const { tableName } = this.config;
    return this._ensureTable(trx)
      .then(() => trx.from(tableName).orderBy("id").select("name"))
      .then((migrations) => map(migrations, "name"));
  }

  // Gets the migration list from the specified migration directory, as well as
  // the list of completed migrations to check what should be run.
  _migrationData() {
    return Promise.all([this._listAll(), this._listCompleted()]);
  }

  // Generates the stub template for the current migration, returning a compiled
  // template.
  // _generateStubTemplate() {
  //   const stubPath =
  //     this.config.stub ||
  //     path.join(__dirname, "stub", this.config.extension + ".stub");
  //   return Promise.promisify(fs.readFile, { context: fs })(stubPath).then(
  //     (stub) => template(stub.toString(), { variable: "d" })
  //   );
  // }

  // Write a new migration to disk, using the config and generated filename,
  // passing any `variables` given in the config to the template.
  // _writeNewMigration(name, tmpl) {
  //   const { config } = this;
  //   const dir = this._absoluteConfigDir();
  //   if (name[0] === "-") name = name.slice(1);
  //   const filename = yyyymmddhhmmss() + "_" + name + "." + config.extension;
  //   return Promise.promisify(fs.writeFile, { context: fs })(
  //     path.join(dir, filename),
  //     tmpl(config.variables || {})
  //   ).return(path.join(dir, filename));
  // }

  // Get the last batch of migrations, by name, ordered by insert id in reverse
  // order.
  _getLastBatch() {
    const { tableName } = this.config;
    return this.knex(tableName)
      .where("batch", function (qb) {
        qb.max("batch").from(tableName);
      })
      .orderBy("id", "desc");
  }

  // Returns the latest batch number.
  _latestBatchNumber(trx = this.knex) {
    return trx
      .from(this.config.tableName)
      .max("batch as max_batch")
      .then((obj) => obj[0].max_batch || 0);
  }

  // If transaction config for a single migration is defined, use that.
  // Otherwise, rely on the common config. This allows enabling/disabling
  // transaction for a single migration at will, regardless of the common
  // config.
  _useTransaction(migration, allTransactionsDisabled) {
    const singleTransactionValue = get(migration, "config.transaction");

    return isBoolean(singleTransactionValue)
      ? singleTransactionValue
      : !allTransactionsDisabled;
  }

  // Runs a batch of `migrations` in a specified `direction`, saving the
  // appropriate database information as the migrations are run.
  _waterfallBatch(batchNo, migrations, direction, trx) {
    const trxOrKnex = trx || this.knex;
    const { tableName, disableTransactions, migrationModules } = this.config;
    let current = Promise.bind({ failed: false, failedOn: 0 });
    const log = [];
    each(migrations, (migration) => {
      const name = migration;
      this._activeMigration.fileName = name;
      migration = migrationModules[name];

      // We're going to run each of the migrations in the current "up".
      current = current
        .then(() => {
          if (!trx && this._useTransaction(migration, disableTransactions)) {
            return this._transaction(migration, direction, name);
          }
          return warnPromise(migration[direction](trxOrKnex, Promise), name);
        })
        .then(() => {
          log.push(name);
          if (direction === "up") {
            return trxOrKnex.into(tableName).insert({
              name,
              batch: batchNo,
              migration_time: Date.now(),
            });
          }
          if (direction === "down") {
            return trxOrKnex.from(tableName).where({ name }).del();
          }
        });
    });

    return current.thenReturn([batchNo, log]);
  }

  _transaction(migration, direction, name) {
    return this.knex.transaction((trx) => {
      return warnPromise(migration[direction](trx, Promise), name, () => {
        trx.commit();
      });
    });
  }

  _absoluteConfigDir() {
    return process.cwd
      ? path.resolve(process.cwd(), this.config.directory)
      : path.join("../../../../", this.config.directory);
  }

  setConfig(config) {
    return assign({}, CONFIG_DEFAULT, this.config || {}, config);
  }
}

// Validates that migrations are present in the appropriate directories.
function validateMigrationList(migrations) {
  const all = migrations[0];
  const completed = migrations[1];
  const diff = difference(completed, all);
  if (!isEmpty(diff)) {
    throw new Error(
      `The migration directory is corrupt, the following files are missing: ${diff.join(
        ", "
      )}`
    );
  }
}

function warnPromise(value, name, fn) {
  if (!value || typeof value.then !== "function") {
    helpers.warn(`migration ${name} did not return a promise`);
    if (fn && typeof fn === "function") fn();
  }
  return value;
}

// Ensure that we have 2 places for each of the date segments.
function padDate(segment) {
  segment = segment.toString();
  return segment[1] ? segment : `0${segment}`;
}

// Get a date object in the correct format, without requiring a full out library
// like "moment.js".
function yyyymmddhhmmss() {
  const d = new Date();
  return (
    d.getFullYear().toString() +
    padDate(d.getMonth() + 1) +
    padDate(d.getDate()) +
    padDate(d.getHours()) +
    padDate(d.getMinutes()) +
    padDate(d.getSeconds())
  );
}
