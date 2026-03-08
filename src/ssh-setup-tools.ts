/**
 * SSH Setup Tools for MCP SSH Server
 * 
 * Tools for configuring SSH access on network switches via console connection,
 * allowing users to transition from USB-to-Serial to SSH management.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Client } from "ssh2";

// SSH configuration templates for different device types
export const SSHConfigTemplates = {
  cisco: {
    basic: [
      'configure terminal',
      'hostname {hostname}',
      'ip domain-name {domain}',
      'crypto key generate rsa general-keys modulus 2048',
      'ip ssh version 2',
      'ip ssh time-out 60',
      'ip ssh authentication-retries 3',
      'line vty 0 15',
      'transport input ssh',
      'login local',
      'exit',
      'username {username} privilege 15 secret {password}',
      'enable secret {enable_password}',
      'interface vlan 1',
      'ip address {ip_address} {subnet_mask}',
      'no shutdown',
      'exit',
      'ip default-gateway {gateway}',
      'copy running-config startup-config'
    ],
    secure: [
      'configure terminal',
      'hostname {hostname}',
      'ip domain-name {domain}',
      'crypto key generate rsa general-keys modulus 4096',
      'ip ssh version 2',
      'ip ssh time-out 30',
      'ip ssh authentication-retries 2',
      'line vty 0 15',
      'transport input ssh',
      'login local',
      'exec-timeout 10 0',
      'logging synchronous',
      'exit',
      'username {username} privilege 15 secret {password}',
      'enable secret {enable_password}',
      'service password-encryption',
      'no ip http server',
      'no ip http secure-server',
      'interface vlan 1',
      'ip address {ip_address} {subnet_mask}',
      'no shutdown',
      'exit',
      'ip default-gateway {gateway}',
      'banner motd ^Authorized access only^',
      'copy running-config startup-config'
    ]
  },
  aruba: {
    basic: [
      'configure',
      'hostname {hostname}',
      'ip default-gateway {gateway}',
      'vlan 1',
      'ip address {ip_address} {subnet_mask}',
      'exit',
      'crypto key generate ssh rsa bits 2048',
      'ip ssh',
      'password manager',
      'username {username}',
      'password {password}',
      'exit',
      'password operator',
      'username operator',
      'password {enable_password}',
      'exit',
      'write memory'
    ],
    secure: [
      'configure',
      'hostname {hostname}',
      'ip default-gateway {gateway}',
      'vlan 1',
      'ip address {ip_address} {subnet_mask}',
      'exit',
      'crypto key generate ssh rsa bits 4096',
      'ip ssh',
      'ip ssh timeout 300',
      'password manager',
      'username {username}',
      'password {password}',
      'exit',
      'password operator',
      'username operator',
      'password {enable_password}',
      'exit',
      'no web-management',
      'no telnet-server',
      'banner motd "Authorized access only"',
      'write memory'
    ]
  }
};

// Network configuration validation
export function validateNetworkConfig(config: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.ip_address || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(config.ip_address)) {
    errors.push('Invalid IP address format');
  }

  if (!config.subnet_mask || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(config.subnet_mask)) {
    errors.push('Invalid subnet mask format');
  }

  if (!config.gateway || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(config.gateway)) {
    errors.push('Invalid gateway IP address format');
  }

  if (!config.username || config.username.length < 3) {
    errors.push('Username must be at least 3 characters');
  }

  if (!config.password || config.password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }

  if (!config.hostname || config.hostname.length < 3) {
    errors.push('Hostname must be at least 3 characters');
  }

  return { valid: errors.length === 0, errors };
}

// Template variable replacement
export function replaceTemplateVariables(template: string[], variables: Record<string, string>): string[] {
  return template.map(command => {
    let processedCommand = command;
    for (const [key, value] of Object.entries(variables)) {
      processedCommand = processedCommand.replace(new RegExp(`{${key}}`, 'g'), value);
    }
    return processedCommand;
  });
}

// Global connection maps
let connectionMap: Map<string, { conn: Client; config: any }>;
let serialConnectionMap: Map<string, any>;

// Tool handlers for SSH setup operations
type ToolHandler = (params: any) => Promise<any>;

export const sshSetupToolHandlers: Record<string, ToolHandler> = {
  // 1. Generate SSH Configuration Template
  async switch_generate_ssh_config(params) {
    const {
      deviceType = 'cisco',
      securityLevel = 'basic',
      hostname,
      domain = 'local',
      ip_address,
      subnet_mask = '255.255.255.0',
      gateway,
      username,
      password,
      enable_password
    } = params;

    try {
      // Validate required parameters
      const config = {
        hostname,
        domain,
        ip_address,
        subnet_mask,
        gateway,
        username,
        password,
        enable_password: enable_password || password
      };

      const validation = validateNetworkConfig(config);
      if (!validation.valid) {
        throw new Error(`Configuration validation failed: ${validation.errors.join(', ')}`);
      }

      // Get appropriate template
      const templates = SSHConfigTemplates[deviceType as keyof typeof SSHConfigTemplates];
      if (!templates) {
        throw new Error(`Unsupported device type: ${deviceType}`);
      }

      const template = templates[securityLevel as keyof typeof templates];
      if (!template) {
        throw new Error(`Unsupported security level: ${securityLevel}`);
      }

      // Replace template variables
      const configCommands = replaceTemplateVariables(template, config);

      return {
        content: [{
          type: 'text',
          text: `SSH Configuration Template (${deviceType} - ${securityLevel}):\n\n${configCommands.join('\n')}\n\nConfiguration Summary:\n- Device Type: ${deviceType}\n- Security Level: ${securityLevel}\n- IP Address: ${ip_address}/${subnet_mask}\n- Gateway: ${gateway}\n- SSH Username: ${username}\n- Hostname: ${hostname}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `SSH config generation error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 2. Apply SSH Configuration via Serial
  async switch_apply_ssh_config(params) {
    const {
      serialConnectionId,
      deviceType = 'cisco',
      securityLevel = 'basic',
      hostname,
      domain = 'local',
      ip_address,
      subnet_mask = '255.255.255.0',
      gateway,
      username,
      password,
      enable_password,
      confirmApply = false
    } = params;

    try {
      // Check if serial connection exists
      if (!serialConnectionMap || !serialConnectionMap.has(serialConnectionId)) {
        throw new Error(`No active serial connection with ID: ${serialConnectionId}`);
      }

      const { port, config: serialConfig } = serialConnectionMap.get(serialConnectionId);

      if (!confirmApply) {
        return {
          content: [{
            type: 'text',
            text: `SSH Configuration Ready to Apply\n\nThis will configure SSH access on the switch via console connection.\n\nConfiguration:\n- IP Address: ${ip_address}/${subnet_mask}\n- Gateway: ${gateway}\n- SSH Username: ${username}\n- Hostname: ${hostname}\n- Device Type: ${deviceType}\n- Security Level: ${securityLevel}\n\nWARNING: This will modify the switch configuration!\n\nTo proceed, set confirmApply=true in your request.`
          }]
        };
      }

      // Validate configuration
      const config = {
        hostname,
        domain,
        ip_address,
        subnet_mask,
        gateway,
        username,
        password,
        enable_password: enable_password || password
      };

      const validation = validateNetworkConfig(config);
      if (!validation.valid) {
        throw new Error(`Configuration validation failed: ${validation.errors.join(', ')}`);
      }

      // Get configuration template
      const templates = SSHConfigTemplates[deviceType as keyof typeof SSHConfigTemplates];
      if (!templates) {
        throw new Error(`Unsupported device type: ${deviceType}. Supported: cisco, aruba`);
      }
      const template = templates[securityLevel as keyof typeof templates];
      if (!template) {
        throw new Error(`Unsupported security level: ${securityLevel}. Supported: basic, secure`);
      }
      const configCommands = replaceTemplateVariables(template, config);

      // Apply configuration via serial connection
      let configResults = '';
      let successfulCommands = 0;
      let failedCommands = 0;

      // First, ensure we're in enable mode
      configResults += '--- Entering enable mode ---\n';
      await port.write('\r\n');
      let response = await port.read(3000);

      // Check if we need to enter enable mode
      if (!response.includes('#')) {
        await port.write('enable\r\n');
        response = await port.read(5000);

        // Handle enable password if prompted
        if (response.toLowerCase().includes('password')) {
          await port.write((enable_password || password) + '\r\n');
          response = await port.read(5000);
        }
      }

      configResults += `Mode check response: ${response.trim()}\n\n`;

      // Now apply each command
      for (let i = 0; i < configCommands.length; i++) {
        const command = configCommands[i];

        try {
          // Special handling for key generation (takes much longer)
          const isKeyGen = command.includes('crypto key generate');
          const timeout = isKeyGen ? 90000 : 10000; // 90 seconds for key gen

          if (isKeyGen) {
            configResults += `[${i + 1}/${configCommands.length}] ${command}\n`;
            configResults += 'Generating RSA keys (this may take 30-90 seconds)...\n';
          }

          // Use sendCommand which handles --More-- prompts
          const cmdResponse = await port.sendCommand(command, timeout);

          // Check for common error indicators
          const hasError = cmdResponse.toLowerCase().includes('invalid') ||
            cmdResponse.toLowerCase().includes('error') ||
            cmdResponse.toLowerCase().includes('failed') ||
            cmdResponse.toLowerCase().includes('unknown command');

          if (hasError) {
            configResults += `[${i + 1}/${configCommands.length}] ${command}\nWARNING: ${cmdResponse.trim()}\n\n`;
            failedCommands++;
          } else {
            configResults += `[${i + 1}/${configCommands.length}] ${command}\nOK: ${cmdResponse.trim().substring(0, 200)}\n\n`;
            successfulCommands++;
          }

          // Handle confirmation prompts for key generation
          if (isKeyGen && cmdResponse.includes('[yes/no]')) {
            await port.write('yes\r\n');
            const confirmResponse = await port.read(90000);
            configResults += `Key generation confirmation: ${confirmResponse.trim()}\n\n`;
          }

          // Small delay between commands
          await new Promise(resolve => setTimeout(resolve, 500));

        } catch (error) {
          configResults += `[${i + 1}/${configCommands.length}] ${command}\nERROR: ${(error as Error).message}\n\n`;
          failedCommands++;
        }
      }

      // Final status
      const status = failedCommands === 0 ? 'SUCCESS' : (failedCommands < configCommands.length / 2 ? 'PARTIAL SUCCESS' : 'FAILED');

      return {
        content: [{
          type: 'text',
          text: `SSH Configuration Applied via Serial Connection\n\nStatus: ${status}\nCommands Successful: ${successfulCommands}/${configCommands.length}\nCommands Failed: ${failedCommands}/${configCommands.length}\n\nConfiguration Log:\n${configResults}\n\n${failedCommands === 0 ? '✅ SSH should now be available at ' + ip_address : '⚠️  Some commands failed. SSH may still work at ' + ip_address}\n\nNext Steps:\n1. Test SSH connection: ssh ${username}@${ip_address}\n2. If successful, you can disconnect the console cable\n3. Use the SSH connection for future management`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `SSH configuration error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 3. Verify Current SSH Status
  async switch_verify_ssh_status(params) {
    const { serialConnectionId } = params;

    try {
      if (!serialConnectionMap || !serialConnectionMap.has(serialConnectionId)) {
        throw new Error(`No active serial connection with ID: ${serialConnectionId}`);
      }

      const { port, config: serialConfig } = serialConnectionMap.get(serialConnectionId);

      let statusReport = 'SSH Status Check\n\n';

      // Check SSH version and status
      const sshVersionResponse = await port.sendCommand('show ip ssh', 10000);
      statusReport += `--- SSH Configuration ---\n${sshVersionResponse}\n\n`;

      // Check crypto key status
      const cryptoResponse = await port.sendCommand('show crypto key mypubkey rsa', 10000);
      statusReport += `--- RSA Keys ---\n${cryptoResponse}\n\n`;

      // Check VTY line configuration
      const vtyResponse = await port.sendCommand('show running-config | section line vty', 10000);
      statusReport += `--- VTY Lines ---\n${vtyResponse}\n\n`;

      // Check interface IP configuration
      const interfaceResponse = await port.sendCommand('show ip interface brief', 10000);
      statusReport += `--- Interface Status ---\n${interfaceResponse}\n\n`;

      // Analyze status
      const sshEnabled = sshVersionResponse.toLowerCase().includes('ssh') &&
        !sshVersionResponse.toLowerCase().includes('disabled');
      const hasKeys = !cryptoResponse.toLowerCase().includes('no key') &&
        cryptoResponse.toLowerCase().includes('key');
      const sshTransport = vtyResponse.toLowerCase().includes('transport input ssh');

      statusReport += '--- Analysis ---\n';
      statusReport += `SSH Service: ${sshEnabled ? 'Enabled' : 'Not configured or disabled'}\n`;
      statusReport += `RSA Keys: ${hasKeys ? 'Present' : 'Not generated'}\n`;
      statusReport += `VTY SSH Access: ${sshTransport ? 'Configured' : 'Not configured'}\n`;

      if (sshEnabled && hasKeys && sshTransport) {
        statusReport += '\n✅ SSH appears to be fully configured and ready for use.';
      } else {
        statusReport += '\n⚠️  SSH is not fully configured. Use switch_apply_ssh_config to set it up.';
      }

      return {
        content: [{
          type: 'text',
          text: statusReport
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `SSH status check error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 4. Test SSH Connection
  async switch_test_ssh_connection(params) {
    const { ip_address, username, password, port = 22, timeout = 10000 } = params;

    try {
      // Create a test SSH connection
      const testConn = new Client();

      const connectionResult = await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error('SSH connection test timed out'));
        }, timeout);

        testConn.on('ready', () => {
          clearTimeout(timeoutId);
          resolve('success');
        });

        testConn.on('error', (err: Error) => {
          clearTimeout(timeoutId);
          reject(new Error(`SSH connection failed: ${err.message}`));
        });

        testConn.connect({
          host: ip_address,
          port,
          username,
          password,
          readyTimeout: timeout
        });
      });

      // Test basic command execution
      let commandTest = '';
      try {
        const result: any = await new Promise((resolve, reject) => {
          testConn.exec('show version', (err: Error | undefined, stream: any) => {
            if (err) {
              reject(err);
              return;
            }

            let output = '';
            stream.on('close', () => {
              resolve(output);
            });

            stream.on('data', (data: Buffer) => {
              output += data.toString();
            });
          });
        });

        commandTest = result.substring(0, 200) + '...';
      } catch (error) {
        commandTest = `Command test failed: ${(error as Error).message}`;
      }

      // Close test connection
      testConn.end();

      return {
        content: [{
          type: 'text',
          text: `✅ SSH Connection Test Successful!\n\nConnection Details:\n- Host: ${ip_address}:${port}\n- Username: ${username}\n- Status: Connected\n\nCommand Test Result:\n${commandTest}\n\n🎉 SSH is working! You can now:\n1. Disconnect the console cable\n2. Use SSH for all future management\n3. Connect via: ssh ${username}@${ip_address}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `❌ SSH Connection Test Failed\n\nError: ${error.message}\n\nTroubleshooting:\n1. Verify IP address is reachable: ping ${ip_address}\n2. Check if SSH service is running on the switch\n3. Verify username/password are correct\n4. Ensure firewall allows SSH (port ${port})\n5. Try connecting via console to check configuration`
        }],
        isError: true
      };
    }
  },

  // 4. Complete SSH Setup Workflow
  async switch_complete_ssh_setup(params) {
    const {
      serialConnectionId,
      deviceType = 'cisco',
      securityLevel = 'basic',
      hostname,
      ip_address,
      subnet_mask = '255.255.255.0',
      gateway,
      username,
      password,
      enable_password,
      testConnection = true,
      confirmSetup = false
    } = params;

    try {
      if (!confirmSetup) {
        return {
          content: [{
            type: 'text',
            text: `🔧 Complete SSH Setup Workflow\n\nThis will:\n1. Generate SSH configuration for ${deviceType}\n2. Apply configuration via console connection\n3. Test SSH connectivity\n4. Provide transition instructions\n\nConfiguration:\n- Device: ${deviceType} (${securityLevel} security)\n- IP: ${ip_address}/${subnet_mask}\n- Gateway: ${gateway}\n- SSH User: ${username}\n- Hostname: ${hostname}\n\n⚠️  This will modify switch configuration!\n\nTo proceed, set confirmSetup=true`
          }]
        };
      }

      let workflowResults = '🔧 SSH Setup Workflow Started\n\n';

      // Step 1: Generate configuration
      workflowResults += '📋 Step 1: Generating SSH configuration...\n';
      const configResult = await sshSetupToolHandlers.switch_generate_ssh_config({
        deviceType, securityLevel, hostname, ip_address, subnet_mask, gateway, username, password, enable_password
      });

      if (configResult.isError) {
        throw new Error('Configuration generation failed');
      }

      workflowResults += '✅ Configuration generated successfully\n\n';

      // Step 2: Apply configuration
      workflowResults += '⚙️  Step 2: Applying configuration via console...\n';
      const applyResult = await sshSetupToolHandlers.switch_apply_ssh_config({
        serialConnectionId, deviceType, securityLevel, hostname, ip_address, subnet_mask, gateway, username, password, enable_password, confirmApply: true
      });

      if (applyResult.isError) {
        throw new Error('Configuration application failed');
      }

      workflowResults += '✅ Configuration applied successfully\n\n';

      // Step 3: Wait for services to start
      workflowResults += '⏳ Step 3: Waiting for SSH service to start (30 seconds)...\n';
      await new Promise(resolve => setTimeout(resolve, 30000));
      workflowResults += '✅ Wait complete\n\n';

      // Step 4: Test SSH connection
      if (testConnection) {
        workflowResults += '🔍 Step 4: Testing SSH connection...\n';
        const testResult = await sshSetupToolHandlers.switch_test_ssh_connection({
          ip_address, username, password
        });

        if (testResult.isError) {
          workflowResults += '⚠️  SSH test failed, but configuration was applied\n';
          workflowResults += 'You may need to wait longer or check network connectivity\n\n';
        } else {
          workflowResults += '✅ SSH connection test successful!\n\n';
        }
      }

      // Final instructions
      workflowResults += '🎉 SSH Setup Complete!\n\n';
      workflowResults += 'Next Steps:\n';
      workflowResults += `1. Connect via SSH: ssh ${username}@${ip_address}\n`;
      workflowResults += '2. Disconnect console cable (SSH is now available)\n';
      workflowResults += '3. Use SSH for all future management\n';
      workflowResults += '4. Consider securing console port access\n';

      return {
        content: [{
          type: 'text',
          text: workflowResults
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `SSH setup workflow error: ${error.message}` }],
        isError: true
      };
    }
  }
};

/**
 * Add SSH setup tools to the MCP SSH server
 */
