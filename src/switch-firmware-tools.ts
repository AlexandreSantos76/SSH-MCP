/**
 * Switch Firmware Management Tools for MCP SSH Server
 * 
 * Tools for managing firmware updates on Cisco and Aruba network switches.
 * Includes firmware upload, verification, and installation capabilities.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Client } from "ssh2";
import * as fs from "fs";
import * as path from "path";

// Helper function to check if a connection exists
function getConnection(connections: Map<string, { conn: Client; config: any }>, connectionId: string) {
  if (!connections.has(connectionId)) {
    throw new Error(`No active SSH connection with ID: ${connectionId}`);
  }
  return connections.get(connectionId)!.conn;
}

// Utility function to execute commands with device-specific handling
async function executeSSHCommand(
  conn: Client,
  command: string,
  timeout = 30000
): Promise<{
  code: number;
  signal: string;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Command execution timed out after ${timeout}ms`));
    }, timeout);

    conn.exec(command, {}, (err: Error | undefined, stream: any) => {
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
}

// Global connection map (will be populated by the main module)
let connectionMap: Map<string, { conn: Client; config: any }>;

// Tool handlers for firmware management operations
type ToolHandler = (params: any) => Promise<any>;

export const firmwareToolHandlers: Record<string, ToolHandler> = {
  // 1. Check Current Firmware Version
  async switch_check_firmware(params) {
    const { connectionId, enablePassword } = params;

    try {
      const conn = getConnection(connectionMap, connectionId);

      // Get device version information
      const versionResult = await executeSSHCommand(conn, 'show version');

      // Parse firmware information based on device type
      let firmwareInfo = {
        currentVersion: 'Unknown',
        bootVersion: 'Unknown',
        model: 'Unknown',
        serialNumber: 'Unknown',
        uptime: 'Unknown'
      };

      const output = versionResult.stdout.toLowerCase();

      if (output.includes('cisco')) {
        // Parse Cisco firmware info
        const versionMatch = output.match(/version\s+([^\s,]+)/);
        const modelMatch = output.match(/cisco\s+([^\s]+)/);
        const serialMatch = output.match(/processor board id\s+([^\s]+)/);
        const uptimeMatch = output.match(/uptime is\s+([^\n]+)/);

        if (versionMatch) firmwareInfo.currentVersion = versionMatch[1];
        if (modelMatch) firmwareInfo.model = modelMatch[1];
        if (serialMatch) firmwareInfo.serialNumber = serialMatch[1];
        if (uptimeMatch) firmwareInfo.uptime = uptimeMatch[1];
      } else if (output.includes('aruba') || output.includes('procurve')) {
        // Parse Aruba firmware info
        const versionMatch = output.match(/software revision\s+([^\s]+)/);
        const modelMatch = output.match(/([^\s]+)\s+switch/);

        if (versionMatch) firmwareInfo.currentVersion = versionMatch[1];
        if (modelMatch) firmwareInfo.model = modelMatch[1];
      }

      return {
        content: [{
          type: 'text',
          text: `Current Firmware Information:\n\n${JSON.stringify(firmwareInfo, null, 2)}\n\nFull Version Output:\n${versionResult.stdout}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Firmware check error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 2. Check Available Storage Space
  async switch_check_storage(params) {
    const { connectionId, enablePassword } = params;

    try {
      const conn = getConnection(connectionMap, connectionId);

      // Try different commands based on device type
      const commands = [
        'show flash:',
        'dir flash:',
        'show file systems',
        'dir'
      ];

      let storageInfo = '';

      for (const cmd of commands) {
        try {
          const result = await executeSSHCommand(conn, cmd, 15000);
          if (result.code === 0 && result.stdout) {
            storageInfo += `Command: ${cmd}\n${result.stdout}\n\n`;
          }
        } catch (error) {
          // Continue with next command
        }
      }

      return {
        content: [{
          type: 'text',
          text: `Storage Information:\n\n${storageInfo || 'Unable to retrieve storage information'}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Storage check error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 3. Upload Firmware File
  async switch_upload_firmware(params) {
    const { connectionId, localFirmwarePath, remotePath, enablePassword } = params;

    try {
      const conn = getConnection(connectionMap, connectionId);

      // Check if local firmware file exists
      if (!fs.existsSync(localFirmwarePath)) {
        throw new Error(`Firmware file not found: ${localFirmwarePath}`);
      }

      // Get file size for progress tracking
      const stats = fs.statSync(localFirmwarePath);
      const fileSize = stats.size;
      const fileName = path.basename(localFirmwarePath);

      // Default remote path if not specified
      const targetPath = remotePath || `flash:/${fileName}`;

      // Get SFTP client for file upload
      const sftp: any = await new Promise((resolve, reject) => {
        conn.sftp((err: Error | undefined, sftp: any) => {
          if (err) {
            reject(new Error(`Failed to initialize SFTP: ${err.message}`));
          } else {
            resolve(sftp);
          }
        });
      });

      // Upload the firmware file
      await new Promise((resolve, reject) => {
        const uploadTimeout = setTimeout(() => {
          reject(new Error('Firmware upload timed out (30 minutes)'));
        }, 30 * 60 * 1000); // 30 minute timeout for large firmware files

        sftp.fastPut(localFirmwarePath, targetPath, (err: Error | undefined) => {
          clearTimeout(uploadTimeout);
          if (err) {
            reject(new Error(`Failed to upload firmware: ${err.message}`));
          } else {
            resolve(true);
          }
        });
      });

      // Verify the uploaded file
      const verifyResult = await executeSSHCommand(conn, `dir ${targetPath}`);

      return {
        content: [{
          type: 'text',
          text: `Firmware Upload Complete:\n\nLocal File: ${localFirmwarePath}\nRemote Path: ${targetPath}\nFile Size: ${(fileSize / 1024 / 1024).toFixed(2)} MB\n\nVerification:\n${verifyResult.stdout}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Firmware upload error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 4. Verify Firmware Integrity
  async switch_verify_firmware(params) {
    const { connectionId, firmwarePath, enablePassword } = params;

    try {
      const conn = getConnection(connectionMap, connectionId);

      // Try different verification commands
      const verifyCommands = [
        `verify ${firmwarePath}`,
        `verify /md5 ${firmwarePath}`,
        `show file information ${firmwarePath}`
      ];

      let verificationResults = '';

      for (const cmd of verifyCommands) {
        try {
          const result = await executeSSHCommand(conn, cmd, 120000); // 2 minute timeout
          verificationResults += `Command: ${cmd}\nResult: ${result.stdout}\n\n`;
        } catch (error) {
          verificationResults += `Command: ${cmd}\nError: ${(error as Error).message}\n\n`;
        }
      }

      return {
        content: [{
          type: 'text',
          text: `Firmware Verification Results:\n\n${verificationResults}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Firmware verification error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 5. Install Firmware (Prepare for Reboot)
  async switch_install_firmware(params) {
    const { connectionId, firmwarePath, enablePassword, autoReboot = false } = params;

    try {
      const conn = getConnection(connectionMap, connectionId);

      // Get current version for backup reference
      const currentVersion = await executeSSHCommand(conn, 'show version');

      // Prepare installation commands based on device type
      let installCommands = [];

      // Try to detect device type from version output
      const versionOutput = currentVersion.stdout.toLowerCase();

      if (versionOutput.includes('cisco')) {
        // Cisco installation commands
        installCommands = [
          `boot system flash:${path.basename(firmwarePath)}`,
          'copy running-config startup-config'
        ];

        if (autoReboot) {
          installCommands.push('reload');
        }
      } else if (versionOutput.includes('aruba') || versionOutput.includes('procurve')) {
        // Aruba installation commands
        installCommands = [
          `boot set-default flash:${path.basename(firmwarePath)}`,
          'write memory'
        ];

        if (autoReboot) {
          installCommands.push('reload');
        }
      } else {
        // Generic approach
        installCommands = [
          `boot system ${firmwarePath}`,
          'copy running-config startup-config'
        ];
      }

      let installResults = '';

      // Execute installation commands
      for (const cmd of installCommands) {
        try {
          if (cmd === 'reload' && !autoReboot) {
            installResults += `Command prepared (not executed): ${cmd}\n`;
            continue;
          }

          const result = await executeSSHCommand(conn, cmd, 60000);
          installResults += `Command: ${cmd}\nResult: ${result.stdout}\nExit Code: ${result.code}\n\n`;

          // If this is a reload command, we expect the connection to drop
          if (cmd === 'reload') {
            installResults += 'Device is rebooting with new firmware...\n';
            break;
          }
        } catch (error) {
          installResults += `Command: ${cmd}\nError: ${(error as Error).message}\n\n`;
        }
      }

      const rebootMessage = autoReboot ?
        '\n⚠️  Device is rebooting with new firmware. Connection will be lost.' :
        '\n⚠️  Firmware is staged for installation. Use "reload" command to complete the upgrade.';

      return {
        content: [{
          type: 'text',
          text: `Firmware Installation Results:\n\n${installResults}${rebootMessage}\n\nCurrent Version (for reference):\n${currentVersion.stdout.substring(0, 500)}...`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Firmware installation error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 6. Firmware Rollback Preparation
  async switch_prepare_rollback(params) {
    const { connectionId, enablePassword } = params;

    try {
      const conn = getConnection(connectionMap, connectionId);

      // Get current boot configuration
      const bootConfigResult = await executeSSHCommand(conn, 'show boot');

      // Get available firmware images
      const flashResult = await executeSSHCommand(conn, 'dir flash:');

      // Prepare rollback information
      const rollbackInfo = {
        currentBootConfig: bootConfigResult.stdout,
        availableImages: flashResult.stdout,
        rollbackInstructions: [
          '1. Identify the previous firmware version from available images',
          '2. Use switch_install_firmware with the previous firmware path',
          '3. Reboot the device to complete rollback',
          '4. Verify the rollback was successful'
        ]
      };

      return {
        content: [{
          type: 'text',
          text: `Firmware Rollback Preparation:\n\n${JSON.stringify(rollbackInfo, null, 2)}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Rollback preparation error: ${error.message}` }],
        isError: true
      };
    }
  }
};

/**
 * Add firmware management tools to the MCP SSH server
 */
