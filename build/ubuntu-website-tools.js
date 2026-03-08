/**
 * Ubuntu Website Management Tools for MCP SSH Server
 *
 * Extended tools specifically for managing Ubuntu web servers
 * and website deployments. This module provides specialized tools for managing
 * Nginx, system packages, SSL certificates, website deployments, and firewalls
 * on Ubuntu servers.
 */
import { z } from 'zod';
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
// Utility function to execute commands with error handling
async function executeSSHCommand(conn, command, timeout = 60000) {
    return new Promise((resolve, reject) => {
        // Set up timeout
        const timeoutId = setTimeout(() => {
            reject(new Error(`Command execution timed out after ${timeout}ms`));
        }, timeout);
        conn.exec(command, {}, (err, stream) => {
            if (err) {
                clearTimeout(timeoutId);
                return reject(new Error(`Failed to execute command: ${err.message}`));
            }
            let stdout = '';
            let stderr = '';
            stream.on('close', (code, signal) => {
                clearTimeout(timeoutId);
                resolve({
                    code,
                    signal,
                    stdout: stdout.trim(),
                    stderr: stderr.trim()
                });
            });
            stream.on('data', (data) => {
                stdout += data.toString();
            });
            stream.stderr.on('data', (data) => {
                stderr += data.toString();
            });
        });
    });
}
// Helper function to check if a connection exists
function getConnection(connections, connectionId) {
    if (!connections.has(connectionId)) {
        throw new Error(`No active SSH connection with ID: ${connectionId}`);
    }
    return connections.get(connectionId).conn;
}
// Global connection map (will be populated by the main module)
let connectionMap;
// Tool handlers for Ubuntu-specific operations
export const ubuntuToolHandlers = {
    // 1. Web Server Control (Nginx)
    async ubuntu_nginx_control(params) {
        const { connectionId, action, sudo = true } = params;
        try {
            const conn = getConnection(connectionMap, connectionId);
            // Validate action
            const validActions = ['start', 'stop', 'restart', 'status', 'reload', 'check-config'];
            if (!validActions.includes(action)) {
                throw new Error(`Invalid action: ${action}. Valid actions are: ${validActions.join(', ')}`);
            }
            let command = '';
            const sudoPrefix = sudo ? 'sudo ' : '';
            switch (action) {
                case 'start':
                case 'stop':
                case 'restart':
                case 'status':
                case 'reload':
                    command = `${sudoPrefix}systemctl ${action} nginx`;
                    break;
                case 'check-config':
                    command = `${sudoPrefix}nginx -t`;
                    break;
            }
            const result = await executeSSHCommand(conn, command);
            let status = result.code === 0 ? 'success' : 'error';
            let message = result.stdout || result.stderr;
            if (action === 'status') {
                const isActive = message.includes('Active: active');
                status = isActive ? 'active' : 'inactive';
            }
            return {
                content: [{ type: 'text', text: `Nginx ${action} result: ${status}\n\n${message}` }]
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Nginx control error: ${error.message}` }],
                isError: true
            };
        }
    },
    // 2. System Package Updates
    async ubuntu_update_packages(params) {
        const { connectionId, securityOnly = false, upgrade = true, autoremove = false, sudo = true } = params;
        try {
            const conn = getConnection(connectionMap, connectionId);
            const sudoPrefix = sudo ? 'sudo ' : '';
            let commands = [];
            if (securityOnly) {
                commands.push(`${sudoPrefix}apt-get update -o Dir::Etc::SourceList=/etc/apt/security.sources.list`);
            }
            else {
                commands.push(`${sudoPrefix}apt-get update`);
            }
            if (upgrade) {
                if (securityOnly) {
                    commands.push(`${sudoPrefix}apt-get upgrade -s | grep "^Inst" | grep -i security | awk '{print $2}' | xargs ${sudoPrefix}apt-get install -y`);
                }
                else {
                    commands.push(`${sudoPrefix}apt-get upgrade -y`);
                }
            }
            if (autoremove) {
                commands.push(`${sudoPrefix}apt-get autoremove -y`);
            }
            let output = '';
            for (const cmd of commands) {
                const result = await executeSSHCommand(conn, cmd, 300000);
                output += `Command: ${cmd}\nExit code: ${result.code}\nOutput:\n${result.stdout || result.stderr}\n\n`;
            }
            return {
                content: [{ type: 'text', text: `Package update completed.\n\n${output}` }]
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Package update error: ${error.message}` }],
                isError: true
            };
        }
    },
    // 3. SSL Certificate Management
    async ubuntu_ssl_certificate(params) {
        const { connectionId, action, domain, email, webroot = '/var/www/html', sudo = true } = params;
        try {
            const conn = getConnection(connectionMap, connectionId);
            const sudoPrefix = sudo ? 'sudo ' : '';
            const validActions = ['issue', 'renew', 'status', 'list'];
            if (!validActions.includes(action)) {
                throw new Error(`Invalid action: ${action}. Valid actions are: ${validActions.join(', ')}`);
            }
            if ((action === 'issue' || action === 'renew') && !domain) {
                throw new Error(`Domain name is required for ${action} action`);
            }
            if (action === 'issue' && !email) {
                throw new Error('Email address is required for issue action');
            }
            const checkCertbot = await executeSSHCommand(conn, 'which certbot || echo "not-found"');
            if (checkCertbot.stdout === 'not-found') {
                const installCertbot = await executeSSHCommand(conn, `${sudoPrefix}apt-get update && ${sudoPrefix}apt-get install -y certbot python3-certbot-nginx`);
                if (installCertbot.code !== 0) {
                    throw new Error(`Failed to install certbot: ${installCertbot.stderr}`);
                }
            }
            let command = '';
            switch (action) {
                case 'issue':
                    command = `${sudoPrefix}certbot certonly --webroot -w ${webroot} -d ${domain} --email ${email} --agree-tos --non-interactive`;
                    break;
                case 'renew':
                    command = domain ? `${sudoPrefix}certbot renew --cert-name ${domain} --force-renewal` : `${sudoPrefix}certbot renew`;
                    break;
                case 'status':
                    command = domain ? `${sudoPrefix}certbot certificates -d ${domain}` : `${sudoPrefix}certbot certificates`;
                    break;
                case 'list':
                    command = `${sudoPrefix}certbot certificates`;
                    break;
            }
            const result = await executeSSHCommand(conn, command);
            return {
                content: [{ type: 'text', text: `SSL certificate ${action} result:\n\n${result.stdout || result.stderr}` }]
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `SSL certificate error: ${error.message}` }],
                isError: true
            };
        }
    },
    // 4. Website Deployment & Backup
    async ubuntu_website_deployment(params) {
        const { connectionId, action, localPath, remotePath = '/var/www/html', backupPath = '/var/backups/websites', createBackup = true, sudo = true } = params;
        try {
            const conn = getConnection(connectionMap, connectionId);
            const sudoPrefix = sudo ? 'sudo ' : '';
            const validActions = ['deploy', 'backup', 'restore'];
            if (!validActions.includes(action)) {
                throw new Error(`Invalid action: ${action}. Valid actions are: ${validActions.join(', ')}`);
            }
            await executeSSHCommand(conn, `${sudoPrefix}mkdir -p ${backupPath}`);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupFileName = `website-backup-${timestamp}.tar.gz`;
            const fullBackupPath = `${backupPath}/${backupFileName}`;
            let output = '';
            if (action === 'deploy') {
                if (!localPath) {
                    throw new Error('Local path is required for deployment');
                }
                if (createBackup) {
                    const backupCmd = `${sudoPrefix}tar -czf ${fullBackupPath} -C ${path.dirname(remotePath)} ${path.basename(remotePath)}`;
                    const backupResult = await executeSSHCommand(conn, backupCmd);
                    output += `Backup created: ${fullBackupPath}\n`;
                    if (backupResult.code !== 0) {
                        output += `Warning: Backup may have issues: ${backupResult.stderr}\n`;
                    }
                }
                const expandedLocalPath = localPath.replace(/^~/, os.homedir());
                if (!fs.existsSync(expandedLocalPath)) {
                    throw new Error(`Local path does not exist: ${expandedLocalPath}`);
                }
                const sftp = await new Promise((resolve, reject) => {
                    conn.sftp((err, sftp) => {
                        if (err) {
                            reject(new Error(`Failed to initialize SFTP: ${err.message}`));
                        }
                        else {
                            resolve(sftp);
                        }
                    });
                });
                const stats = fs.statSync(expandedLocalPath);
                if (stats.isDirectory()) {
                    const tempZipFile = path.join(os.tmpdir(), `deployment-${timestamp}.zip`);
                    await executeSSHCommand(conn, `zip -r ${tempZipFile} ${expandedLocalPath}`);
                    await new Promise((resolve, reject) => {
                        sftp.fastPut(tempZipFile, `/tmp/deployment-${timestamp}.zip`, (err) => {
                            if (err) {
                                reject(new Error(`Failed to upload deployment file: ${err.message}`));
                            }
                            else {
                                resolve(true);
                            }
                        });
                    });
                    await executeSSHCommand(conn, `${sudoPrefix}unzip -o /tmp/deployment-${timestamp}.zip -d ${remotePath}`);
                    fs.unlinkSync(tempZipFile);
                    await executeSSHCommand(conn, `${sudoPrefix}rm /tmp/deployment-${timestamp}.zip`);
                    output += `Deployed directory ${expandedLocalPath} to ${remotePath}`;
                }
                else {
                    const remoteFilePath = path.join(remotePath, path.basename(expandedLocalPath));
                    await new Promise((resolve, reject) => {
                        sftp.fastPut(expandedLocalPath, remoteFilePath, (err) => {
                            if (err) {
                                reject(new Error(`Failed to upload file: ${err.message}`));
                            }
                            else {
                                resolve(true);
                            }
                        });
                    });
                    await executeSSHCommand(conn, `${sudoPrefix}chown www-data:www-data ${remoteFilePath}`);
                    output += `Deployed file ${expandedLocalPath} to ${remoteFilePath}`;
                }
            }
            else if (action === 'backup') {
                const backupCmd = `${sudoPrefix}tar -czf ${fullBackupPath} -C ${path.dirname(remotePath)} ${path.basename(remotePath)}`;
                const backupResult = await executeSSHCommand(conn, backupCmd);
                if (backupResult.code === 0) {
                    output += `Backup created: ${fullBackupPath}`;
                }
                else {
                    throw new Error(`Backup failed: ${backupResult.stderr}`);
                }
            }
            else if (action === 'restore') {
                const listResult = await executeSSHCommand(conn, `ls -la ${backupPath}`);
                if (!localPath) {
                    return {
                        content: [{ type: 'text', text: `Available backups:\n\n${listResult.stdout}` }]
                    };
                }
                const restoreCmd = `${sudoPrefix}tar -xzf ${localPath} -C ${path.dirname(remotePath)}`;
                const restoreResult = await executeSSHCommand(conn, restoreCmd);
                if (restoreResult.code === 0) {
                    output += `Restored from backup: ${localPath} to ${remotePath}`;
                }
                else {
                    throw new Error(`Restore failed: ${restoreResult.stderr}`);
                }
            }
            return {
                content: [{ type: 'text', text: output }]
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Website deployment error: ${error.message}` }],
                isError: true
            };
        }
    },
    // 5. Firewall (UFW) Management
    async ubuntu_ufw_firewall(params) {
        const { connectionId, action, port, protocol, from, sudo = true } = params;
        try {
            const conn = getConnection(connectionMap, connectionId);
            const sudoPrefix = sudo ? 'sudo ' : '';
            const validActions = ['enable', 'disable', 'status', 'allow', 'deny', 'delete', 'reset'];
            if (!validActions.includes(action)) {
                throw new Error(`Invalid action: ${action}. Valid actions are: ${validActions.join(', ')}`);
            }
            const checkUfw = await executeSSHCommand(conn, 'which ufw || echo "not-found"');
            if (checkUfw.stdout === 'not-found') {
                const installUfw = await executeSSHCommand(conn, `${sudoPrefix}apt-get update && ${sudoPrefix}apt-get install -y ufw`);
                if (installUfw.code !== 0) {
                    throw new Error(`Failed to install ufw: ${installUfw.stderr}`);
                }
            }
            let command = '';
            switch (action) {
                case 'enable':
                    command = `${sudoPrefix}ufw --force enable`;
                    break;
                case 'disable':
                    command = `${sudoPrefix}ufw disable`;
                    break;
                case 'status':
                    command = `${sudoPrefix}ufw status verbose`;
                    break;
                case 'reset':
                    command = `${sudoPrefix}ufw --force reset`;
                    break;
                case 'allow':
                case 'deny':
                    if (!port) {
                        throw new Error('Port or service name is required for allow/deny actions');
                    }
                    let ruleCommand = `${sudoPrefix}ufw ${action} `;
                    if (protocol) {
                        ruleCommand += `${port}/${protocol} `;
                    }
                    else {
                        ruleCommand += `${port} `;
                    }
                    if (from) {
                        ruleCommand += `from ${from}`;
                    }
                    command = ruleCommand;
                    break;
                case 'delete':
                    if (!port) {
                        throw new Error('Port or service name is required for delete action');
                    }
                    let deleteCommand = `${sudoPrefix}ufw delete allow `;
                    if (protocol) {
                        deleteCommand += `${port}/${protocol}`;
                    }
                    else {
                        deleteCommand += port;
                    }
                    command = deleteCommand;
                    break;
            }
            const result = await executeSSHCommand(conn, command);
            return {
                content: [{ type: 'text', text: `Firewall ${action} result:\n\n${result.stdout || result.stderr}` }]
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Firewall error: ${error.message}` }],
                isError: true
            };
        }
    }
};
/**
 * Add Ubuntu website management tools to the MCP SSH server
 */
