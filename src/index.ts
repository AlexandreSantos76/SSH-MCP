#!/usr/bin/env node

/**
 * MCP SSH Server
 * 
 * A Model Context Protocol (MCP) server that provides SSH access to remote servers.
 * This allows AI tools like Claude or VS Code to securely connect to your VPS.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Client } from "ssh2";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as dotenv from "dotenv";
import { addUbuntuTools, ubuntuToolHandlers } from "./ubuntu-website-tools.js";

// Load environment variables from .env file if present
dotenv.config();

class SSHMCPServer {
  private server: McpServer;
  private connections: Map<string, { conn: Client; config: any }>;

  constructor() {
    this.connections = new Map();
    this.server = new McpServer(
      {
        name: "MCP SSH Server",
        version: "1.0.0"
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    this.setupHandlers();

    // Add Ubuntu website management tools
    addUbuntuTools(this.server, this.connections);
  }

  private setupHandlers() {
    // Register tool 'ssh_connect'
    this.server.tool(
      'ssh_connect',
      'Connect to a remote server via SSH',
      {
        host: z.string().describe('Hostname or IP address of the remote server'),
        port: z.number().optional().describe('SSH port (default: 22)'),
        username: z.string().describe('SSH username'),
        password: z.string().optional().describe('SSH password (if not using key-based authentication)'),
        privateKeyPath: z.string().optional().describe('Path to private key file (if using key-based authentication)'),
        passphrase: z.string().optional().describe('Passphrase for private key (if needed)'),
        connectionId: z.string().optional().describe('Unique identifier for this connection')
      },
      async (args) => this.handleSSHConnect(args)
    );

    // Register tool 'ssh_exec'
    this.server.tool(
      'ssh_exec',
      'Execute a command on the remote server',
      {
        connectionId: z.string().describe('ID of an active SSH connection'),
        command: z.string().describe('Command to execute'),
        cwd: z.string().optional().describe('Working directory for the command'),
        timeout: z.number().optional().describe('Command timeout in milliseconds')
      },
      async (args) => this.handleSSHExec(args)
    );

    // Register tool 'ssh_upload_file'
    this.server.tool(
      'ssh_upload_file',
      'Upload a file to the remote server',
      {
        connectionId: z.string().describe('ID of an active SSH connection'),
        localPath: z.string().describe('Path to the local file'),
        remotePath: z.string().describe('Path where the file should be saved on the remote server')
      },
      async (args) => this.handleSSHUpload(args)
    );

    // Register tool 'ssh_download_file'
    this.server.tool(
      'ssh_download_file',
      'Download a file from the remote server',
      {
        connectionId: z.string().describe('ID of an active SSH connection'),
        remotePath: z.string().describe('Path to the file on the remote server'),
        localPath: z.string().describe('Path where the file should be saved locally')
      },
      async (args) => this.handleSSHDownload(args)
    );

    // Register tool 'ssh_list_files'
    this.server.tool(
      'ssh_list_files',
      'List files in a directory on the remote server',
      {
        connectionId: z.string().describe('ID of an active SSH connection'),
        remotePath: z.string().describe('Path to the directory on the remote server')
      },
      async (args) => this.handleSSHListFiles(args)
    );

    // Register tool 'ssh_disconnect'
    this.server.tool(
      'ssh_disconnect',
      'Close an SSH connection',
      {
        connectionId: z.string().describe('ID of an active SSH connection')
      },
      async (args) => this.handleSSHDisconnect(args)
    );
  }

  private async handleSSHConnect(params: any): Promise<any> {
    const {
      host,
      port = 22,
      username,
      password,
      privateKeyPath,
      passphrase,
      connectionId = `ssh-${Date.now()}`
    } = params;

    // Verify we have either a password or a private key
    if (!password && !privateKeyPath) {
      return {
        content: [{ type: "text", text: "Either password or privateKeyPath must be provided" }],
        isError: true
      };
    }

    // Create SSH connection options
    const sshConfig: any = {
      host,
      port,
      username,
      readyTimeout: 30000, // 30 seconds timeout for connection
    };

    // Add authentication method
    if (privateKeyPath) {
      try {
        // Expand tilde if present in the path
        const expandedPath = privateKeyPath.replace(/^~/, os.homedir());
        sshConfig.privateKey = fs.readFileSync(expandedPath);

        if (passphrase) {
          sshConfig.passphrase = passphrase;
        }
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Failed to read private key: ${error.message}` }],
          isError: true
        };
      }
    } else if (password) {
      sshConfig.password = password;
    }

    // Create a new SSH client
    const conn = new Client();

    try {
      // Connect to the server and wait for the "ready" event
      await new Promise((resolve, reject) => {
        conn.on("ready", () => {
          resolve(true);
        });

        conn.on("error", (err: Error) => {
          reject(new Error(`SSH connection error: ${err.message}`));
        });

        conn.connect(sshConfig);
      });

      // Store the connection for future use
      this.connections.set(connectionId, { conn, config: { host, port, username } });

      return {
        content: [{
          type: "text",
          text: `Successfully connected to ${username}@${host}:${port}\nConnection ID: ${connectionId}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Failed to connect: ${error.message}` }],
        isError: true
      };
    }
  }

  private async handleSSHExec(params: any): Promise<any> {
    const { connectionId, command, cwd, timeout = 60000 } = params;

    // Check if the connection exists
    if (!this.connections.has(connectionId)) {
      return {
        content: [{ type: "text", text: `No active SSH connection with ID: ${connectionId}` }],
        isError: true
      };
    }

    const { conn } = this.connections.get(connectionId)!;

    // Execute the command
    try {
      const result: any = await new Promise((resolve, reject) => {
        const execOptions: any = {};
        if (cwd) execOptions.cwd = cwd;

        // Set up timeout
        const timeoutId = setTimeout(() => {
          reject(new Error(`Command execution timed out after ${timeout}ms`));
        }, timeout);

        conn.exec(command, execOptions, (err: Error | undefined, stream: any) => {
          if (err) {
            clearTimeout(timeoutId);
            return reject(new Error(`Failed to execute command: ${err.message}`));
          }

          let stdout = '';
          let stderr = '';

          stream.on('close', (code: number, signal: string) => {
            clearTimeout(timeoutId);
            resolve({
              code,
              signal,
              stdout: stdout.trim(),
              stderr: stderr.trim()
            });
          });

          stream.on('data', (data: Buffer) => {
            stdout += data.toString();
          });

          stream.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
          });
        });
      });

      const output = result.stdout || result.stderr || '(no output)';
      return {
        content: [{
          type: "text",
          text: `Command: ${command}\nExit code: ${result.code}\nOutput:\n${output}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Command execution failed: ${error.message}` }],
        isError: true
      };
    }
  }

  private async handleSSHUpload(params: any): Promise<any> {
    const { connectionId, localPath, remotePath } = params;

    // Check if the connection exists
    if (!this.connections.has(connectionId)) {
      return {
        content: [{ type: "text", text: `No active SSH connection with ID: ${connectionId}` }],
        isError: true
      };
    }

    const { conn } = this.connections.get(connectionId)!;

    try {
      // Expand tilde if present in the local path
      const expandedLocalPath = localPath.replace(/^~/, os.homedir());

      // Check if the local file exists
      if (!fs.existsSync(expandedLocalPath)) {
        return {
          content: [{ type: "text", text: `Local file does not exist: ${expandedLocalPath}` }],
          isError: true
        };
      }

      // Get SFTP client
      const sftp: any = await new Promise((resolve, reject) => {
        conn.sftp((err: Error | undefined, sftp: any) => {
          if (err) {
            reject(new Error(`Failed to initialize SFTP: ${err.message}`));
          } else {
            resolve(sftp);
          }
        });
      });

      // Upload the file
      await new Promise((resolve, reject) => {
        sftp.fastPut(expandedLocalPath, remotePath, (err: Error | undefined) => {
          if (err) {
            reject(new Error(`Failed to upload file: ${err.message}`));
          } else {
            resolve(true);
          }
        });
      });

      return {
        content: [{ type: "text", text: `Successfully uploaded ${expandedLocalPath} to ${remotePath}` }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `File upload failed: ${error.message}` }],
        isError: true
      };
    }
  }

  private async handleSSHDownload(params: any): Promise<any> {
    const { connectionId, remotePath, localPath } = params;

    // Check if the connection exists
    if (!this.connections.has(connectionId)) {
      return {
        content: [{ type: "text", text: `No active SSH connection with ID: ${connectionId}` }],
        isError: true
      };
    }

    const { conn } = this.connections.get(connectionId)!;

    try {
      // Expand tilde if present in the local path
      const expandedLocalPath = localPath.replace(/^~/, os.homedir());

      // Ensure the directory exists
      const dir = path.dirname(expandedLocalPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Get SFTP client
      const sftp: any = await new Promise((resolve, reject) => {
        conn.sftp((err: Error | undefined, sftp: any) => {
          if (err) {
            reject(new Error(`Failed to initialize SFTP: ${err.message}`));
          } else {
            resolve(sftp);
          }
        });
      });

      // Download the file
      await new Promise((resolve, reject) => {
        sftp.fastGet(remotePath, expandedLocalPath, (err: Error | undefined) => {
          if (err) {
            reject(new Error(`Failed to download file: ${err.message}`));
          } else {
            resolve(true);
          }
        });
      });

      return {
        content: [{ type: "text", text: `Successfully downloaded ${remotePath} to ${expandedLocalPath}` }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `File download failed: ${error.message}` }],
        isError: true
      };
    }
  }

  private async handleSSHListFiles(params: any): Promise<any> {
    const { connectionId, remotePath } = params;

    // Check if the connection exists
    if (!this.connections.has(connectionId)) {
      return {
        content: [{ type: "text", text: `No active SSH connection with ID: ${connectionId}` }],
        isError: true
      };
    }

    const { conn } = this.connections.get(connectionId)!;

    try {
      // Get SFTP client
      const sftp: any = await new Promise((resolve, reject) => {
        conn.sftp((err: Error | undefined, sftp: any) => {
          if (err) {
            reject(new Error(`Failed to initialize SFTP: ${err.message}`));
          } else {
            resolve(sftp);
          }
        });
      });

      // List files
      const files: any = await new Promise((resolve, reject) => {
        sftp.readdir(remotePath, (err: Error | undefined, list: any[]) => {
          if (err) {
            reject(new Error(`Failed to list files: ${err.message}`));
          } else {
            resolve(list);
          }
        });
      });

      const fileList = files.map((file: any) => ({
        filename: file.filename,
        isDirectory: (file.attrs.mode & 16384) === 16384,
        size: file.attrs.size,
        lastModified: new Date(file.attrs.mtime * 1000).toISOString()
      }));

      return {
        content: [{
          type: "text",
          text: `Files in ${remotePath}:\n\n${JSON.stringify(fileList, null, 2)}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Failed to list files: ${error.message}` }],
        isError: true
      };
    }
  }

  private async handleSSHDisconnect(params: any): Promise<any> {
    const { connectionId } = params;

    // Check if the connection exists
    if (!this.connections.has(connectionId)) {
      return {
        content: [{ type: "text", text: `No active SSH connection with ID: ${connectionId}` }],
        isError: true
      };
    }

    const { conn, config } = this.connections.get(connectionId)!;

    try {
      // Close the connection
      conn.end();
      this.connections.delete(connectionId);

      return {
        content: [{ type: "text", text: `Disconnected from ${config.username}@${config.host}:${config.port}` }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Failed to disconnect: ${error.message}` }],
        isError: true
      };
    }
  }

  async start() {
    try {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);

      console.error("MCP SSH Server started. Waiting for requests...");

      // Handle graceful shutdown
      process.on('SIGINT', () => {
        console.error("Shutting down MCP SSH Server...");

        // Close all active connections
        for (const [connectionId, { conn }] of this.connections.entries()) {
          try {
            conn.end();
          } catch (error: any) {
            console.error(`Failed to close connection ${connectionId}:`, error);
          }
        }

        process.exit(0);
      });
    } catch (error: any) {
      console.error("Failed to start MCP SSH Server:", error);
      process.exit(1);
    }
  }
}

// Start the server
const server = new SSHMCPServer();
server.start().catch(console.error);
