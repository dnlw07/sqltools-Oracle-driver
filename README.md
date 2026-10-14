# SQLTools Oracle Driver 
This package is part of [vscode-sqltools](https://vscode-sqltools.mteixeira.dev/?umd_source=repository&utm_medium=readme&utm_campaign=mysql) extension.


It is tested on Oracle Database 11.2.0 with 32-bit and 64-bit Oracle client libraries(windowns 10).

### Usage
After installing the oracle Driver for SQLTools, you will be able to create connections to oracle Database, explore tables and views, and run queries. For more information on how to use SQLTools please refer to [SQLTools extension](https://github.com/mtxr/vscode-sqltools)


### Prerequisites
#### For 64-bit Oracle client libraries
* Have 64-bit Node.js (version 14 or newer) and npm installed
* Have the oracledb@6.10.0 (Normally, Upon first use the Oracle driver extension prompts for permission to install the oracledb@6.10.0 package).

#### For 32-bit Oracle client libraries
* Have 32-bit Node.js (version 14 or newer) and npm installed(nvm can be used to manage different nodejs versions)
* Have the oracledb@6.10.0(Because there is no prebuilt binaries corresponding to this platform, you need to install according to the [official instructions](https://node-oracledb.readthedocs.io/en/latest/user_guide/installation.html#node-oracledb-installation-instructions)) in the specific directory(which is used for storing data for vscode-sqltools)(you can use everything to search "vscode-sqltools" to find the directory)
   * For me, I first download the [tgz File](https://github.com/oracle/node-oracledb/releases/download/v6.10.0/oracledb-src-6.10.0.tgz), then in the **\AppData\Local\vscode-sqltools\Data directory and run `npm install your_dir_path/oracledb-6.10.0.tgz`


### Installation
* From VS Code by searching SQLTools Oracle Driver
* From [marketplace](https://marketplace.visualstudio.com/items?itemName=hurly.sqltools-oracle-driver)
### ChageLog
#### Unreleased: connection initialization SQL
* Add a multiline **Connection initialization SQL** field (`connectionInitSql`) to connection settings. Statements run sequentially on each newly opened session, including reconnects, pool checkouts, and separate grid-edit sessions, before user operations. Cached-session reuse does not rerun initialization.
* Use semicolons between SQL statements and `/` on a separate line after PL/SQL blocks, following the driver's normal script parser. Connection tests also run initialization. A failing statement stops the script and rejects/closes the session with the statement number and Oracle error.
* No automatic commit is added. Avoid initialization scripts with persistent side effects: Oracle DDL can commit implicitly, and reconnecting runs the script again. Settings are saved as plain text; do not put secrets in this field.

Example:
```sql
ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD';
ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS';
```

#### Unreleased
* Schema names in the connection tree display the standard SQLTools schema icon.
* The default Thin TCP keep-alive interval (`oracleOptions.expireTime`) is now 10 minutes. Explicitly configured intervals remain unchanged; `0` still disables probes. The separate cached-session health-check timing is unchanged.
#### 0.1.24 (2026-10-14)
##### Schema tree
* Oracle connections now list schema folders, with Tables and Views underneath each schema. Schemas retain Oracle catalog casing and the connected user's schema is listed first.
* Table/view lists and column metadata are scoped to the selected owner. Show Records, Count Records, and Describe Table use the selected schema, including quoted identifiers.
##### Repeated SELECT columns
* If inline-view pagination rejects repeated projection names with ORA-00918 (for example `SELECT x.ID, x.* FROM employees x`), execute the unchanged original SELECT using a bounded result cursor. Keep both columns with unique grid labels and disable editing of ambiguous projections. Cursor pages use estimated totals and read/discard preceding rows for later pages.
* Actual ambiguity in the original SQL remains an error. Oracle requires a qualified wildcard when mixing named columns and `*`; declare aliases used in WHERE clauses and use straight SQL quotes.
##### Connection reliability
* Thin connections introduced TCP keep-alive probes with an initial default of one minute (`oracleOptions.expireTime`, in minutes; `0` disables). Thick mode uses Oracle Net `EXPIRE_TIME` in the connection string or client configuration.
* Check cached connection health and ping after at least one minute without connection acquisition. Remove broken sessions after network errors so the next explicit query can reconnect; concurrent opens share one connection attempt.
* Never automatically replay failed SQL. A disconnected session may have lost uncommitted changes, temporary state, and session settings. A new session does not restore these.
* TCP probes reduce idle firewall drops but cannot prevent server shutdowns, VPN interruptions, or enforced session limits. `NJS-500`/`NJS-501` and `ECONNRESET` require checking network/firewall and Oracle server logs if they persist.
* Connection tests: `npm run test-compile` then `node --test test`.
##### Empty results
* Empty SELECT results retain their column names from Oracle result metadata, including paginated queries and quoted aliases. No placeholder rows are added.
#### 0.1.23
* With SQLTools 0.28.43, cache complete schema/table catalogs per connection, persist them between sessions, and match abbreviated names locally before applying the completion display limit.
* Load full columns lazily with owner/table scope and at most four concurrent lookups. Existing lowercase-label settings remain supported.
* Cached catalogs refresh in the background after 15 minutes on the next completion request. Use **SQLTools: Refresh Autocomplete Catalog** for the active connection after metadata changes; this also invalidates cached columns. Errors retain the previous catalog and are logged, with a one-minute retry delay.
* Query regression tests: `npm run test-compile` followed by `node --test test/completion-queries.test.js`.
#### 0.1.0
* First working version
#### 0.1.1
* (tables explore and completion etc) not restrict in current user
* fix the pool size in 4 for better performance
* change the original match(%info%) with just(info%) to avoid too many matches
#### 0.1.2
* fix some issue 
   * in the searchTables query, move the `order by` sentence out for efficiency
#### 0.1.4
* fix the issue(#3) that can't commit;
* add support for exec(**replace exec with call** before processing)
* ignore spool command (**add -- before spool** before processing)
* add better support for sentances splitting
   * sentances should be separated with **/**
      * begin with `declare` or `begin`
      * begin with `create`
         * followed by `procedure`,`function`,`trigger`
   * others separated with **;**
* add better support with (not select) sentances
   * only a summary page to show the result instead of many pages
* add support for showing error(you can see the error message in the **OUTPUT** of vscode)
#### 0.1.5
* new setting
   * add autoCommit option in the Connection Settings.
   * add lowercase option in the Connection Settings for completion.
* add *rows affted* and *executeTime* in the summary page for (`not select`) sentances;
* fix some issues
   * Statements with only comments are not processed to prevent errors.
   * `create` (or replace) `package` should also be separated with **/**.
   * `with` sentances should also be recognized as `select` sentances.

#### 0.1.6
* **add detailed error message**
* fix some issues
   * sql statement with '/' as division sign are wrongly seperated.
   * *show table recordes* doesn't support paging
* adjust the order of completion items.
* doesn't support for property(pk,fk) anymore for performance

#### 0.1.7
* update oracledb to 6.0.1 to support thin mode
* add option 'thickmode' to support thick mode in this version(default is thin mode)
* remove unessassary log code

#### 0.1.8
* add Support for DBMS_OUTPUT

#### 0.1.9
* add sql output in the sql console:message windows
* adjust implementation way for DBMS_OUTPUT according to advice from @a-langer

#### 0.1.10
* move dbms_output out of the loop to improve efficiency
* add dbms_output in the output channel

#### 0.1.11
* fix parse bugs when multiple kind of comments(such as /* and --) occure in one line
* fix parse bugs when / occures inside begin end block
* add maxRow option to prevent out of memory(when "limit prefetch rows" set true, "Show records default limit" will take effect)
* fix the activation issue

#### 0.1.12
* optimize parse code
* add support for privileged connection
* pooled connection is replaced with standalone connection

#### 0.1.14
* optimize code for standalone connection
* fix the issue #14

#### 0.1.16
* fix the issue #17 and activeTextEditor.document access faild

#### 0.1.17
* update oracledb to 6.10.0 to fix issue #20

### Feedback
* If you have any questions, feel free to ask and I'll get back to you at the weekend.


Thanks to [vscode-sqltools](https://github.com/mtxr/vscode-sqltools), [node-oracledb](https://github.com/oracle/node-oracledb), [older sqltools oracle driver](https://github.com/mickeypearce/vscode-sqltools/tree/master/packages/drivers/oracle)