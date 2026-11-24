exports.version = 1.3
exports.apiRequired = 8.85
exports.hasConfig = true
exports.description = "JSON DB (Multiple Databases, Auto Backup, Password Protection, Admin API Hints + Log Hints, POST body support, Batch write)"
exports.repo = "hugo529100/hfs-Json-db"

exports.config = {

    dbList: {
        type: 'array',
        label: 'Database List (Each represents a JSON file)',
        fields: {
            name: { label: 'DB Name (Unique)' },
            filename: { label: 'Filename, e.g., users.json' }
        },
        helperText: `
This plugin provides REST API:
(The following are fixed examples; actual APIs are defined by dbList)

Get data:
/~/api/jsondb/get?db=DBNAME&key=KEY

Set data:
/~/api/jsondb/set?db=DBNAME&key=KEY&value=VALUE
POST /~/api/jsondb/set   {"db":"DBNAME","key":"KEY","value":...}
(values that are valid JSON are stored as JSON, everything else as string)

Set many keys in one request (single file write):
/~/api/jsondb/mset?db=DBNAME&items=[{"key":"a","value":1},{"key":"b","value":2}]

Delete data:
/~/api/jsondb/del?db=DBNAME&key=KEY

List keys:
/~/api/jsondb/keys?db=DBNAME&prefix=optional

Export entire database:
/~/api/jsondb/dump?db=DBNAME

List all databases:
/~/api/jsondb/list

If API requires credentials, append:
&user=USERNAME&pass=PASSWORD
(or use HTTP Basic authentication)

Tips:
* POST body accepts JSON or form-urlencoded. A "text/plain" JSON body avoids
  the CORS preflight, which is handy for browser pages.
* GET URLs are limited by the HTTP server (~32KB). Use POST or mset for
  bigger payloads.
        `
    },

    apiAuthEnabled: {
        type: 'boolean',
        label: 'Enable API Username/Password Protection',
        defaultValue: false,
        helperText: "If enabled, all APIs require ?user=xxx&pass=xxx (or HTTP Basic auth)"
    },

    apiUser: {
        label: 'API Username',
        defaultValue: ''
    },

    apiPass: {
        type: 'password',
        label: 'API Password',
        defaultValue: ''
    },

    maxValueBytes: {
        type: 'number',
        label: 'Max size of a single value (bytes)',
        defaultValue: 8388608,
        helperText: 'Larger values are rejected with a clear error (0 = no limit). Prevents memory blow-ups.'
    },

    allowClearAll: {
        type: 'boolean',
        label: 'Allow "del" without key to wipe the whole database',
        defaultValue: false,
        helperText: 'When disabled, del without key returns an error unless confirm=clear is passed.'
    },

    backupInterval: {
        type: 'number',
        label: 'Auto Backup Interval (hours)',
        defaultValue: 12,
        helperText: 'How often to create timestamped backup files (0 to disable)'
    },

    backupRetentionDays: {
        type: 'number',
        label: 'Backup Retention Days',
        defaultValue: 3,
        helperText: 'How many days to keep backup files before automatic cleanup'
    },

    debugMode: {
        type: 'boolean',
        label: 'Enable Debug Mode',
        defaultValue: false,
        helperText: 'Enable detailed logging for backup operations and debugging'
    }
}