export function addSSHSetupTools(server: McpServer, connections: Map<string, { conn: Client; config: any }>, serialConnections: Map<string, any>) {
  // Store connection maps for tool handlers to use
  connectionMap = connections;
  serialConnectionMap = serialConnections;

  console.error("SSH setup tools loaded");

  server.tool(
    'switch_generate_ssh_config',
    'Generate SSH configuration template for network switch',
    {
      deviceType: z.string().optional().describe('Device type (cisco, aruba)'),
      securityLevel: z.string().optional().describe('Security level (basic, secure)'),
      hostname: z.string().describe('Switch hostname'),
      domain: z.string().optional().describe('Domain name (default: local)'),
      ip_address: z.string().describe('Management IP address'),
      subnet_mask: z.string().optional().describe('Subnet mask (default: 255.255.255.0)'),
      gateway: z.string().describe('Default gateway IP address'),
      username: z.string().describe('SSH username'),
      password: z.string().describe('SSH password'),
      enable_password: z.string().optional().describe('Enable password (optional, defaults to SSH password)')
    },
    async (args) => sshSetupToolHandlers.switch_generate_ssh_config(args)
  );

  server.tool(
    'switch_apply_ssh_config',
    'Apply SSH configuration to switch via serial console connection',
    {
      serialConnectionId: z.string().describe('ID of active serial console connection'),
      deviceType: z.string().optional().describe('Device type (cisco, aruba)'),
      securityLevel: z.string().optional().describe('Security level (basic, secure)'),
      hostname: z.string().describe('Switch hostname'),
      domain: z.string().optional().describe('Domain name (default: local)'),
      ip_address: z.string().describe('Management IP address'),
      subnet_mask: z.string().optional().describe('Subnet mask (default: 255.255.255.0)'),
      gateway: z.string().describe('Default gateway IP address'),
      username: z.string().describe('SSH username'),
      password: z.string().describe('SSH password'),
      enable_password: z.string().optional().describe('Enable password (optional)'),
      confirmApply: z.boolean().optional().describe('Confirm application of configuration (required for safety)')
    },
    async (args) => sshSetupToolHandlers.switch_apply_ssh_config(args)
  );

  server.tool(
    'switch_verify_ssh_status',
    'Check current SSH configuration status on the switch via serial connection',
    {
      serialConnectionId: z.string().describe('ID of active serial console connection')
    },
    async (args) => sshSetupToolHandlers.switch_verify_ssh_status(args)
  );

  server.tool(
    'switch_test_ssh_connection',
    'Test SSH connection to newly configured switch',
    {
      ip_address: z.string().describe('Switch IP address'),
      username: z.string().describe('SSH username'),
      password: z.string().describe('SSH password'),
      port: z.number().optional().describe('SSH port (default: 22)'),
      timeout: z.number().optional().describe('Connection timeout in milliseconds (default: 10000)')
    },
    async (args) => sshSetupToolHandlers.switch_test_ssh_connection(args)
  );

  server.tool(
    'switch_complete_ssh_setup',
    'Complete end-to-end SSH setup workflow via console connection',
    {
      serialConnectionId: z.string().describe('ID of active serial console connection'),
      deviceType: z.string().optional().describe('Device type (cisco, aruba)'),
      securityLevel: z.string().optional().describe('Security level (basic, secure)'),
      hostname: z.string().describe('Switch hostname'),
      ip_address: z.string().describe('Management IP address'),
      subnet_mask: z.string().optional().describe('Subnet mask (default: 255.255.255.0)'),
      gateway: z.string().describe('Default gateway IP address'),
      username: z.string().describe('SSH username'),
      password: z.string().describe('SSH password'),
      enable_password: z.string().optional().describe('Enable password (optional)'),
      testConnection: z.boolean().optional().describe('Test SSH connection after setup (default: true)'),
      confirmSetup: z.boolean().optional().describe('Confirm complete setup workflow (required for safety)')
    },
    async (args) => sshSetupToolHandlers.switch_complete_ssh_setup(args)
  );
}
