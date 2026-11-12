const express = require('express');
const db = require('./database');
const app = express();

app.use(express.json());
app.use(express.static('public'));

const PORT = parseInt(process.argv[2]) || 3001;
const MAX_ACTIVE_TASKS = 2;
let activeTasksCount = 0;

function getWaitTime(queuePos, complexity) {
    return Math.round((queuePos * (complexity * 50)) / 1000);
}

app.post('/api/login', (req, res) => {
    const { username } = req.body;
    const token = Buffer.from(username + Date.now()).toString('base64');
    
    db.run(`INSERT OR IGNORE INTO users (username, token) VALUES (?, ?)`, [username, token], function() {
        db.get(`SELECT id, token FROM users WHERE username = ?`, [username], (err, row) => {
            res.json({ token: row.token, user_id: row.id });
        });
    });
});

app.post('/api/task', (req, res) => {
    const { user_id, complexity, filterType } = req.body;

    if (complexity > 100) {
        return res.status(400).json({ error: "Перевищено ліміт трудомісткості (макс 100)!" });
    }

    const taskName = `Фільтр: ${filterType}, Складність: ${complexity}`;
    
    if (activeTasksCount >= MAX_ACTIVE_TASKS) {
        db.run(`INSERT INTO tasks (user_id, task_name, server_port, status) VALUES (?, ?, ?, 'queued')`, 
        [user_id, taskName, null], function() {
            const taskId = this.lastID;
            db.get(`SELECT COUNT(*) as pos FROM tasks WHERE status = 'queued' AND id <= ?`, [taskId], (err, row) => {
                res.status(202).json({ 
                    message: "Ресурси вичерпані. Запит у черзі.", 
                    task_id: taskId,
                    queue_position: row.pos,
                    estimated_wait_sec: getWaitTime(row.pos, complexity)
                });
            });
        });
        return;
    }

    activeTasksCount++;
    db.run(`INSERT INTO tasks (user_id, task_name, server_port, status) VALUES (?, ?, ?, 'processing')`, 
    [user_id, taskName, PORT], function() {
        res.json({ message: "Виконання розпочато", task_id: this.lastID });
        processTask(this.lastID, complexity);
    });
});

async function processTask(taskId, complexity) {
    for (let i = 1; i <= 10; i++) {
        const row = await new Promise(res => db.get(`SELECT status FROM tasks WHERE id = ?`, [taskId], (e, r) => res(r)));
        if (row && row.status === 'cancelled') {
            activeTasksCount--;
            checkQueue();
            return; 
        }

        await new Promise(res => setTimeout(res, complexity * 50));
        db.run(`UPDATE tasks SET progress = ? WHERE id = ?`, [i * 10, taskId]);
    }

    db.run(`UPDATE tasks SET status = 'completed' WHERE id = ?`, [taskId]);
    activeTasksCount--;
    checkQueue();
}

function checkQueue() {
    if (activeTasksCount < MAX_ACTIVE_TASKS) {
        db.get(`SELECT * FROM tasks WHERE status = 'queued' ORDER BY id ASC LIMIT 1`, (err, task) => {
            if (task) {
                activeTasksCount++;
                db.run(`UPDATE tasks SET status = 'processing', server_port = ? WHERE id = ?`, [PORT, task.id]);
                const comp = parseInt(task.task_name.match(/Складність: (\d+)/)[1]) || 50;
                processTask(task.id, comp);
            }
        });
    }
}

app.get('/api/progress/:taskId', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const interval = setInterval(() => {
        db.get(`SELECT progress, status FROM tasks WHERE id = ?`, [req.params.taskId], (err, row) => {
            if (row) {
                res.write(`data: ${JSON.stringify(row)}\n\n`);
                if (['completed', 'cancelled', 'error'].includes(row.status)) {
                    clearInterval(interval);
                    res.end();
                }
            }
        });
    }, 1000);

    req.on('close', () => clearInterval(interval));
});

app.get('/api/tasks/:userId', (req, res) => {
    db.all(`SELECT * FROM tasks WHERE user_id = ? ORDER BY id DESC LIMIT 15`, [req.params.userId], (err, rows) => res.json(rows));
});

app.post('/api/cancel/:taskId', (req, res) => {
    db.run(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`, [req.params.taskId], () => res.json({ message: "Скасовано" }));
});

app.get('/api/internal/stats', (req, res) => res.json({ port: PORT, activeTasks: activeTasksCount }));

app.listen(PORT, () => console.log(`[App Server] Started on port ${PORT}`));
