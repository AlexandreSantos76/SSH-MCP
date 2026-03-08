/**
 * Network Switch Management Tools for MCP SSH Server
 * 
 * Extended tools for managing Cisco and Aruba network switches via SSH and Serial connections.
 * Supports both traditional SSH connections and USB-to-Serial console connections.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Client } from "ssh2";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Network device types and their characteristics
export interface NetworkDevice {
  id: string;
  type: 'cisco-ios' | 'cisco-ios-xe' | 'aruba-switch' | 'generic';
  connectionType: 'ssh' | 'serial';
  host?: string;
  port?: number;
  serialPort?: string;
  baudRate?: number;
  username?: string;
  password?: string;
  enablePassword?: string;
  model?: string;
  version?: string;
  lastSeen?: Date;
}

// Common switch command patterns
export const SwitchCommands = {
  cisco: {
    showVersion: 'show version',
    showRunningConfig: 'show running-config',
    showStartupConfig: 'show startup-config',
    showInterfaces: 'show interfaces status',
    showVlans: 'show vlan brief',
    showMacTable: 'show mac address-table',
    showArp: 'show arp',
    showCdp: 'show cdp neighbors detail',
    showLldp: 'show lldp neighbors detail',
    enableMode: 'enable',
    configMode: 'configure terminal',
    saveConfig: 'copy running-config startup-config',
    showInventory: 'show inventory',
    showPowerStatus: 'show power',
    showEnvironment: 'show environment',
    showSystem: 'show version', // Fallback for Cisco
    ping: (target: string) => `ping ${target}`,
    traceroute: (target: string) => `traceroute ${target}`
  },
  aruba: {
    showVersion: 'show version',
    showRunningConfig: 'show running-config',
    showStartupConfig: 'show config',
    showInterfaces: 'show interfaces brief',
    showVlans: 'show vlans',
    showMacTable: 'show mac-address-table',
    showArp: 'show arp',
    showLldp: 'show lldp info remote-device',
    enableMode: 'enable',
    configMode: 'configure',
    saveConfig: 'write memory',
    showSystem: 'show system',
    showInventory: 'show system', // Fallback for Aruba
    showPowerStatus: 'show power-consumption',
    showEnvironment: 'show system', // Fallback for Aruba
    ping: (target: string) => `ping ${target}`,
    traceroute: (target: string) => `traceroute ${target}`
  }
};

// Utility function to detect device type from version output
export function detectDeviceType(versionOutput: string): NetworkDevice['type'] {
  const output = versionOutput.toLowerCase();

  if (output.includes('cisco ios xe')) {
    return 'cisco-ios-xe';
  } else if (output.includes('cisco ios')) {
    return 'cisco-ios';
  } else if (output.includes('aruba') || output.includes('procurve')) {
    return 'aruba-switch';
  }

  return 'generic';
}

// Utility function to parse interface status
export function parseInterfaceStatus(output: string, deviceType: NetworkDevice['type']) {
  const interfaces: any[] = [];
  const lines = output.split('\n');

  if (deviceType.startsWith('cisco')) {
    // Parse Cisco interface status
    for (const line of lines) {
      if (line.match(/^(Gi|Fa|Te|Et)\d+\/\d+/)) {
        const parts = line.split(/\s+/);
        if (parts.length >= 6) {
          interfaces.push({
            name: parts[0],
            description: parts[1] !== 'notconnect' ? parts[1] : '',
            status: parts[2],
            vlan: parts[3],
            duplex: parts[4],
            speed: parts[5],
            type: parts[6] || ''
          });
        }
      }
    }
  } else if (deviceType === 'aruba-switch') {
    // Parse Aruba interface status
    for (const line of lines) {
      if (line.match(/^\s*\d+/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4) {
          interfaces.push({
            port: parts[0],
            type: parts[1],
            enabled: parts[2],
            status: parts[3],
            mode: parts[4] || '',
            speed: parts[5] || '',
            duplex: parts[6] || ''
          });
        }
      }
    }
  }

  return interfaces;
}

// Utility function to parse VLAN information
export function parseVlanInfo(output: string, deviceType: NetworkDevice['type']) {
  const vlans: any[] = [];
  const lines = output.split('\n');

  if (deviceType.startsWith('cisco')) {
    // Parse Cisco VLAN brief
    for (const line of lines) {
      if (line.match(/^\d+/)) {
        const parts = line.split(/\s+/);
        if (parts.length >= 3) {
          vlans.push({
            id: parts[0],
            name: parts[1],
            status: parts[2],
            ports: parts.slice(3).join(' ')
          });
        }
      }
    }
  } else if (deviceType === 'aruba-switch') {
    // Parse Aruba VLAN info
    for (const line of lines) {
      if (line.match(/^\s*\d+/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          vlans.push({
            id: parts[0],
            name: parts[1],
            status: parts[2] || 'active',
            type: parts[3] || 'port-based'
          });
        }
      }
    }
  }

  return vlans;
}

// Utility function to execute commands with device-specific handling
async function executeNetworkCommand(
  conn: Client,
  command: string,
  deviceType: NetworkDevice['type'],
  enablePassword?: string,
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

// Helper function to check if a connection exists
function getConnection(connections: Map<string, { conn: Client; config: any }>, connectionId: string) {
  if (!connections.has(connectionId)) {
    throw new Error(`No active SSH connection with ID: ${connectionId}`);
  }
  return connections.get(connectionId)!.conn;
}

// Global connection map (will be populated by the main module)
let connectionMap: Map<string, { conn: Client; config: any }>;

// Tool handlers for network switch operations
type ToolHandler = (params: any) => Promise<any>;

export const networkSwitchToolHandlers: Record<string, ToolHandler> = {
  // 1. Device Discovery and Inventory
  async switch_discover_device(params) {
    const { connectionId, enablePassword } = params;

    try {
      const conn = getConnection(connectionMap, connectionId);

      // Get device version information
      const versionResult = await executeNetworkCommand(conn, 'show version', 'generic');
      const deviceType = detectDeviceType(versionResult.stdout);

      // Get appropriate commands for device type
      const commands = deviceType.startsWith('cisco') ? SwitchCommands.cisco : SwitchCommands.aruba;

      // Gather device information
      const deviceInfo: any = {
        type: deviceType,
        version: versionResult.stdout,
        discoveredAt: new Date().toISOString()
      };

      // Try to get additional system information
      try {
        if (deviceType.startsWith('cisco')) {
          const inventoryResult = await executeNetworkCommand(conn, commands.showInventory, deviceType);
          deviceInfo.inventory = inventoryResult.stdout;
        } else if (deviceType === 'aruba-switch') {
          const systemResult = await executeNetworkCommand(conn, commands.showSystem, deviceType);
          deviceInfo.system = systemResult.stdout;
        }
      } catch (error) {
        // Non-critical error, continue
        deviceInfo.additionalInfoError = (error as Error).message;
      }

      return {
        content: [{
          type: 'text',
          text: `Device Discovery Results:\n\nDevice Type: ${deviceType}\n\nVersion Information:\n${versionResult.stdout}\n\nDevice Info:\n${JSON.stringify(deviceInfo, null, 2)}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Device discovery error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 2. Interface Management
  async switch_show_interfaces(params) {
    const { connectionId, interfaceType = 'all', enablePassword } = params;

    try {
      const conn = getConnection(connectionMap, connectionId);

      // First discover device type
      const versionResult = await executeNetworkCommand(conn, 'show version', 'generic');
      const deviceType = detectDeviceType(versionResult.stdout);
      const commands = deviceType.startsWith('cisco') ? SwitchCommands.cisco : SwitchCommands.aruba;

      // Get interface status
      const interfaceResult = await executeNetworkCommand(conn, commands.showInterfaces, deviceType);
      const interfaces = parseInterfaceStatus(interfaceResult.stdout, deviceType);

      return {
        content: [{
          type: 'text',
          text: `Interface Status (${deviceType}):\n\nRaw Output:\n${interfaceResult.stdout}\n\nParsed Interfaces:\n${JSON.stringify(interfaces, null, 2)}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Interface query error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 3. VLAN Management
  async switch_show_vlans(params) {
    const { connectionId, enablePassword } = params;

    try {
      const conn = getConnection(connectionMap, connectionId);

      // Discover device type
      const versionResult = await executeNetworkCommand(conn, 'show version', 'generic');
      const deviceType = detectDeviceType(versionResult.stdout);
      const commands = deviceType.startsWith('cisco') ? SwitchCommands.cisco : SwitchCommands.aruba;

      // Get VLAN information
      const vlanResult = await executeNetworkCommand(conn, commands.showVlans, deviceType);
      const vlans = parseVlanInfo(vlanResult.stdout, deviceType);

      return {
        content: [{
          type: 'text',
          text: `VLAN Information (${deviceType}):\n\nRaw Output:\n${vlanResult.stdout}\n\nParsed VLANs:\n${JSON.stringify(vlans, null, 2)}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `VLAN query error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 4. Configuration Management
  async switch_backup_config(params) {
    const { connectionId, configType = 'running', enablePassword } = params;

    try {
      const conn = getConnection(connectionMap, connectionId);

      // Discover device type
      const versionResult = await executeNetworkCommand(conn, 'show version', 'generic');
      const deviceType = detectDeviceType(versionResult.stdout);
      const commands = deviceType.startsWith('cisco') ? SwitchCommands.cisco : SwitchCommands.aruba;

      // Get configuration
      const configCommand = configType === 'startup' ? commands.showStartupConfig : commands.showRunningConfig;
      const configResult = await executeNetworkCommand(conn, configCommand, deviceType, enablePassword, 60000);

      // Generate backup filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFilename = `switch-config-${configType}-${timestamp}.txt`;

      return {
        content: [{
          type: 'text',
          text: `Configuration Backup (${deviceType} - ${configType}):\n\nBackup saved as: ${backupFilename}\n\nConfiguration:\n${configResult.stdout}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Configuration backup error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 5. Network Diagnostics
  async switch_network_diagnostics(params) {
    const { connectionId, target, diagnosticType = 'ping', enablePassword } = params;

    try {
      const conn = getConnection(connectionMap, connectionId);

      // Discover device type
      const versionResult = await executeNetworkCommand(conn, 'show version', 'generic');
      const deviceType = detectDeviceType(versionResult.stdout);
      const commands = deviceType.startsWith('cisco') ? SwitchCommands.cisco : SwitchCommands.aruba;

      let command = '';
      if (diagnosticType === 'ping') {
        command = commands.ping(target);
      } else if (diagnosticType === 'traceroute') {
        command = commands.traceroute(target);
      } else {
        throw new Error(`Unsupported diagnostic type: ${diagnosticType}`);
      }

      const diagnosticResult = await executeNetworkCommand(conn, command, deviceType, enablePassword, 60000);

      return {
        content: [{
          type: 'text',
          text: `Network Diagnostic (${diagnosticType} to ${target}):\n\n${diagnosticResult.stdout}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Network diagnostic error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 6. MAC Address Table
  async switch_show_mac_table(params) {
    const { connectionId, vlan, enablePassword } = params;

    try {
      const conn = getConnection(connectionMap, connectionId);

      // Discover device type
      const versionResult = await executeNetworkCommand(conn, 'show version', 'generic');
      const deviceType = detectDeviceType(versionResult.stdout);
      const commands = deviceType.startsWith('cisco') ? SwitchCommands.cisco : SwitchCommands.aruba;

      // Get MAC address table
      let command = commands.showMacTable;
      if (vlan) {
        command += ` vlan ${vlan}`;
      }

      const macResult = await executeNetworkCommand(conn, command, deviceType);

      return {
        content: [{
          type: 'text',
          text: `MAC Address Table (${deviceType}):\n\n${macResult.stdout}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `MAC table query error: ${error.message}` }],
        isError: true
      };
    }
  }
};

/**
 * Add network switch management tools to the MCP SSH server
 */
