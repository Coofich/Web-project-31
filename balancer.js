const http = require('http');
const httpProxy = require('http-proxy');
const { spawn } = require('child_process');
const db = require('./database');

const proxy = httpProxy.createProxyServer({});
let servers = [];
let currentServerIndex = 0;
const MAX_SERVERS = 4;
let nextPort = 3001;

function spawnNewServer() {
    if (servers.length >= MAX_SERVERS) return;
    const port = nextPort++;
    const worker = spawn('node', ['server.js', port], { stdio: 'inherit', shell: true });
    servers.push({ port, worker });
    console.log(`[Balancer] Server spawned on port ${port}. Total servers: ${servers.length}`);
}

spawnNewServer();
spawnNewServer();

setInterval(() => {
    db.get(`SELECT COUNT(*) as count FROM tasks WHERE status = 'queued'`, (err, row) => {
        if (row && row.count > 0 && servers.length < MAX_SERVERS) {
            console.log(`[Balancer] Queued tasks detected: ${row.count}. Auto-scaling new server.`);
            spawnNewServer();
        }
    });
}, 5000);

const server = http.createServer((req, res) => {
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
                    nodeLoads: nodeLoads,
                    tasks: tasks
                }));
            }
        );
        return;
    }

    if (servers.length === 0) {
        res.writeHead(500);
        return res.end("No available application servers");
    }

    const targetServer = servers[currentServerIndex];
    currentServerIndex = (currentServerIndex + 1) % servers.length;

    proxy.web(req, res, { target: `http://localhost:${targetServer.port}` }, (err) => {
        res.writeHead(502);
        res.end("Bad Gateway - Application server is down");
    });
});

server.listen(3000, () => {
    console.log(`[Balancer] Main load balancer running on http://localhost:3000`);
    console.log(`[Balancer] Admin monitor running on http://localhost:3000/admin.html`);
});