export function addUbuntuTools(server, connections) {
    connectionMap = connections;
    server.tool('ubuntu_nginx_control', 'Control Nginx web server on Ubuntu', {
        connectionId: z.string().describe('ID of an active SSH connection'),
        action: z.enum(['start', 'stop', 'restart', 'status', 'reload', 'check-config']).describe('Action to perform'),
        sudo: z.boolean().optional().default(true).describe('Whether to run the command with sudo (default: true)')
    }, async (args) => ubuntuToolHandlers.ubuntu_nginx_control(args));
    server.tool('ubuntu_update_packages', 'Update system packages on Ubuntu', {
        connectionId: z.string().describe('ID of an active SSH connection'),
        securityOnly: z.boolean().optional().default(false).describe('Whether to update only security packages (default: false)'),
        upgrade: z.boolean().optional().default(true).describe('Whether to upgrade packages after update (default: true)'),
        autoremove: z.boolean().optional().default(false).describe('Whether to remove unused packages after update (default: false)'),
        sudo: z.boolean().optional().default(true).describe('Whether to run the command with sudo (default: true)')
    }, async (args) => ubuntuToolHandlers.ubuntu_update_packages(args));
    server.tool('ubuntu_ssl_certificate', 'Manage SSL certificates using Let\'s Encrypt on Ubuntu', {
        connectionId: z.string().describe('ID of an active SSH connection'),
        action: z.enum(['issue', 'renew', 'status', 'list']).describe('Action to perform'),
        domain: z.string().optional().describe('Domain name for the certificate (required for issue and renew)'),
        email: z.string().optional().describe('Email address for Let\'s Encrypt notifications (required for issue)'),
        webroot: z.string().optional().default('/var/www/html').describe('Web root path for domain verification (default: /var/www/html)'),
        sudo: z.boolean().optional().default(true).describe('Whether to run the command with sudo (default: true)')
    }, async (args) => ubuntuToolHandlers.ubuntu_ssl_certificate(args));
    server.tool('ubuntu_website_deployment', 'Deploy website files and create backups on Ubuntu', {
        connectionId: z.string().describe('ID of an active SSH connection'),
        action: z.enum(['deploy', 'backup', 'restore']).describe('Action to perform'),
        localPath: z.string().optional().describe('Local path to the website files for deployment or backup restoration'),
        remotePath: z.string().optional().default('/var/www/html').describe('Remote path where the website is located (default: /var/www/html)'),
        backupPath: z.string().optional().default('/var/backups/websites').describe('Path to store backups (default: /var/backups/websites)'),
        createBackup: z.boolean().optional().default(true).describe('Whether to create a backup before deployment (default: true)'),
        sudo: z.boolean().optional().default(true).describe('Whether to run the command with sudo (default: true)')
    }, async (args) => ubuntuToolHandlers.ubuntu_website_deployment(args));
    server.tool('ubuntu_ufw_firewall', 'Manage Ubuntu Uncomplicated Firewall (UFW)', {
        connectionId: z.string().describe('ID of an active SSH connection'),
        action: z.enum(['enable', 'disable', 'status', 'allow', 'deny', 'delete', 'reset']).describe('Action to perform'),
        port: z.string().optional().describe('Port number or service name (e.g., 80, 443, ssh, http)'),
        protocol: z.enum(['tcp', 'udp']).optional().describe('Protocol (tcp, udp)'),
        from: z.string().optional().describe('Source IP address or network'),
        sudo: z.boolean().optional().default(true).describe('Whether to run the command with sudo (default: true)')
    }, async (args) => ubuntuToolHandlers.ubuntu_ufw_firewall(args));
    console.error("Ubuntu website management tools loaded");
}
//# sourceMappingURL=ubuntu-website-tools.js.map