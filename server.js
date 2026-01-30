const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const os = require('os');

const PORT = 9999;
const HOME = os.homedir();

// Track running processes
const runningProcesses = new Map();

// Load services config
function loadServices() {
    const configPath = path.join(__dirname, 'services.json');
    return JSON.parse(fs.readFileSync(configPath, 'utf8')).services;
}

// Expand ~ to home directory
function expandPath(p) {
    return p.replace(/^~/, HOME);
}

// Check if a port is in use
function checkPort(port) {
    return new Promise((resolve) => {
        exec(`lsof -i :${port} -t`, (error, stdout) => {
            resolve(stdout.trim() ? { running: true, pid: stdout.trim().split('\n')[0] } : { running: false });
        });
    });
}

// Start a service
function startService(service) {
    return new Promise((resolve, reject) => {
        const cwd = expandPath(service.path);

        // Check if directory exists
        if (!fs.existsSync(cwd)) {
            reject(new Error(`Directory not found: ${cwd}`));
            return;
        }

        const [cmd, ...args] = service.startCmd.split(' ');

        console.log(`Starting ${service.name} in ${cwd}: ${service.startCmd}`);

        const child = spawn(cmd, args, {
            cwd,
            shell: true,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PORT: service.port.toString() }
        });

        child.unref();

        runningProcesses.set(service.port, {
            pid: child.pid,
            name: service.name,
            startedAt: new Date().toISOString()
        });

        // Give it a moment to start
        setTimeout(() => {
            resolve({ success: true, pid: child.pid });
        }, 1000);

        child.on('error', (err) => {
            reject(err);
        });
    });
}

// Stop a service by port
function stopService(port) {
    return new Promise((resolve) => {
        exec(`lsof -i :${port} -t | xargs kill -9 2>/dev/null`, (error) => {
            runningProcesses.delete(port);
            resolve({ success: true });
        });
    });
}

// Get all services status
async function getAllStatus() {
    const services = loadServices();
    const statuses = await Promise.all(
        services.map(async (s) => {
            const status = await checkPort(s.port);
            return { ...s, ...status };
        })
    );
    return statuses;
}

// CORS headers
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

// Request handler
const server = http.createServer(async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    // Serve static files
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/html' });
        res.end(html);
        return;
    }

    // API: Get all services with status
    if (req.method === 'GET' && url.pathname === '/api/services') {
        try {
            const statuses = await getAllStatus();
            res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify(statuses));
        } catch (err) {
            res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // API: Check single port status
    if (req.method === 'GET' && url.pathname.startsWith('/api/status/')) {
        const port = parseInt(url.pathname.split('/')[3]);
        const status = await checkPort(port);
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
        return;
    }

    // API: Start service
    if (req.method === 'POST' && url.pathname.startsWith('/api/start/')) {
        const port = parseInt(url.pathname.split('/')[3]);
        const services = loadServices();
        const service = services.find(s => s.port === port);

        if (!service) {
            res.writeHead(404, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Service not found' }));
            return;
        }

        try {
            const result = await startService(service);
            res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // API: Stop service
    if (req.method === 'POST' && url.pathname.startsWith('/api/stop/')) {
        const port = parseInt(url.pathname.split('/')[3]);
        const result = await stopService(port);
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
    }

    // API: Add service
    if (req.method === 'POST' && url.pathname === '/api/services') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const newService = JSON.parse(body);
                const configPath = path.join(__dirname, 'services.json');
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                config.services.push(newService);
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (err) {
                res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // API: Remove service
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/services/')) {
        const port = parseInt(url.pathname.split('/')[3]);
        const configPath = path.join(__dirname, 'services.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.services = config.services.filter(s => s.port !== port);
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // API: Open in VS Code
    if (req.method === 'POST' && url.pathname.startsWith('/api/code/')) {
        const port = parseInt(url.pathname.split('/')[3]);
        const services = loadServices();
        const service = services.find(s => s.port === port);

        if (service) {
            const fullPath = expandPath(service.path);
            exec(`code "${fullPath}"`, (err) => {
                res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: !err }));
            });
        } else {
            res.writeHead(404, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Service not found' }));
        }
        return;
    }

    // API: Open in Finder
    if (req.method === 'POST' && url.pathname.startsWith('/api/finder/')) {
        const port = parseInt(url.pathname.split('/')[3]);
        const services = loadServices();
        const service = services.find(s => s.port === port);

        if (service) {
            const fullPath = expandPath(service.path);
            exec(`open "${fullPath}"`, (err) => {
                res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: !err }));
            });
        } else {
            res.writeHead(404, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Service not found' }));
        }
        return;
    }

    // 404
    res.writeHead(404, corsHeaders);
    res.end('Not found');
});

server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════╗
║         LOCALHOST DASHBOARD SERVER                 ║
║                                                    ║
║   Dashboard: http://localhost:${PORT}                 ║
║   API:       http://localhost:${PORT}/api/services    ║
║                                                    ║
║   Press Ctrl+C to stop                             ║
╚════════════════════════════════════════════════════╝
`);
});
