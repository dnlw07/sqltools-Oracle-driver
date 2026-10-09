import OracleDBLib from 'oracledb'
import AbstractDriver from '@sqltools/base-driver';
import queries from './queries';
import { IConnectionDriver, MConnectionExplorer, NSDatabase, ContextValue, Arg0 } from '@sqltools/types';
import parse from './parser';
import { v4 as generateId } from 'uuid';
import {Oracle_Diagnosis_Path} from '../constants';
import fs from 'fs';
import {performance} from 'perf_hooks'

const toBool = (v: any) => v && (v.toString() === '1' || v.toString().toLowerCase() === 'true' || v.toString().toLowerCase() === 'yes');

export interface IOracleResultEdit {
  table: { label: string; schema?: string };
  primaryKey: { [column: string]: any };
  changes: { [column: string]: any };
}

export interface IOracleResultEditResponse {
  success: boolean;
  error?: string;
  failedIndex?: number;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Number(milliseconds) || 0) / 1000;
  if (totalSeconds < 60) {
    const seconds = totalSeconds.toFixed(totalSeconds < 10 ? 2 : 1).replace(/\.?0+$/, '');
    return `${seconds}sec`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = Math.floor(totalSeconds % 60);
    return `${totalMinutes}min${seconds ? ` ${seconds}sec` : ''}`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${minutes ? ` ${minutes}min` : ''}`;
}

// DATE keeps a bare date at midnight; TIMESTAMP types always include the time
function formatOracleDate(value: Date, isTimestamp: boolean): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  const hasTime = value.getHours() || value.getMinutes() || value.getSeconds();
  if (!isTimestamp && !hasTime) return date;
  return `${date} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

export interface PoolConfig{
  // 
  autoCommit?: boolean;
  lowerCase?: boolean; //lowcase for completion
  macroFile?: string; //file configured for macro substitution
  thickMode?: boolean;
  limitPrefetchRows?: boolean;
  privilege?: string;
  pool?: boolean;
}


export default class OracleDriver extends AbstractDriver<OracleDBLib.Connection, PoolConfig> implements IConnectionDriver {
  public readonly supportsCompletionCatalog = true;

  /**
   * If you driver depends on node packages, list it below on `deps` prop.
   * It will be installed automatically on first use of your driver.
   */
  public readonly deps: typeof AbstractDriver.prototype['deps'] = [{
    type: AbstractDriver.CONSTANTS.DEPENDENCY_PACKAGE,
    name: 'oracledb',
    version: '6.10.0',
  }];


  queries = queries;
  autoCommit = false;
  lowerCase = false;
  macroFile = '';
  maxRows = 0;
  private totalRowsCache = new Map<string, number>();

  private isPaginatableSelect(sql: string): boolean {
    const stripped = sql.replace(/^(\s*--[^\n]*\n|\s*\/\*[\s\S]*?\*\/)+/g, '').trim();
    if (!/^\(*\s*(SELECT|WITH)\b/i.test(stripped)) return false;
    const tail = stripped.slice(-150).toUpperCase();
    return !/\bFETCH\s+(FIRST|NEXT)\b|\bOFFSET\b|\bFOR\s+UPDATE\b/.test(tail);
  }
  privilege = 'Normal';
  privilegeMap = {'SYSDBA':this.lib.SYSDBA,'SYSOPER':this.lib.SYSOPER,'SYSASM':this.lib.SYSASM,'SYSBACKUP':this.lib.SYSBACKUP,
                    'SYSDG':this.lib.SYSDG,'SYSKM':this.lib.SYSKM,'SYSPRELIM':this.lib.SYSPRELIM,'SYSRAC':this.lib.SYSRAC};
  
  pooled = true;
  /** if you need to require your lib in runtime and then
   * use `this.lib.methodName()` anywhere and vscode will take care of the dependencies
   * to be installed on a cache folder
   **/
  private get lib(): typeof OracleDBLib {
    const oracledb = this.requireDep('oracledb');
    oracledb.fetchAsString = [oracledb.CLOB, oracledb.NUMBER];
    (oracledb as any).fetchTypeHandler = (metaData: any) => {
      if (metaData.dbType === oracledb.DB_TYPE_DATE) {
        return { converter: (v: any) => (v instanceof Date ? formatOracleDate(v, false) : v) };
      }
      if (metaData.dbType === oracledb.DB_TYPE_TIMESTAMP || metaData.dbType === oracledb.DB_TYPE_TIMESTAMP_TZ || metaData.dbType === oracledb.DB_TYPE_TIMESTAMP_LTZ) {
        return { converter: (v: any) => (v instanceof Date ? formatOracleDate(v, true) : v) };
      }
      return undefined;
    };
    return oracledb;
  }

  public async open() {
    if (this.connection) {
      return this.connection;
    }
    if(!this.credentials.connectString){
      if (this.credentials.server && this.credentials.port) {
        this.credentials.connectString = `${this.credentials.server}:${this.credentials.port}/${this.credentials.database}`;
      } else {
        this.credentials.connectString = this.credentials.database;
      }
    }
    if(this.credentials.oracleOptions){
      if(this.credentials.oracleOptions.autoCommit){
        this.autoCommit = this.credentials.oracleOptions.autoCommit;
      }
      if(this.credentials.oracleOptions.lowerCase){
        this.lowerCase = this.credentials.oracleOptions.lowerCase;
      }
      if(this.credentials.oracleOptions.macroFile){
        this.macroFile = this.credentials.oracleOptions.macroFile;
      }
      if(this.credentials.oracleOptions.thickMode){
        this.lib.initOracleClient();
      }
      if(this.credentials.oracleOptions.limitPrefetchRows){
        this.maxRows = this.credentials.previewLimit;
      }
      if(this.credentials.oracleOptions.privilege){
        this.privilege = this.credentials.oracleOptions.privilege;
      }
      // if(this.credentials.oracleOptions.pool){
      //   this.pooled = this.credentials.oracleOptions.pool;
      // }
      // if(this.privilege != 'Normal'){
        this.pooled = false;
      // }
    }
    if(this.pooled){
      await this.lib.createPool({
        user: this.credentials.username,
        password: this.credentials.password,
        connectString: this.credentials.connectString,
        poolIncrement : 0,
        poolMax       : 4,
        poolMin       : 4
      });
      const conn = await this.lib.getConnection();
      await conn.ping();
      this.connection = Promise.resolve(conn);
      return conn;
    }else{
      const standAloneConnSetting = {
        user: this.credentials.username,
        password: this.credentials.password,
        connectString: this.credentials.connectString,
        privilege: this.privilegeMap[this.privilege]
      };
      const conn = await this.lib.getConnection(standAloneConnSetting);
      await conn.ping();
      this.connection = Promise.resolve(conn);
      return conn;
    }
  }

  public async close() {
    if (!this.connection) return Promise.resolve();
    return this.connection.then(async (conn) => {
      if(this.pooled){
        await conn.close();
        return new Promise<void>((resolve, reject) => {
          this.lib.getPool().close(0,(err) => {
            if (err) return reject(err);
            this.connection = null;
            return resolve();
          });
        });
      }
      else{
        return new Promise<void>((resolve, reject) => {
          conn.close((err) => {
            if (err) return reject(err);
            this.connection = null;
            return resolve();
          });
        });
      }

    });
  }

  public calTime(str:string){
    let date:Date = new Date();
    this.log.info(str + date.toLocaleTimeString());
  }

  private currentSchemaCache: string | null = null;

  // Oracle resolves unqualified table names against the session's current schema,
  // which is normally the connected user, not a fixed placeholder.
  private async getCurrentSchema(conn: OracleDBLib.Connection): Promise<string> {
    if (this.currentSchemaCache) return this.currentSchemaCache;
    const res: any = await conn.execute(`SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS "SCHEMA" FROM DUAL`, [], { outFormat: this.lib.OUT_FORMAT_OBJECT });
    const value = res.rows && res.rows[0] && (res.rows[0].SCHEMA || res.rows[0].schema || Object.values(res.rows[0])[0]);
    this.currentSchemaCache = value ? String(value).toUpperCase() : (this.credentials.username || '').toUpperCase();
    return this.currentSchemaCache;
  }

  // oracledb's result metadata doesn't include the source table/schema per column, so a single,
  // unambiguous FROM clause is required to know what table a result can be saved back to.
  private getSingleTableSource(sql: string): { schema: string; table: string } | null {
    const normalized = sql.replace(/\s+/g, ' ');
    if (/\bJOIN\b|\bUNION\b|\bINTERSECT\b|\bMINUS\b|\bFROM\s*\(/i.test(normalized)) return null;
    const match = normalized.match(/\bFROM\s+(?:(?:"([^"]+)"|([A-Za-z_][\w$]*))\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][\w$]*))(?:\s+(?:AS\s+)?[A-Za-z_][\w$]*)?(?:\s|;|$)/i);
    if (!match) return null;
    return {
      schema: (match[1] || match[2] || '').toUpperCase(),
      table: (match[3] || match[4]).toUpperCase(),
    };
  }

  private async resolveResultEditability(conn: OracleDBLib.Connection, cols: string[], sql: string) {
    if (!cols.length) return { editable: false, nonEditableReason: 'Result has no columns.' };
    const singleTable = this.getSingleTableSource(sql);
    if (!singleTable) return { editable: false, nonEditableReason: 'Result does not identify one physical Oracle table.' };
    const schema = singleTable.schema || await this.getCurrentSchema(conn);
    const table = singleTable.table;

    const catalogRes: any = await conn.execute(
      `SELECT COLUMN_NAME AS "column" FROM ALL_TAB_COLUMNS WHERE OWNER = :ownerName AND TABLE_NAME = :tableName ORDER BY COLUMN_ID`,
      { ownerName: schema.toUpperCase(), tableName: table.toUpperCase() },
      { outFormat: this.lib.OUT_FORMAT_OBJECT }
    );
    const knownColumns = new Set((catalogRes.rows || []).map((row: any) => String(row.column || row.COLUMN || Object.values(row)[0]).toUpperCase()));
    if (!knownColumns.size) return { editable: false, nonEditableReason: 'Result columns cannot be mapped to the source Oracle table.' };

    const resolvedSources = cols.map((name, index) => ({ index, sourceColumn: name, table, schema }));
    if (resolvedSources.some(source => !knownColumns.has(String(source.sourceColumn).toUpperCase()))) {
      return { editable: false, nonEditableReason: 'Result columns cannot be mapped to the source Oracle table.' };
    }

    const pkRes: any = await conn.execute(
      `SELECT cols.COLUMN_NAME AS "column" FROM ALL_CONSTRAINTS cons JOIN ALL_CONS_COLUMNS cols
         ON cons.CONSTRAINT_NAME = cols.CONSTRAINT_NAME AND cons.OWNER = cols.OWNER
       WHERE cons.CONSTRAINT_TYPE = 'P' AND cons.OWNER = :ownerName AND cons.TABLE_NAME = :tableName
       ORDER BY cols.POSITION`,
      { ownerName: schema.toUpperCase(), tableName: table.toUpperCase() },
      { outFormat: this.lib.OUT_FORMAT_OBJECT }
    );
    const primaryKeys = (pkRes.rows || []).map((row: any) => String(row.column || row.COLUMN || Object.values(row)[0]).toUpperCase());
    const includedColumns = new Set(resolvedSources.map(source => String(source.sourceColumn).toUpperCase()));

    const columnMeta = resolvedSources.map(source => ({
      name: cols[source.index],
      sourceColumn: source.sourceColumn,
      table: source.table,
      schema: source.schema,
      isPk: primaryKeys.includes(String(source.sourceColumn).toUpperCase()),
      editable: true,
    }));
    // no primary key: every mapped column is used to locate the row on save instead
    if (primaryKeys.length && !primaryKeys.every(column => includedColumns.has(column))) {
      return { columnMeta, editable: false, nonEditableReason: 'Result must include every primary key column.' };
    }
    return { columnMeta, editable: true };
  }

  public async applyEdits(edits: IOracleResultEdit[], _opt: any = {}): Promise<IOracleResultEditResponse> {
    if (!edits.length) return { success: true };
    const quoteIdentifier = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;
    let conn: OracleDBLib.Connection | undefined;
    let failedIndex = 0;
    try {
      const prepared = edits.map(({ table, primaryKey, changes }, index) => {
        failedIndex = index;
        const changeColumns = Object.keys(changes || {});
        const primaryKeyColumns = Object.keys(primaryKey || {});
        if (!table?.label || !table.schema || !changeColumns.length || !primaryKeyColumns.length ||
          primaryKeyColumns.some(column => primaryKey[column] === undefined) ||
          changeColumns.some(column => changes[column] === undefined)) throw new Error('Invalid edit request.');
        const binds: any = {};
        const matchBinds: any = {};
        const setClause = changeColumns.map((column, i) => { binds[`s${i}`] = changes[column]; return `${quoteIdentifier(column)} = :s${i}`; }).join(', ');
        const whereClause = primaryKeyColumns.map((column, i) => {
          if (primaryKey[column] === null) return `${quoteIdentifier(column)} IS NULL`;
          matchBinds[`w${i}`] = primaryKey[column];
          return `${quoteIdentifier(column)} = :w${i}`;
        }).join(' AND ');
        const relation = [table.schema, table.label].filter(Boolean).map(quoteIdentifier).join('.');
        return { relation, setClause, whereClause, matchBinds, binds: { ...binds, ...matchBinds } };
      });
      await this.open();
      conn = this.pooled ? await this.lib.getConnection() : await this.lib.getConnection({
        user: this.credentials.username,
        password: this.credentials.password,
        connectString: this.credentials.connectString,
        privilege: this.privilegeMap[this.privilege],
      });
      for (let index = 0; index < prepared.length; index++) {
        failedIndex = index;
        const { relation, whereClause, matchBinds } = prepared[index];
        const result: any = await conn.execute(`SELECT COUNT(*) AS "matching_count" FROM ${relation} WHERE ${whereClause}`, matchBinds,
          { autoCommit: false, outFormat: this.lib.OUT_FORMAT_OBJECT, maxRows: 1 });
        const count = Number(result.rows?.[0]?.matching_count);
        if (count !== 1) throw new Error(`Unsafe update for ${relation}: WHERE matches ${Number.isFinite(count) ? count : 'an unknown number of'} rows; expected exactly 1. No changes saved.`);
      }
      for (let index = 0; index < prepared.length; index++) {
        failedIndex = index;
        const { relation, setClause, whereClause, binds } = prepared[index];
        const result: any = await conn.execute(`UPDATE ${relation} SET ${setClause} WHERE ${whereClause}`, binds, { autoCommit: false });
        if (result.rowsAffected !== 1) {
          throw new Error('Row matching changed after validation. No changes saved.');
        }
      }
      await conn.commit();
      return { success: true };
    } catch (error) {
      if (conn) await conn.rollback().catch(() => undefined);
      return { success: false, failedIndex, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (conn) await conn.close().catch(() => undefined);
    }
  }

  public singleQuery: (typeof AbstractDriver)['prototype']['singleQuery'] = ((query: any, opt: any) => {
    return this.query(query, { ...opt, __internal: true }).then(([result]) => result);
  }) as any;

  public query: (typeof AbstractDriver)['prototype']['query'] = async (query, opt = {}) => {
    return await this.open().then(async (conn): Promise<NSDatabase.IResult[]> => {
      const { requestId } = opt;
      return new Promise(async (resolve) => {
          let currentQuery:string;
          let resultsAgg: NSDatabase.IResult[] = [];
          const messages = [];
          let row,column;
          try{
            // if (err) return reject(err);
            // this.calTime("before parse");
            const parseQueries = parse(query.toString());
            // this.calTime("after parse");
            const queries = parseQueries.queries;
            const isSelectQueries = parseQueries.isSelectQueries;
            const rows = parseQueries.rows;
            const columns = parseQueries.columns;
            let binds = {};
            let options = {
              outFormat: this.lib.OUT_FORMAT_OBJECT,   // query result format
              dmlRowCounts: true,                      //the number of rows affected by each input row
              autoCommit: this.autoCommit,   //control autocommit
              maxRows: (opt as any).__internal ? 0 : this.maxRows
            };
            // conn.execute(`ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'`);
            let rowsAffectedAll: number = 0;
            let selectQueryNum: number = 0;
            let DbmsOut: string = '';
            // enable dbms_output
            await conn.execute(`
              BEGIN
                DBMS_OUTPUT.ENABLE(NULL);
              END;`);

              
            let executeCost = 0;

            for (var i =0;i<queries.length;i++) {
              let q = queries[i];
              currentQuery = q;
              row = rows[i];
              column = columns[i];
              
              const startTime = performance.now();
              // A lone SELECT/WITH is paged; scripts with several statements keep unpaginated behaviour.
              const paginated = !(opt as any).__internal && queries.length === 1 && isSelectQueries[i] && this.isPaginatableSelect(q);
              const pageSize = Math.max(1, Number(opt.pageSize) || Number(this.credentials.previewLimit) || 100);
              const page = Math.max(0, Number(opt.page) || 0);
              const baseSql = q.replace(/[;\s/]+$/, '');
              let total = 0;
              let totalExact = true;
              let hasMore = false;
              let res: any;
              if (paginated) {
                res = await conn.execute(
                  `SELECT * FROM (\n${baseSql}\n) OFFSET ${page * pageSize} ROWS FETCH NEXT ${pageSize + 1} ROWS ONLY`,
                  binds,
                  { ...options, maxRows: 0 }
                ) || [];
                const fetched: any[] = res.rows || [];
                hasMore = fetched.length > pageSize;
                res.rows = hasMore ? fetched.slice(0, pageSize) : fetched;
                const cacheKey = `${requestId || ''} ${baseSql}`;
                const knownTotal = page === 0 ? undefined : this.totalRowsCache.get(cacheKey);
                if (typeof knownTotal === 'number') {
                  total = knownTotal;
                } else {
                  try {
                    const countRes: any = await conn.execute(
                      `SELECT COUNT(*) AS "SQLTOOLS_TOTAL" FROM (\n${baseSql}\n)`, binds, { outFormat: this.lib.OUT_FORMAT_OBJECT }
                    );
                    total = Number(countRes.rows && countRes.rows[0] && countRes.rows[0].SQLTOOLS_TOTAL);
                    if (!isFinite(total)) throw new Error('Count query returned a non-numeric value.');
                    this.totalRowsCache.set(cacheKey, total);
                    if (this.totalRowsCache.size > 100) this.totalRowsCache.delete(this.totalRowsCache.keys().next().value);
                  } catch (countError) {
                    // keep the "next" control usable when the COUNT wrapper is rejected
                    totalExact = false;
                    total = hasMore ? (page + 1) * pageSize + 1 : page * pageSize + res.rows.length;
                  }
                }
              } else {
                res = await conn.execute(q,binds,options) || [];
              }
              const elapsed = performance.now() - startTime;
              const duration = formatDuration(elapsed);
              const statementType = q.trim().split(/\s+/, 1)[0].toUpperCase();

              executeCost += elapsed;
              if (res.rowsAffected) {
                rowsAffectedAll += res.rowsAffected;
              }

              const shown = (res.rows || []).length;
              const statusMessage = paginated
                ? (totalExact
                  ? `${shown} row${shown === 1 ? '' : 's'} shown - page ${page + 1} of ${Math.max(1, Math.ceil(total / pageSize))} (${total} total, ${pageSize}/page) in ${duration}.`
                  : `${shown} row${shown === 1 ? '' : 's'} shown - page ${page + 1} (${pageSize}/page) in ${duration}.`)
                : isSelectQueries[i]
                ? `${shown} row${shown === 1 ? '' : 's'} retrieved in ${duration}.`
                : typeof res.rowsAffected === 'number'
                  ? `${statementType} executed successfully. ${res.rowsAffected} row${res.rowsAffected === 1 ? '' : 's'} affected (${duration}).`
                  : `${statementType} executed successfully in ${duration}.`;
              const statementMessages = [{ date: new Date(), message: statusMessage }];
              messages.push(statementMessages[0]);
              this.log.info(`${statusMessage}\n${q.trim()}`);

              if(isSelectQueries[i]){
                selectQueryNum += 1;
              }

              if(isSelectQueries[i]){
                const selectCols: string[] = res.rows?.length ? Object.keys(res.rows[0])
                  : (res.metaData || []).map((field: { name: string }) => field.name);
                const editability = await this.resolveResultEditability(conn, selectCols, q).catch(error => {
                  this.log.error(`Oracle result metadata resolution failed: ${error && error.message || error}`);
                  return { editable: false, nonEditableReason: `Unable to resolve table metadata: ${error && error.message || error}` };
                });
                resultsAgg.push(<NSDatabase.IResult><unknown>{
                  requestId,
                  resultId: generateId(),
                  connId: this.getId(),
                  cols: selectCols,
                  ...editability,
                  messages: statementMessages,
                  query: q,
                  results: res.rows,
                  ...(paginated ? { queryType: 'executeQuery', queryParams: q, page, pageSize, total } : {}),
                });
              }
            }
            // this.calTime("after execute");
            // DBMS_OUTPUT
            let result;
            do {
              result = await conn.execute(
                `BEGIN
                  DBMS_OUTPUT.GET_LINE(:ln, :st);
                  END;`,
                  { ln: { dir: this.lib.BIND_OUT, type: this.lib.STRING, maxSize: 32767 },
                    st: { dir: this.lib.BIND_OUT, type: this.lib.NUMBER }
                  }
              );
              if (result.outBinds.st === 0)
                DbmsOut += (result.outBinds.ln + "\n") ;
            } while (result.outBinds.st === 0);
            
            if(DbmsOut.length > 0){
              let DbmsOuta = DbmsOut;
              DbmsOuta = '\n-----------------------DBMS_OUTPUT START-----------------------\n' + DbmsOuta;
              DbmsOuta = DbmsOuta + '-----------------------DBMS_OUTPUT END-----------------------';
              this.log.info(DbmsOuta);
            }
            this.log.info(`cost: ${formatDuration(executeCost)}`);

            if((rowsAffectedAll>0) || (selectQueryNum < queries.length) || (DbmsOut.length > 0)){
              let executeTime = new Date();
              resultsAgg.push(<NSDatabase.IResult>{
                requestId,
                resultId: generateId(),
                connId: this.getId(),
                cols: ['executeTime', 'rowsAffted', 'DBMS_OUTPUT',],
                messages,
                query: 'summary',
                results: [{'rowsAffted':rowsAffectedAll+' rows were affected','DBMS_OUTPUT':DbmsOut,'executeTime':executeTime.toLocaleTimeString()}],
              });
            }
            fs.writeFileSync(Oracle_Diagnosis_Path,JSON.stringify({"state":"0","query":query.toString()}));
            return resolve(resultsAgg);
          }catch(err){
            this.log.error(`Oracle query failed: ${err.message || String(err)}\n${currentQuery || query.toString()}`);
            for(var i=0;i<err.offset;i++){
              ++column;
              if(currentQuery[i] == '\n'){
                ++row;
                column = 1;
              }
            }
            messages.push({ date: new Date(), message: `${err.message || String(err)}\nintra-block-posi:(${row},${column})` });
            resultsAgg.push(<NSDatabase.IResult>{
              requestId,
              resultId: generateId(),
              connId: this.getId(),
              cols: [],
              messages,
              error: true,
              rawError: err,
              query: currentQuery,
              results: [],
            });
            let data = JSON.stringify({"state":"0","query":query.toString(),"currentQuery":currentQuery,"message":err.message,"row":row-1,'column':column-1, "offset":err.offset});
            fs.writeFileSync(Oracle_Diagnosis_Path,data);
            return resolve(resultsAgg);
          }
      });
    });
  }

  /** if you need a different way to test your connection, you can set it here.
   * Otherwise by default we open and close the connection only
   */
  public async testConnection() {
    await this.query('SELECT 1 FROM DUAL', {});
  }

  /**
   * This method is a helper to generate the connection explorer tree.
   * it gets the child items based on current item
   */
  public async getChildrenForItem({ item, parent }: Arg0<IConnectionDriver['getChildrenForItem']>) {
    switch (item.type) {
      case ContextValue.CONNECTION:
      case ContextValue.CONNECTED_CONNECTION:
        return <MConnectionExplorer.IChildItem[]>[
          { label: 'Tables', type: ContextValue.RESOURCE_GROUP, iconId: 'folder', childType: ContextValue.TABLE },
          { label: 'Views', type: ContextValue.RESOURCE_GROUP, iconId: 'folder', childType: ContextValue.VIEW },
        ];
      case ContextValue.TABLE:
      case ContextValue.VIEW:
       return this.queryResults(this.queries.fetchColumns(item as NSDatabase.ITable)); 
      case ContextValue.RESOURCE_GROUP:
        return this.getChildrenForGroup({ item, parent });
    }
    return [];
  }

  /**
   * This method is a helper to generate the connection explorer tree.
   * It gets the child based on child types
   */
  private async getChildrenForGroup({ parent, item }: Arg0<IConnectionDriver['getChildrenForItem']>) {
    switch (item.childType) {
      case ContextValue.TABLE:
        return this.queryResults(this.queries.fetchTables(parent as NSDatabase.ISchema));
      case ContextValue.VIEW: 
        return this.queryResults(this.queries.fetchViews(parent as NSDatabase.ISchema));
    }
    return [];
  }
    /**
   * This method is a helper for intellisense and quick picks.
   */
  public async searchItems(itemType: ContextValue, search: string, extraParams: any = {}): Promise<NSDatabase.SearchableItem[]> {
    switch (itemType) {
      case ContextValue.TABLE:
      case ContextValue.VIEW:
        return this.queryResults(this.queries.searchTables({ search, ...extraParams })).then(r => r.map(t => {
          const catalogLabel = t.label;
          if(this.lowerCase){
            t.label = t.label.toLowerCase();
          }
          t.isView = toBool(t.isView);
          return extraParams.completionCatalog ? { ...t, catalogLabel } : t;
        }));
      case ContextValue.DATABASE:
      case ContextValue.SCHEMA:
        return this.queryResults(this.queries.searchSchemas({ search, ...extraParams })).then(r => r.map(s => {
          if(this.lowerCase){
            s.label = s.label.toLowerCase();
          }
          return s;
        }));
      case ContextValue.COLUMN:
        return this.queryResults(this.queries.searchColumns({ search, ...extraParams })).then(r => r.map(c => {
          if(this.lowerCase){
            c.label = c.label.toLowerCase();
          }
          c.isPk = toBool(c.isPk);
          c.isFk = toBool(c.isFk);
          return c;
        }));
    }
  }

  public getStaticCompletions: IConnectionDriver['getStaticCompletions'] = async () => {
    return {};
  }
}
