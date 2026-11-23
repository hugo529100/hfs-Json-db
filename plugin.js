exports.version = 1.2
exports.apiRequired = 8.85
exports.hasConfig = true
exports.description = "JSON DB (Multiple Databases, Auto Backup, Password Protection, Admin API Hints + Log Hints)"
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

Delete data:
/~/api/jsondb/del?db=DBNAME&key=KEY

Export entire database:
/~/api/jsondb/dump?db=DBNAME

List all databases:
/~/api/jsondb/list

If API requires credentials, append:
&user=USERNAME&pass=PASSWORD
        `
    },

    apiAuthEnabled: {
        type: 'boolean',
        label: 'Enable API Username/Password Protection',
        defaultValue: false,
        helperText: "If enabled, all APIs require ?user=xxx&pass=xxx"
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

    // ------ 獲取最新備份文件 ------
    async function getLatestBackupFile(entry) {
        const { filename } = entry
        const baseName = filename.replace('.json', '')
        const files = await fs.readdir(storage)
        const backupFiles = files.filter(f => 
            f.startsWith(baseName + '_') && f.endsWith('.bak')
        )
        
        if (backupFiles.length === 0) return null
        
        // 按文件名排序（時間戳格式自然排序，最新的在最後）
        backupFiles.sort()
        
        // 返回最新的備份文件
        return backupFiles[backupFiles.length - 1]
    }

    // ------ 創建時間戳備份 ------
    async function createTimestampBackup(entry) {
        try {
            const { name, filename } = entry
            const fp = fullPath(filename)
            
            // 讀取當前文件內容
            const txt = await fs.readFile(fp, 'utf8')
            const timestamp = getTimestamp()
            
            // 創建備份文件名 (filename_YYYYMMDD_HHMM.bak)
            const baseName = filename.replace('.json', '')
            const backupName = `${baseName}_${timestamp}.bak`
            const backupPath = fullPath(backupName)
            
            // 寫入備份文件
            await fs.writeFile(backupPath, txt)
            
            debugLog(`created timestamped backup for ${filename} -> ${backupName}`)
            
            // 清理舊備份
            await cleanupOldBackups(entry)
            
        } catch (error) {
            errorLog(`backup failed for ${entry.filename}`, error)
        }
    }

    // ------ 清理舊備份 ------
    async function cleanupOldBackups(entry) {
        try {
            const { filename } = entry
            const retentionDays = api.getConfig('backupRetentionDays') || 3
            const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000)
            
            const baseName = filename.replace('.json', '')
            const files = await fs.readdir(storage)
            const backupFiles = files.filter(f => 
                f.startsWith(baseName + '_') && f.endsWith('.bak')
            )
            
            if (backupFiles.length === 0) return
            
            let cleanedCount = 0
            // 獲取文件創建時間
            for (const backupFile of backupFiles) {
                try {
                    const stat = await fs.stat(fullPath(backupFile))
                    if (stat.ctime.getTime() < cutoffTime) {
                        await fs.unlink(fullPath(backupFile))
                        cleanedCount++
                        debugLog(`cleaned old backup ${backupFile}`)
                    }
                } catch (error) {
                    debugLog(`failed to process backup ${backupFile}`, error)
                }
            }
            
            if (cleanedCount > 0) {
                debugLog(`cleaned ${cleanedCount} old backups for ${filename}`)
            }
            
        } catch (error) {
            errorLog(`backup cleanup failed for ${entry.filename}`, error)
        }
    }

    // ------ 清理舊的簡單備份文件（兼容性清理） ------
    async function cleanupLegacyBackupFiles(entry) {
        try {
            const { filename } = entry
            const legacyBackup = fullPath(filename + ".bak")
            
            // 檢查是否存在舊的簡單備份文件
            try {
                await fs.stat(legacyBackup)
                // 如果存在，刪除它
                await fs.unlink(legacyBackup)
                debugLog(`removed legacy backup file ${filename}.bak`)
            } catch (error) {
                // 文件不存在，忽略
            }
        } catch (error) {
            debugLog(`failed to cleanup legacy backup for ${entry.filename}`, error)
        }
    }

    // ------ 設置定時備份 ------
    function setupBackupTimer(entry) {
        const interval = api.getConfig('backupInterval') || 12
        
        if (interval <= 0) {
            // 禁用定時備份
            if (backupTimers[entry.name]) {
                clearInterval(backupTimers[entry.name])
                delete backupTimers[entry.name]
                debugLog(`disabled auto backup for ${entry.filename}`)
            }
            return
        }
        
        // 清理現有定時器
        if (backupTimers[entry.name]) {
            clearInterval(backupTimers[entry.name])
            debugLog(`updated backup timer for ${entry.filename}`)
        } else {
            debugLog(`enabled auto backup for ${entry.filename}`)
        }
        
        // 設置新的定時器（小時轉毫秒）
        const intervalMs = interval * 60 * 60 * 1000
        backupTimers[entry.name] = setInterval(() => {
            createTimestampBackup(entry)
        }, intervalMs)
        
        debugLog(`scheduled backup for ${entry.filename} every ${interval} hours`)
        
        // 立即執行第一次備份
        setTimeout(() => createTimestampBackup(entry), 1000)
    }

    // ------ LOAD DB ------
    async function loadDB(entry) {
        const { name, filename } = entry
        const fp = fullPath(filename)
        
        // 首先清理舊的簡單備份文件
        await cleanupLegacyBackupFiles(entry)

        try {
            // 嘗試直接讀取主文件
            const txt = await fs.readFile(fp, 'utf8')
            DB[name] = { data: JSON.parse(txt), filename }
            setupBackupTimer(entry)
            
            // 創建初始備份
            setTimeout(() => createTimestampBackup(entry), 2000)
            return
        } catch {}

        try {
            // 嘗試從最新的時間戳備份恢復
            const latestBackup = await getLatestBackupFile(entry)
            if (latestBackup) {
                const txt = await fs.readFile(fullPath(latestBackup), 'utf8')
                await safeWrite(fp, txt)
                DB[name] = { data: JSON.parse(txt), filename }
                infoLog(`restored ${filename} from timestamped backup ${latestBackup}`)
                setupBackupTimer(entry)
                return
            }
        } catch (error) {
            debugLog(`failed to restore from backup for ${filename}`, error)
        }

        // 創建新數據庫
        const empty = {}
        const txt = JSON.stringify(empty, null, 2)
        await safeWrite(fp, txt)
        DB[name] = { data: empty, filename }
        infoLog(`created new database ${filename}`)
        
        // 創建初始時間戳備份
        setTimeout(() => createTimestampBackup(entry), 2000)
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
    
    // 監聽配置變化
    api.subscribeConfig(["dbList", "backupInterval", "debugMode"], async () => {
        // 重新加載所有數據庫並更新定時器
        const list = api.getConfig("dbList") || []
        for (const x of list) {
            if (!DB[x.name]) {
                await loadDB(x)
            } else {
                // 更新現有數據庫的備份定時器
                setupBackupTimer(x)
            }
        }
    })

    // ------ 手動備份 API ------
    async function manualBackup(ctx) {
        const db = ctx.query.db
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
            await createTimestampBackup(entry)
            ctx.body = { ok: true, message: "Backup created successfully" }
        } catch (error) {
            ctx.body = { ok: false, error: "Backup failed" }
        }
    }

    // ------ 列出備份文件 API ------
    async function listBackups(ctx) {
        const db = ctx.query.db
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
            const { filename } = entry
            const baseName = filename.replace('.json', '')
            const files = await fs.readdir(storage)
            const backupFiles = files.filter(f => 
                f.startsWith(baseName + '_') && f.endsWith('.bak')
            )
            
            const filesWithStats = await Promise.all(
                backupFiles.map(async f => {
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
            
            // 按創建時間排序（新的在前）
            filesWithStats.sort((a, b) => b.created - a.created)
            
            ctx.body = { 
                ok: true, 
                backups: filesWithStats,
                count: filesWithStats.length
            }
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
    function checkAuth(ctx) {
        if (!api.getConfig('apiAuthEnabled')) return true
        const u = ctx.query.user || ""
        const p = ctx.query.pass || ""
        return (u === api.getConfig('apiUser') && p === api.getConfig('apiPass'))
    }

    // ------ MIDDLEWARE ------
    async function middleware(ctx) {
        const prefix = api.Const.API_URI + "jsondb/"
        if (!ctx.path.startsWith(prefix)) return

        // Authentication
        if (!checkAuth(ctx)) {
            ctx.status = 403
            ctx.body = "Forbidden: API credentials required"
            return ctx.stop()
        }

        const action = ctx.path.slice(prefix.length)
        const q = ctx.query || {}

        function out(obj) {
            ctx.type = "application/json"
            ctx.body = JSON.stringify(obj)
            return ctx.stop()
        }

        // 新增備份相關 API
        if (action === "backup") {
            return await manualBackup(ctx)
        }
        
        if (action === "list-backups") {
            return await listBackups(ctx)
        }

        if (action === "" || action === "list") {
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

        if (action === "info") {
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

        const db = q.db
        const key = q.key

        if (!db || !DB[db])
            return out({ ok: false, error: "db not found" })

        const ent = DB[db]

        if (action === "dump") {
            return out({ ok: true, db, data: ent.data })
        }

        if (action === "get") {
            if (!key) return out({ ok: true, data: ent.data })
            const val = key.split('.').reduce((o, k) => o?.[k], ent.data)
            return out({ ok: true, value: val })
        }

        if (action === "set") {
            if (!key) return out({ ok: false, error: "missing key" })
            let val = q.value
            try { val = JSON.parse(val) } catch {}

            const parts = key.split('.')
            let cur = ent.data
            for (let i = 0; i < parts.length - 1; i++) {
                if (typeof cur[parts[i]] !== "object") cur[parts[i]] = {}
                cur = cur[parts[i]]
            }
            cur[parts.pop()] = val

            await saveDB(db)
            debugLog(`set key ${key} in database ${db}`)
            return out({ ok: true })
        }

        if (action === "del") {
            if (!key) {
                ent.data = {}
                await saveDB(db)
                debugLog(`cleared entire database ${db}`)
                return out({ ok: true, cleared: true })
            }
            const parts = key.split('.')
            let cur = ent.data
            for (let i = 0; i < parts.length - 1; i++)
                cur = cur?.[parts[i]]

            if (!cur) return out({ ok: false, error: "key not found" })
            delete cur[parts.pop()]
            await saveDB(db)
            debugLog(`deleted key ${key} from database ${db}`)
            return out({ ok: true })
        }

        debugLog(`unknown action requested: ${action}`)
        return out({ ok: false, error: "unknown action" })
    }

    return { middleware }
}