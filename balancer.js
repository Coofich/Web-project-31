const https = require('https');
const httpProxy = require('http-proxy');
const { spawn } = require('child_process');
const fs = require('fs');
const db = require('./database');

const httpsOptions = {
    key: fs.readFileSync('./server.key'),
    cert: fs.readFileSync('./server.cert')
};

const proxy = httpProxy.createProxyServer({
    proxyTimeout: 60000,
    timeout: 60000
});

let servers = [];
let currentServerIndex = 0;
let taskServerIndex = 0;
const MAX_SERVERS = 4;
let nextPort = 3001;

function spawnNewServer() {
    if (servers.length >= MAX_SERVERS) return;
    const port = nextPort++;
    const worker = spawn('node', ['server.js', port.toString()], { stdio: 'inherit' });
    setTimeout(() => {
        servers.push({ port, worker });
        console.log(`[Balancer] Server on port ${port} is ready. Total: ${servers.length}`);
    }, 800);
}

function cleanup() {
    servers.forEach(s => {
        try { s.worker.kill(); } catch (e) {}
    });
    process.exit();
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

spawnNewServer();
spawnNewServer();

setInterval(() => {
    db.get(`SELECT COUNT(*) as count FROM tasks WHERE status = 'queued'`, (err, row) => {
        if (row && row.count > 0 && servers.length < MAX_SERVERS) {
            console.log(`[Balancer] Queued tasks detected: ${row.count}. Auto-scaling new server.`);
            spawnNewServer();
        }
    });
}, 2000);

function getTargetServer(req, callback) {
    if (req.method === 'POST' && req.url === '/api/task') {
        db.all(`SELECT server_port, COUNT(*) as cnt FROM tasks WHERE status = 'processing' GROUP BY server_port`, (err, rows) => {
            const loadMap = {};
            (rows || []).forEach(r => { loadMap[r.server_port] = r.cnt; });

            let minLoad = 999;
            servers.forEach(s => {
                const load = loadMap[s.port] || 0;
                if (load < minLoad) minLoad = load;
            });

            if (minLoad >= 2) {
                const target = servers[taskServerIndex % servers.length];
                taskServerIndex = (taskServerIndex + 1) % servers.length;
                return callback(target);
            }

            const candidates = servers
                .filter(s => (loadMap[s.port] || 0) === minLoad)
                .sort((a, b) => a.port - b.port);
            const chosen = candidates[taskServerIndex % candidates.length];
            taskServerIndex = (taskServerIndex + 1) % servers.length;
            callback(chosen);
        });
        return;
    }

    const target = servers[currentServerIndex];
    currentServerIndex = (currentServerIndex + 1) % servers.length;
    callback(target);
}

function handleRequest(req, res) {
    if (req.url === '/api/admin/system-stats') {
        db.all(
            `SELECT t.id, t.user_id, u.username, t.task_name, t.progress, t.status, t.server_port 
             FROM tasks t 
             LEFT JOIN users u ON t.user_id = u.id 
             WHERE t.status IN ('processing', 'queued') 
             ORDER BY t.id DESC`,
            (err, activeTasks) => {
                const tasks = activeTasks || [];
                const queuedCount = tasks.filter(t => t.status === 'queued').length;
                const processingCount = tasks.filter(t => t.status === 'processing').length;

                const nodeLoads = servers.map(s => {
                    const load = tasks.filter(t => t.server_port === s.port && t.status === 'processing').length;
                    return { port: s.port, load };
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    activeServersCount: servers.length,
                    maxServers: MAX_SERVERS,
                    queuedTasks: queuedCount,
                    processingTasks: processingCount,
                    servers: servers.map(s => s.port),
                    nodeLoads,
                    tasks
                }));
            }
        );
        return;
    }

    if (servers.length === 0) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: "Вузли кластера ініціалізуються. Зачекайте 1 секунду." }));
    }

    req.pause();
    getTargetServer(req, (targetServer) => {
        req.resume();
        if (!targetServer) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: "Немає доступних серверів" }));
        }

        proxy.web(req, res, { target: `http://localhost:${targetServer.port}` }, () => {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Вузол тимчасово недоступний" }));
        });
    });
}

const server = https.createServer(httpsOptions, handleRequest);

server.listen(3000, () => {
    console.log(`[Balancer] HTTPS Load Balancer running on https://localhost:3000`);
    console.log(`[Balancer] Admin monitor running on https://localhost:3000/admin.html`);
});