exports.init = async api => {

    // ------ MODULES & STORAGE ------
    const fs = api.require('fs/promises')
    const path = api.require('path')
    const storage = api.storageDir
    const DB = {}
    const mutex = {}
    const backupTimers = {}
    const lastBackupStamp = {}
    const MAX_BODY_BYTES = 32 * 1024 * 1024

    const fullPath = fn => path.join(storage, fn)

    // ------ DEBUG LOGGER ------
    function debugLog(...args) {
        if (api.getConfig('debugMode')) {
            api.log('json-db [debug]:', ...args)
        }
    }

    // ------ ERROR LOGGER ------
    function errorLog(...args) {
        api.log('json-db [error]:', ...args)
    }

    // ------ INFO LOGGER ------
    function infoLog(...args) {
        api.log('json-db:', ...args)
    }

    // ------ 時間戳格式 ------
    function getTimestamp() {
        const now = new Date()
        const year = now.getFullYear()
        const month = String(now.getMonth() + 1).padStart(2, '0')
        const day = String(now.getDate()).padStart(2, '0')
        const hour = String(now.getHours()).padStart(2, '0')
        const minute = String(now.getMinutes()).padStart(2, '0')
        return `${year}${month}${day}_${hour}${minute}`
    }

    // ------ QUEUE ------
    function queue(name, fn) {
        const prev = mutex[name] || Promise.resolve()
        const p = prev.then(fn).catch(e => api.log("queue error", e))
        mutex[name] = p
        return p
    }

    // ------ SAFE WRITE ------
    async function safeWrite(fp, txt) {
        const tmp = fp + '.tmp'
        await fs.writeFile(tmp, txt)
        await fs.rename(tmp, fp)
    }

    // ------ 獲取所有備份文件（新的在前） ------
    async function listBackupFiles(entry) {
        const { filename } = entry
        const baseName = filename.replace('.json', '')
        const files = await fs.readdir(storage)
        return files
            .filter(f => f.startsWith(baseName + '_') && f.endsWith('.bak'))
            .sort()
            .reverse()
    }

    // ------ 獲取最新備份文件 ------
    async function getLatestBackupFile(entry) {
        const files = await listBackupFiles(entry)
        return files.length ? files[0] : null
    }

    // ------ 創建時間戳備份 ------
    async function createTimestampBackup(entry, { force = false } = {}) {
        try {
            const { name, filename } = entry
            const fp = fullPath(filename)
            const timestamp = getTimestamp()

            // 同一分鐘內只備份一次（避免啟動/設定變更時重複產生相同備份）
            if (!force && lastBackupStamp[name] === timestamp) {
                return
            }
            lastBackupStamp[name] = timestamp

            const txt = await fs.readFile(fp, 'utf8')
            const baseName = filename.replace('.json', '')
            const backupName = `${baseName}_${timestamp}.bak`
            await fs.writeFile(fullPath(backupName), txt)

            debugLog(`created timestamped backup for ${filename} -> ${backupName}`)
            await cleanupOldBackups(entry)
        } catch (error) {
            errorLog(`backup failed for ${entry.filename}`, error)
        }
    }

    // ------ 清理舊備份 ------
    async function cleanupOldBackups(entry) {
        try {
            const retentionDays = api.getConfig('backupRetentionDays') || 3
            const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000)
            const files = await listBackupFiles(entry)

            let cleanedCount = 0
            for (const backupFile of files) {
                try {
                    const stat = await fs.stat(fullPath(backupFile))
                    if (stat.mtime.getTime() < cutoffTime) {
                        await fs.unlink(fullPath(backupFile))
                        cleanedCount++
                        debugLog(`cleaned old backup ${backupFile}`)
                    }
                } catch (error) {
                    debugLog(`failed to process backup ${backupFile}`, error)
                }
            }

            if (cleanedCount > 0) {
                debugLog(`cleaned ${cleanedCount} old backups for ${entry.filename}`)
            }
        } catch (error) {
            errorLog(`backup cleanup failed for ${entry.filename}`, error)
        }
    }

    // ------ 清理舊的簡單備份文件（兼容性清理） ------
    async function cleanupLegacyBackupFiles(entry) {
        try {
            const legacyBackup = fullPath(entry.filename + ".bak")
            try {
                await fs.stat(legacyBackup)
                await fs.unlink(legacyBackup)
                debugLog(`removed legacy backup file ${entry.filename}.bak`)
            } catch (error) {
                // 文件不存在，忽略
            }
        } catch (error) {
            debugLog(`failed to cleanup legacy backup for ${entry.filename}`, error)
        }
    }

    // ------ 設置定時備份 ------
    function setupBackupTimer(entry) {
        const interval = api.getConfig('backupInterval') || 0

        if (interval <= 0) {
            if (backupTimers[entry.name]) {
                clearInterval(backupTimers[entry.name])
                delete backupTimers[entry.name]
                debugLog(`disabled auto backup for ${entry.filename}`)
            }
            return
        }

        if (backupTimers[entry.name]) {
            clearInterval(backupTimers[entry.name])
            debugLog(`updated backup timer for ${entry.filename}`)
        } else {
            debugLog(`enabled auto backup for ${entry.filename}`)
        }

        const intervalMs = interval * 60 * 60 * 1000
        backupTimers[entry.name] = setInterval(() => {
            createTimestampBackup(entry)
        }, intervalMs)
        if (backupTimers[entry.name].unref) backupTimers[entry.name].unref()

        debugLog(`scheduled backup for ${entry.filename} every ${interval} hours`)

        // 第一次備份（延遲避免拖慢啟動；同一分鐘內自動去重）
        setTimeout(() => createTimestampBackup(entry), 2000)
    }

    // ------ LOAD DB ------
    async function loadDB(entry) {
        const { name, filename } = entry
        const fp = fullPath(filename)
        await cleanupLegacyBackupFiles(entry)

        let txt = null
        let parseError = null
        try {
            txt = await fs.readFile(fp, 'utf8')
            DB[name] = { data: JSON.parse(txt), filename }
            setupBackupTimer(entry)
            return
        } catch (e) {
            parseError = e
            if (txt !== null) {
                errorLog(`main file ${filename} is not valid JSON: ${e.message}`)
            }
        }

        // 主文件不存在或損壞：依序嘗試所有備份（新 -> 舊）
        const backups = await listBackupFiles(entry).catch(() => [])
        for (const backupName of backups) {
            try {
                const txt2 = await fs.readFile(fullPath(backupName), 'utf8')
                const data = JSON.parse(txt2)
                // 先把損壞的主文件留下來，再從備份還原
                if (txt !== null) {
                    const broken = `${filename}.corrupt-${getTimestamp()}`
                    await fs.writeFile(fullPath(broken), txt).catch(() => {})
                    errorLog(`kept broken file as ${broken}`)
                }
                await safeWrite(fp, txt2)
                DB[name] = { data, filename }
                infoLog(`restored ${filename} from backup ${backupName}`)
                setupBackupTimer(entry)
                return
            } catch (e) {
                debugLog(`backup ${backupName} unusable: ${e.message}`)
            }
        }

        // 完全沒有可用資料：建立新庫（若主文件存在但損壞，上面已另存副本）
        if (txt !== null) {
            const broken = `${filename}.corrupt-${getTimestamp()}`
            await fs.writeFile(fullPath(broken), txt).catch(() => {})
            errorLog(`no usable backup for ${filename}, kept broken file as ${broken}`)
        }
        const empty = {}
        await safeWrite(fp, JSON.stringify(empty, null, 2))
        DB[name] = { data: empty, filename }
        infoLog(`created new database ${filename}${parseError ? ' (previous file was unusable)' : ''}`)
        setupBackupTimer(entry)
    }

    // ------ SAVE DB ------
    async function saveDB(name) {
        const ent = DB[name]
        const fp = fullPath(ent.filename)
        const txt = JSON.stringify(ent.data, null, 2)

        return queue(name, async () => {
            await safeWrite(fp, txt)
            debugLog(`saved database ${ent.filename}`)
        })
    }

    // ------ LOAD ALL ------
    async function loadAll() {
        const list = api.getConfig("dbList") || []
        for (const x of list) await loadDB(x)
    }

    await loadAll()

    // 監聯配置變化
    api.subscribeConfig(["dbList", "backupInterval", "debugMode"], async () => {
        const list = api.getConfig("dbList") || []
        for (const x of list) {
            if (!DB[x.name]) {
                await loadDB(x)
            } else {
                setupBackupTimer(x)
            }
        }
    })

    // ------ 請求參數：query + POST body + Basic auth ------
    function parseBodyText(raw, contentType = '') {
        const text = String(raw || '').trim()
        if (!text) return {}
        if (contentType.includes('application/x-www-form-urlencoded')) {
            const out = {}
            for (const [k, v] of new URLSearchParams(text)) out[k] = v
            return out
        }
        try {
            const parsed = JSON.parse(text)
            return parsed && typeof parsed === 'object' ? parsed : {}
        } catch {}
        const out = {}
        try {
            for (const [k, v] of new URLSearchParams(text)) out[k] = v
        } catch {}
        return out
    }

    function readBody(req, limit = MAX_BODY_BYTES) {
        return new Promise(resolve => {
            if (!req || req.readableEnded || req.complete) return resolve('')
            let size = 0
            let done = false
            const chunks = []
            const finish = txt => {
                if (done) return
                done = true
                clearTimeout(timer)
                resolve(txt)
            }
            const timer = setTimeout(() => finish(''), 5000)
            req.on('data', c => {
                size += c.length
                if (size > limit) {
                    try { req.destroy() } catch {}
                    return finish('')
                }
                chunks.push(c)
            })
            req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
            req.on('error', () => finish(''))
        })
    }

    async function getParams(ctx) {
        const params = { ...(ctx.query || {}) }

        if (ctx.method === 'POST' || ctx.method === 'PUT' || ctx.method === 'PATCH') {
            // HFS 可能已經解析過 body
            const pre = (ctx.request && ctx.request.body) || (ctx.state && ctx.state.params)
            if (pre && typeof pre === 'object') {
                Object.assign(params, pre)
            } else {
                const raw = await readBody(ctx.req)
                if (raw) Object.assign(params, parseBodyText(raw, ctx.get('content-type') || ''))
            }
        }

        // HTTP Basic 認證（避免密碼出現在網址與紀錄中）
        if (params.user === undefined || params.pass === undefined) {
            const m = /^Basic\s+(.+)$/i.exec(ctx.get('authorization') || '')
            if (m) {
                try {
                    const decoded = Buffer.from(m[1], 'base64').toString('utf8')
                    const idx = decoded.indexOf(':')
                    const u = idx >= 0 ? decoded.slice(0, idx) : decoded
                    const p = idx >= 0 ? decoded.slice(idx + 1) : ''
                    if (params.user === undefined) params.user = u
                    if (params.pass === undefined) params.pass = p
                } catch {}
            }
        }

        return params
    }

    // ------ 手動備份 API ------
    async function manualBackup(ctx, params) {
        const db = params.db
        if (!db || !DB[db]) {
            ctx.body = { ok: false, error: "db not found" }
            return
        }

        const entry = api.getConfig("dbList").find(d => d.name === db)
        if (!entry) {
            ctx.body = { ok: false, error: "db entry not found" }
            return
        }

        try {
            await createTimestampBackup(entry, { force: true })
            ctx.body = { ok: true, message: "Backup created successfully" }
        } catch (error) {
            ctx.body = { ok: false, error: "Backup failed" }
        }
    }

    // ------ 列出備份文件 API ------
    async function listBackups(ctx, params) {
        const db = params.db
        if (!db) {
            ctx.body = { ok: false, error: "db parameter required" }
            return
        }

        const entry = api.getConfig("dbList").find(d => d.name === db)
        if (!entry) {
            ctx.body = { ok: false, error: "db not found" }
            return
        }

        try {
            const filesWithStats = await Promise.all(
                (await listBackupFiles(entry)).map(async f => {
                    const stat = await fs.stat(fullPath(f))
                    return {
                        name: f,
                        size: stat.size,
                        modified: stat.mtime,
                        created: stat.ctime,
                        readableSize: formatBytes(stat.size)
                    }
                })
            )
            filesWithStats.sort((a, b) => b.modified - a.modified)
            ctx.body = { ok: true, backups: filesWithStats, count: filesWithStats.length }
        } catch (error) {
            ctx.body = { ok: false, error: "Failed to list backups" }
        }
    }

    // ------ 格式化字節大小 ------
    function formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 Bytes'
        const k = 1024
        const dm = decimals < 0 ? 0 : decimals
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
        const i = Math.floor(Math.log(bytes) / Math.log(k))
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
    }

    // ------ AUTH CHECK ------
    function checkAuth(params) {
        if (!api.getConfig('apiAuthEnabled')) return true
        const u = params.user || ""
        const p = params.pass || ""
        return (u === api.getConfig('apiUser') && p === api.getConfig('apiPass'))
    }

    // ------ 值大小限制 ------
    function valueSize(val) {
        if (typeof val === 'string') return Buffer.byteLength(val)
        try { return Buffer.byteLength(JSON.stringify(val)) } catch { return 0 }
    }

    function parseValue(raw) {
        if (typeof raw !== 'string') return raw
        try { return JSON.parse(raw) } catch { return raw }
    }

    // ------ 設定 dot-path ------
    const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

    function applySet(data, key, val) {
        const parts = String(key).split('.')
        if (parts.some(p => FORBIDDEN_KEYS.has(p)))
            throw new Error('forbidden key')
        let cur = data
        for (let i = 0; i < parts.length - 1; i++) {
            const k = parts[i]
            if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {}
            cur = cur[k]
        }
        cur[parts.pop()] = val
    }

    // ------ MIDDLEWARE ------
    async function middleware(ctx) {
        const prefix = api.Const.API_URI + "jsondb/"
        if (!ctx.path.startsWith(prefix)) return

        const action = ctx.path.slice(prefix.length)

        const out = (obj, status = 200) => {
            ctx.status = status
            ctx.type = "application/json"
            ctx.body = JSON.stringify(obj)
            return ctx.stop()
        }

        // 只允許不會被瀏覽器快取誤觸的方法
        if (ctx.method !== 'GET' && ctx.method !== 'POST') {
            ctx.set('Allow', 'GET, POST')
            return out({ ok: false, error: "method not allowed" }, 405)
        }

        const params = await getParams(ctx)

        // Authentication
        if (!checkAuth(params)) {
            ctx.status = 403
            ctx.body = "Forbidden: API credentials required"
            return ctx.stop()
        }

        // 除錯資訊（需開啟 debugMode；已通過認證）
        if (action === 'debug' && api.getConfig('debugMode')) {
            const safeParams = { ...params }
            if (safeParams.pass !== undefined) safeParams.pass = '***'
            const safeQuery = { ...(ctx.query || {}) }
            if (safeQuery.pass !== undefined) safeQuery.pass = '***'
            return out({
                ok: true,
                method: ctx.method,
                query: safeQuery,
                hasRequestBody: !!(ctx.request && ctx.request.body),
                hasStateParams: !!(ctx.state && ctx.state.params),
                stateParamsPreview: JSON.stringify((ctx.state && ctx.state.params) || null).slice(0, 300),
                reqComplete: !!(ctx.req && ctx.req.complete),
                readableEnded: !!(ctx.req && ctx.req.readableEnded),
                paramsKeys: Object.keys(safeParams),
                paramsPreview: JSON.stringify(safeParams).slice(0, 300)
            })
        }

        if (action === "backup") {
            await manualBackup(ctx, params)
            return ctx.stop()
        }

        if (action === "list-backups") {
            await listBackups(ctx, params)
            return ctx.stop()
        }

        if (action === "" || action === "list" || action === "info") {
            return out({
                ok: true,
                list: api.getConfig('dbList') || [],
                backupConfig: {
                    interval: api.getConfig('backupInterval'),
                    retentionDays: api.getConfig('backupRetentionDays'),
                    debugMode: api.getConfig('debugMode')
                }
            })
        }

        const db = params.db
        const key = params.key

        if (!db || !DB[db])
            return out({ ok: false, error: "db not found" })

        const ent = DB[db]

        if (action === "dump") {
            return out({ ok: true, db, data: ent.data })
        }

        if (action === "keys") {
            const prefix2 = params.prefix || ''
            const keys = Object.keys(ent.data || {}).filter(k => k.startsWith(prefix2))
            return out({ ok: true, keys, count: keys.length })
        }

        if (action === "get") {
            if (!key) return out({ ok: true, data: ent.data })
            const val = String(key).split('.').reduce((o, k) => o?.[k], ent.data)
            return out({ ok: true, value: val })
        }

        if (action === "set") {
            if (!key) return out({ ok: false, error: "missing key" })
            if (params.value === undefined) return out({ ok: false, error: "missing value" })

            const val = parseValue(params.value)
            const max = Number(api.getConfig('maxValueBytes')) || 0
            const size = valueSize(val)
            if (max > 0 && size > max)
                return out({ ok: false, error: `value too large (${size} > ${max} bytes)` }, 413)

            try {
                applySet(ent.data, key, val)
            } catch (e) {
                return out({ ok: false, error: e.message }, 400)
            }
            await saveDB(db)
            debugLog(`set key ${key} in database ${db} (${size} bytes)`)
            return out({ ok: true, size })
        }

        if (action === "mset") {
            let items = params.items
            if (typeof items === 'string') {
                try { items = JSON.parse(items) } catch { return out({ ok: false, error: "items must be valid JSON" }) }
            }

            const pairs = []
            if (Array.isArray(items)) {
                for (const it of items) {
                    if (it && it.key !== undefined) pairs.push([it.key, it.value])
                }
            } else if (items && typeof items === 'object') {
                for (const [k, v] of Object.entries(items)) pairs.push([k, v])
            }

            if (!pairs.length) return out({ ok: false, error: "no items to write" })

            const max = Number(api.getConfig('maxValueBytes')) || 0
            let total = 0
            for (const [k, v] of pairs) {
                const size = valueSize(v)
                total += size
                if (max > 0 && size > max)
                    return out({ ok: false, error: `value too large for key ${k} (${size} > ${max} bytes)` }, 413)
            }

            for (const [k, v] of pairs) {
                try {
                    applySet(ent.data, k, v)
                } catch (e) {
                    return out({ ok: false, error: `${e.message}: ${k}` }, 400)
                }
            }
            await saveDB(db)
            debugLog(`mset ${pairs.length} keys in database ${db} (${total} bytes)`)
            return out({ ok: true, count: pairs.length, size: total })
        }

        if (action === "del") {
            if (!key) {
                const allow = api.getConfig('allowClearAll')
                if (!allow || params.confirm !== 'clear')
                    return out({ ok: false, error: "missing key (pass confirm=clear to wipe the whole database)" }, 400)
                ent.data = {}
                await saveDB(db)
                debugLog(`cleared entire database ${db}`)
                return out({ ok: true, cleared: true })
            }

            const parts = String(key).split('.')
            if (parts.some(p => FORBIDDEN_KEYS.has(p)))
                return out({ ok: false, error: "forbidden key" }, 400)
            let cur = ent.data
            for (let i = 0; i < parts.length - 1; i++)
                cur = cur?.[parts[i]]

            if (!cur || typeof cur !== 'object') return out({ ok: false, error: "key not found" })
            const last = parts.pop()
            if (!(last in cur)) return out({ ok: false, error: "key not found" })
            delete cur[last]
            await saveDB(db)
            debugLog(`deleted key ${key} from database ${db}`)
            return out({ ok: true })
        }

        debugLog(`unknown action requested: ${action}`)
        return out({ ok: false, error: "unknown action" })
    }

    return { middleware }
}