export function addFirmwareTools(server: McpServer, connections: Map<string, { conn: Client; config: any }>) {
  // Store connection map for tool handlers to use
  connectionMap = connections;

  console.error("Switch firmware management tools loaded");

  server.tool(
    'switch_check_firmware',
    'Check current firmware version and system information',
    {
      connectionId: z.string().describe('ID of an active SSH connection'),
      enablePassword: z.string().optional().describe('Enable password for privileged mode (if required)')
    },
    async (args) => firmwareToolHandlers.switch_check_firmware(args)
  );

  server.tool(
    'switch_check_storage',
    'Check available storage space for firmware uploads',
    {
      connectionId: z.string().describe('ID of an active SSH connection'),
      enablePassword: z.string().optional().describe('Enable password for privileged mode (if required)')
    },
    async (args) => firmwareToolHandlers.switch_check_storage(args)
  );

  server.tool(
    'switch_upload_firmware',
    'Upload firmware file to network switch',
    {
      connectionId: z.string().describe('ID of an active SSH connection'),
      localFirmwarePath: z.string().describe('Local path to firmware file'),
      remotePath: z.string().optional().describe('Remote path where firmware should be stored (optional)'),
      enablePassword: z.string().optional().describe('Enable password for privileged mode (if required)')
    },
    async (args) => firmwareToolHandlers.switch_upload_firmware(args)
  );

  server.tool(
    'switch_verify_firmware',
    'Verify firmware file integrity on switch',
    {
      connectionId: z.string().describe('ID of an active SSH connection'),
      firmwarePath: z.string().describe('Path to firmware file on switch'),
      enablePassword: z.string().optional().describe('Enable password for privileged mode (if required)')
    },
    async (args) => firmwareToolHandlers.switch_verify_firmware(args)
  );

  server.tool(
    'switch_install_firmware',
    'Install firmware on switch (prepare for reboot)',
    {
      connectionId: z.string().describe('ID of an active SSH connection'),
      firmwarePath: z.string().describe('Path to firmware file on switch'),
      enablePassword: z.string().optional().describe('Enable password for privileged mode (if required)'),
      autoReboot: z.boolean().optional().describe('Automatically reboot after installation (default: false)')
    },
    async (args) => firmwareToolHandlers.switch_install_firmware(args)
  );

  server.tool(
    'switch_prepare_rollback',
    'Prepare information for firmware rollback',
    {
      connectionId: z.string().describe('ID of an active SSH connection'),
      enablePassword: z.string().optional().describe('Enable password for privileged mode (if required)')
    },
    async (args) => firmwareToolHandlers.switch_prepare_rollback(args)
  );
}
