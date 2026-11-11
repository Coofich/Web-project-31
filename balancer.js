const http = require('http');

const servers = [
    { host: 'localhost', port: 3001 },
    { host: 'localhost', port: 3002 }
];

let currentServerIndex = 0;

const balancer = http.createServer((clientReq, clientRes) => {
    const targetServer = servers[currentServerIndex];
    currentServerIndex = (currentServerIndex + 1) % servers.length; 

    console.log(`[Load Balancer] Направляю запит ${clientReq.url} на порт ${targetServer.port}`);

    const options = {
        hostname: targetServer.host,
        port: targetServer.port,
        path: clientReq.url,
        method: clientReq.method,
        headers: clientReq.headers
    };

    const proxyReq = http.request(options, (proxyRes) => {
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(clientRes, { end: true });
    });

    proxyReq.on('error', (err) => {
        console.error(`[Load Balancer Помилка]: Сервер на порту ${targetServer.port} недоступний.`);
        clientRes.writeHead(503);
        clientRes.end("Service Unavailable (Application Server is down)");
    });

    clientReq.pipe(proxyReq, { end: true });
});

balancer.listen(3000, () => {
    console.log('Load Balancer запущено на http://localhost:3000');
});
