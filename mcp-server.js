#!/usr/bin/env node

/**
 * MCP Server for Localhost Dashboard
 * Exposes local services to Claude Code instances
 *
 * Tools:
 * - list_services: Show all configured services and their status
 * - check_port: Check if a specific port is running
 * - start_service: Start a service by port
 * - stop_service: Stop a service by port
 * - get_service_info: Get detailed info about a service
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { exec } = require('child_process');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CONFIG_PATH = path.join(__dirname, 'services.json');

// Load services
function loadServices() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).services;
    } catch {
        return [];
    }
}

// Expand ~ to home
function expandPath(p) {
    return p.replace(/^~/, HOME);
}

// Check port status
function checkPort(port) {
    return new Promise((resolve) => {
        exec(`lsof -i :${port} -t`, (error, stdout) => {
            resolve({
                running: !!stdout.trim(),
                pid: stdout.trim().split('\n')[0] || null
            });
        });
    });
}

// Get all services with status
async function getAllServicesStatus() {
    const services = loadServices();
    const results = await Promise.all(
        services.map(async (s) => {
            const status = await checkPort(s.port);
            return {
                name: s.name,
                port: s.port,
                path: s.path,
                type: s.type,
                running: status.running,
                pid: status.pid,
                startCmd: s.startCmd,
                github: s.github || null,
                url: status.running ? `http://localhost:${s.port}` : null
            };
        })
    );
    return results;
}

// Start a service
async function startService(port) {
    const services = loadServices();
    const service = services.find(s => s.port === port);

    if (!service) {
        return { success: false, error: `No service configured for port ${port}` };
    }

    const cwd = expandPath(service.path);
    if (!fs.existsSync(cwd)) {
        return { success: false, error: `Directory not found: ${cwd}` };
    }

    const status = await checkPort(port);
    if (status.running) {
        return { success: false, error: `Port ${port} already in use (pid: ${status.pid})` };
    }

    return new Promise((resolve) => {
        const [cmd, ...args] = service.startCmd.split(' ');
        const child = spawn(cmd, args, {
            cwd,
            shell: true,
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, PORT: port.toString() }
        });
        child.unref();

        setTimeout(async () => {
            const newStatus = await checkPort(port);
            resolve({
                success: true,
                service: service.name,
                port: port,
                started: newStatus.running,
                message: newStatus.running
                    ? `Started ${service.name} on port ${port}`
                    : `Start command sent, but service may still be initializing`
            });
        }, 2000);
    });
}

// Stop a service
async function stopService(port) {
    const status = await checkPort(port);
    if (!status.running) {
        return { success: false, error: `Nothing running on port ${port}` };
    }

    return new Promise((resolve) => {
        exec(`lsof -i :${port} -t | xargs kill -9 2>/dev/null`, () => {
            resolve({ success: true, message: `Stopped service on port ${port}` });
        });
    });
}

// Create MCP server
const server = new Server(
    {
        name: 'localhost-dashboard',
        version: '1.0.0',
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'list_services',
                description: 'List all configured local development services with their current status (running/stopped). Use this to see what services are available and which ones are currently running.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        filter: {
                            type: 'string',
                            enum: ['all', 'running', 'stopped', 'frontend', 'backend', 'api'],
                            description: 'Filter services by status or type'
                        }
                    }
                }
            },
            {
                name: 'check_port',
                description: 'Check if a specific port has a service running on it',
                inputSchema: {
                    type: 'object',
                    properties: {
                        port: {
                            type: 'number',
                            description: 'The port number to check'
                        }
                    },
                    required: ['port']
                }
            },
            {
                name: 'start_service',
                description: 'Start a local development service by its port number. The service must be configured in the dashboard.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        port: {
                            type: 'number',
                            description: 'The port number of the service to start'
                        }
                    },
                    required: ['port']
                }
            },
            {
                name: 'stop_service',
                description: 'Stop a running service by its port number',
                inputSchema: {
                    type: 'object',
                    properties: {
                        port: {
                            type: 'number',
                            description: 'The port number of the service to stop'
                        }
                    },
                    required: ['port']
                }
            },
            {
                name: 'get_service_info',
                description: 'Get detailed information about a specific service including its path, start command, and GitHub repo',
                inputSchema: {
                    type: 'object',
                    properties: {
                        port: {
                            type: 'number',
                            description: 'The port number of the service'
                        }
                    },
                    required: ['port']
                }
            },
            {
                name: 'quick_status',
                description: 'Get a quick summary of running vs stopped services',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            }
        ]
    };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case 'list_services': {
                let services = await getAllServicesStatus();
                const filter = args?.filter || 'all';

                if (filter === 'running') {
                    services = services.filter(s => s.running);
                } else if (filter === 'stopped') {
                    services = services.filter(s => !s.running);
                } else if (['frontend', 'backend', 'api'].includes(filter)) {
                    services = services.filter(s => s.type === filter);
                }

                const formatted = services.map(s =>
                    `${s.running ? '🟢' : '⚫'} ${s.name} [:${s.port}] ${s.running ? s.url : '(stopped)'}`
                ).join('\n');

                return {
                    content: [{
                        type: 'text',
                        text: `Local Services (${filter}):\n\n${formatted}\n\nTotal: ${services.length} services`
                    }]
                };
            }

            case 'check_port': {
                const status = await checkPort(args.port);
                const services = loadServices();
                const service = services.find(s => s.port === args.port);

                return {
                    content: [{
                        type: 'text',
                        text: status.running
                            ? `Port ${args.port} is RUNNING (pid: ${status.pid})${service ? ` - ${service.name}` : ''}`
                            : `Port ${args.port} is NOT running${service ? ` - ${service.name} is stopped` : ''}`
                    }]
                };
            }

            case 'start_service': {
                const result = await startService(args.port);
                return {
                    content: [{
                        type: 'text',
                        text: result.success
                            ? `✅ ${result.message}\nURL: http://localhost:${args.port}`
                            : `❌ Failed: ${result.error}`
                    }]
                };
            }

            case 'stop_service': {
                const result = await stopService(args.port);
                return {
                    content: [{
                        type: 'text',
                        text: result.success ? `✅ ${result.message}` : `❌ ${result.error}`
                    }]
                };
            }

            case 'get_service_info': {
                const services = loadServices();
                const service = services.find(s => s.port === args.port);

                if (!service) {
                    return {
                        content: [{
                            type: 'text',
                            text: `No service configured for port ${args.port}`
                        }]
                    };
                }

                const status = await checkPort(args.port);

                return {
                    content: [{
                        type: 'text',
                        text: `Service: ${service.name}
Port: ${service.port}
Status: ${status.running ? 'RUNNING' : 'STOPPED'}
Type: ${service.type}
Path: ${service.path}
Start Command: ${service.startCmd}
GitHub: ${service.github || 'N/A'}
${status.running ? `URL: http://localhost:${service.port}` : ''}`
                    }]
                };
            }

            case 'quick_status': {
                const services = await getAllServicesStatus();
                const running = services.filter(s => s.running);
                const stopped = services.filter(s => !s.running);

                return {
                    content: [{
                        type: 'text',
                        text: `📊 Local Services Status

🟢 Running: ${running.length}
${running.map(s => `   • ${s.name} → http://localhost:${s.port}`).join('\n') || '   (none)'}

⚫ Stopped: ${stopped.length}
${stopped.slice(0, 5).map(s => `   • ${s.name} [:${s.port}]`).join('\n')}${stopped.length > 5 ? `\n   ... and ${stopped.length - 5} more` : ''}

Total: ${services.length} services configured`
                    }]
                };
            }

            default:
                return {
                    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
                    isError: true
                };
        }
    } catch (error) {
        return {
            content: [{ type: 'text', text: `Error: ${error.message}` }],
            isError: true
        };
    }
});

// Start server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Localhost Dashboard MCP Server running');
}

main().catch(console.error);
