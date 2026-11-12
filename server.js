const express = require('express');
const db = require('./database');
const app = express();

app.use(express.json());
app.use(express.static('public'));

const PORT = parseInt(process.argv[2]) || 3001;
const MAX_ACTIVE_TASKS = 2;
const MAX_TASKS_PER_USER = 20;
let activeTasksCount = 0;

function getWaitTime(queuePos, complexity) {
    return Math.round((queuePos * (complexity * 50)) / 1000);
}

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: "Введіть логін та пароль!" });
    }
    const token = Buffer.from(username + Date.now()).toString('base64');
    db.run(
        `INSERT INTO users (username, password, token) VALUES (?, ?, ?)`,
        [username, password, token],
        function(err) {
            if (err) {
                return res.status(400).json({ error: "Користувач з таким логіном уже існує! Будь ласка, увійдіть." });
            }
            res.json({ message: "Реєстрація успішна! Тепер ви можете увійти." });
        }
    );
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: "Введіть логін та пароль!" });
    }
    db.get(`SELECT id, username, password FROM users WHERE username = ?`, [username], (err, row) => {
        if (!row) {
            return res.status(401).json({ error: "Користувача не знайдено! Перевірте логін або зареєструйтесь." });
        }
        if (row.password && row.password !== password) {
            return res.status(401).json({ error: "Невірний пароль! Спробуйте ще раз." });
        }
        const token = Buffer.from(username + Date.now()).toString('base64');
        db.run(`UPDATE users SET token = ? WHERE id = ?`, [token, row.id], () => {
            res.json({ token, user_id: row.id, username: row.username });
        });
    });
});

app.post('/api/task', (req, res) => {
    const { user_id, complexity, filterType } = req.body;

    if (!complexity || complexity > 100 || complexity < 1) {
        return res.status(400).json({ error: "Перевищено ліміт трудомісткості! Дозволено значення від 1 до 100." });
    }

    const taskName = `Фільтр: ${filterType}, Складність: ${complexity}`;

    db.run(
        `DELETE FROM tasks WHERE user_id = ? AND id NOT IN (
            SELECT id FROM tasks WHERE user_id = ? ORDER BY id DESC LIMIT ?
        )`,
        [user_id, user_id, MAX_TASKS_PER_USER - 1]
    );

    if (activeTasksCount >= MAX_ACTIVE_TASKS) {
        db.run(
            `INSERT INTO tasks (user_id, task_name, server_port, status) VALUES (?, ?, ?, 'queued')`,
            [user_id, taskName, null],
            function() {
                const taskId = this.lastID;
                db.get(
                    `SELECT COUNT(*) as pos FROM tasks WHERE status = 'queued' AND id <= ?`,
                    [taskId],
                    (err, row) => {
                        const waitSec = getWaitTime(row ? row.pos : 1, complexity);
                        res.status(202).json({
                            queued: true,
                            message: "Усі ресурси системи наразі вичерпані (ліміт: 2 задачі на вузол). Запит успішно поставлено у чергу.",
                            task_id: taskId,
                            queue_position: row ? row.pos : 1,
                            estimated_wait_sec: waitSec
                        });
                    }
                );
            }
        );
        return;
    }

    activeTasksCount++;
    db.run(
        `INSERT INTO tasks (user_id, task_name, server_port, status) VALUES (?, ?, ?, 'processing')`,
        [user_id, taskName, PORT],
        function() {
            res.json({ message: "Виконання розпочато", task_id: this.lastID });
            processTask(this.lastID, complexity);
        }
    );
});

async function processTask(taskId, complexity) {
    for (let i = 1; i <= 10; i++) {
        const row = await new Promise(res =>
            db.get(`SELECT status FROM tasks WHERE id = ?`, [taskId], (e, r) => res(r))
        );
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
        db.get(
            `SELECT * FROM tasks WHERE status = 'queued' ORDER BY id ASC LIMIT 1`,
            (err, task) => {
                if (!task) return;
                db.run(
                    `UPDATE tasks SET status = 'processing', server_port = ? WHERE id = ? AND status = 'queued'`,
                    [PORT, task.id],
                    function() {
                        if (this.changes > 0) {
                            activeTasksCount++;
                            const comp = parseInt(task.task_name.match(/Складність: (\d+)/)[1]) || 50;
                            processTask(task.id, comp);
                        }
                    }
                );
            }
        );
    }
}

app.get('/api/progress/:taskId', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const interval = setInterval(() => {
        db.get(
            `SELECT progress, status FROM tasks WHERE id = ?`,
            [req.params.taskId],
            (err, row) => {
                if (row) {
                    res.write(`data: ${JSON.stringify(row)}\n\n`);
                    if (['completed', 'cancelled', 'error'].includes(row.status)) {
                        clearInterval(interval);
                        res.end();
                    }
                }
            }
        );
    }, 1000);

    req.on('close', () => clearInterval(interval));
});

app.get('/api/tasks/:userId', (req, res) => {
    db.all(
        `SELECT * FROM tasks WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
        [req.params.userId, MAX_TASKS_PER_USER],
        (err, rows) => res.json(rows)
    );
});

app.post('/api/cancel/:taskId', (req, res) => {
    db.run(
        `UPDATE tasks SET status = 'cancelled' WHERE id = ?`,
        [req.params.taskId],
        () => res.json({ message: "Скасовано" })
    );
});

app.get('/api/internal/stats', (req, res) =>
    res.json({ port: PORT, activeTasks: activeTasksCount })
);

app.listen(PORT, () => console.log(`[App Server] Started on port ${PORT}`));