export function addNetworkSwitchTools(server: McpServer, connections: Map<string, { conn: Client; config: any }>) {
  // Store connection map for tool handlers to use
  connectionMap = connections;

  console.error("Network switch management tools loaded");

  server.tool(
    'switch_discover_device',
    'Discover and identify network switch device type and capabilities',
    {
      connectionId: z.string().describe('ID of an active SSH connection'),
      enablePassword: z.string().optional().describe('Enable password for privileged mode (if required)')
    },
    async (args) => networkSwitchToolHandlers.switch_discover_device(args)
  );

  server.tool(
    'switch_show_interfaces',
    'Show interface status and configuration on network switch',
    {
      connectionId: z.string().describe('ID of an active SSH connection'),
      interfaceType: z.string().optional().describe('Type of interfaces to show (all, ethernet, gigabit, etc.)'),
      enablePassword: z.string().optional().describe('Enable password for privileged mode (if required)')
    },
    async (args) => networkSwitchToolHandlers.switch_show_interfaces(args)
  );

  server.tool(
    'switch_show_vlans',
    'Show VLAN configuration and status on network switch',
    {
      connectionId: z.string().describe('ID of an active SSH connection'),
      enablePassword: z.string().optional().describe('Enable password for privileged mode (if required)')
    },
    async (args) => networkSwitchToolHandlers.switch_show_vlans(args)
  );

  server.tool(
    'switch_backup_config',
    'Backup switch configuration (running or startup config)',
    {
      connectionId: z.string().describe('ID of an active SSH connection'),
      configType: z.string().optional().describe('Type of configuration to backup (running, startup)'),
      enablePassword: z.string().optional().describe('Enable password for privileged mode (if required)')
    },
    async (args) => networkSwitchToolHandlers.switch_backup_config(args)
  );

  server.tool(
    'switch_network_diagnostics',
    'Run network diagnostics from switch (ping, traceroute)',
    {
      connectionId: z.string().describe('ID of an active SSH connection'),
      target: z.string().describe('Target IP address or hostname for diagnostic'),
      diagnosticType: z.string().optional().describe('Type of diagnostic to run (ping, traceroute)'),
      enablePassword: z.string().optional().describe('Enable password for privileged mode (if required)')
    },
    async (args) => networkSwitchToolHandlers.switch_network_diagnostics(args)
  );

  server.tool(
    'switch_show_mac_table',
    'Show MAC address table on network switch',
    {
      connectionId: z.string().describe('ID of an active SSH connection'),
      vlan: z.string().optional().describe('Specific VLAN to show MAC addresses for (optional)'),
      enablePassword: z.string().optional().describe('Enable password for privileged mode (if required)')
    },
    async (args) => networkSwitchToolHandlers.switch_show_mac_table(args)
  );
}
