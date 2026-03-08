/**
 * Console-to-SSH Transition Tools for MCP SSH Server
 *
 * Provides a unified workflow for transitioning from USB-to-Serial console
 * management to SSH-based management on network switches.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Client } from 'ssh2';
import { serialConnectionToolHandlers } from './serial-connection-tools.js';
import { sshSetupToolHandlers, validateNetworkConfig, SSHConfigTemplates, replaceTemplateVariables } from './ssh-setup-tools.js';

// Global connection maps (passed in from main server)
let serialConnectionMap: Map<string, any>;

// Tool handlers
type ToolHandler = (params: any) => Promise<any>;

export const consoleTransitionToolHandlers: Record<string, ToolHandler> = {
  /**
   * Complete Console-to-SSH Transition Workflow
   *
   * This tool guides through the entire process:
   * 1. Connect to switch via serial console
   * 2. Discover device type
   * 3. Check current SSH status
   * 4. Apply SSH configuration
   * 5. Test SSH connection
   * 6. Provide transition summary
   */
  async console_to_ssh_transition(params) {
    const {
      port,
      hostname,
      ip_address,
      subnet_mask = '255.255.255.0',
      gateway,
      username,
      password,
      enable_password,
      deviceType,
      securityLevel = 'basic',
      baudRate = 9600,
      confirmTransition = false
    } = params;

    try {
      // Validate network configuration first
      const config = {
        hostname,
        ip_address,
        subnet_mask,
        gateway,
        username,
        password,
        enable_password: enable_password || password
      };

      const validation = validateNetworkConfig(config);
      if (!validation.valid) {
        return {
          content: [{
            type: 'text',
            text: `Configuration validation failed:\n${validation.errors.map(e => `- ${e}`).join('\n')}`
          }],
          isError: true
        };
      }

      if (!confirmTransition) {
        return {
          content: [{
            type: 'text',
            text: `Console-to-SSH Transition Workflow

This workflow will:
1. Connect to switch via serial port: ${port}
2. Discover the device type (or use: ${deviceType || 'auto-detect'})
3. Check current SSH status
4. Configure SSH with these settings:
   - Hostname: ${hostname}
   - IP Address: ${ip_address}/${subnet_mask}
   - Gateway: ${gateway}
   - SSH Username: ${username}
   - Security Level: ${securityLevel}
5. Test SSH connectivity
6. Provide transition summary

WARNING: This will modify switch configuration!

To proceed, set confirmTransition=true`
          }]
        };
      }

      let results = '=== Console-to-SSH Transition Workflow ===\n\n';
      const connectionId = `transition-${Date.now()}`;

      // Step 1: Connect via serial
      results += '📡 Step 1: Connecting via serial console...\n';
      const connectResult = await serialConnectionToolHandlers.serial_connect({
        port,
        baudRate,
        connectionId,
        deviceType: deviceType || 'generic'
      });

      if (connectResult.isError) {
        throw new Error(`Serial connection failed: ${connectResult.content[0].text}`);
      }
      results += `✅ Connected to ${port}\n\n`;

      // Step 2: Discover device type
      results += '🔍 Step 2: Discovering device type...\n';
      const discoverResult = await serialConnectionToolHandlers.serial_discover_device({
        connectionId
      });

      let detectedDeviceType = deviceType;
      if (!detectedDeviceType && !discoverResult.isError) {
        const discoverText = discoverResult.content[0].text;
        if (discoverText.includes('cisco-ios-xe')) {
          detectedDeviceType = 'cisco';
        } else if (discoverText.includes('cisco-ios')) {
          detectedDeviceType = 'cisco';
        } else if (discoverText.includes('aruba')) {
          detectedDeviceType = 'aruba';
        } else {
          detectedDeviceType = 'cisco'; // Default to Cisco commands
        }
      }
      results += `✅ Detected device type: ${detectedDeviceType}\n\n`;

      // Step 3: Enter enable mode
      results += '🔑 Step 3: Entering privileged mode...\n';
      const enableResult = await serialConnectionToolHandlers.serial_enter_enable({
        connectionId,
        enablePassword: enable_password || password
      });

      if (enableResult.isError && !enableResult.content[0].text.includes('Already in')) {
        results += `⚠️  Warning: ${enableResult.content[0].text}\n`;
        results += 'Continuing anyway...\n\n';
      } else {
        results += '✅ In privileged mode\n\n';
      }

      // Step 4: Check current SSH status
      results += '📋 Step 4: Checking current SSH configuration...\n';
      const statusResult = await sshSetupToolHandlers.switch_verify_ssh_status({
        serialConnectionId: connectionId
      });
      results += statusResult.content[0].text + '\n\n';

      // Step 5: Apply SSH configuration
      results += '⚙️  Step 5: Applying SSH configuration...\n';
      const applyResult = await sshSetupToolHandlers.switch_apply_ssh_config({
        serialConnectionId: connectionId,
        deviceType: detectedDeviceType,
        securityLevel,
        hostname,
        ip_address,
        subnet_mask,
        gateway,
        username,
        password,
        enable_password: enable_password || password,
        confirmApply: true
      });

      if (applyResult.isError) {
        results += `⚠️  Configuration had issues: ${applyResult.content[0].text}\n\n`;
      } else {
        results += '✅ SSH configuration applied\n\n';
      }

      // Step 6: Wait for SSH service to start
      results += '⏳ Step 6: Waiting for SSH service to initialize (30 seconds)...\n';
      await new Promise(resolve => setTimeout(resolve, 30000));
      results += '✅ Wait complete\n\n';

      // Step 7: Test SSH connection
      results += '🔌 Step 7: Testing SSH connection...\n';
      const testResult = await sshSetupToolHandlers.switch_test_ssh_connection({
        ip_address,
        username,
        password
      });

      let sshWorking = false;
      if (testResult.isError) {
        results += `⚠️  SSH test failed: ${testResult.content[0].text}\n`;
        results += 'The switch may need more time, or network configuration may need adjustment.\n\n';
      } else {
        results += '✅ SSH connection successful!\n\n';
        sshWorking = true;
      }

      // Step 8: Disconnect serial
      results += '🔌 Step 8: Disconnecting serial console...\n';
      await serialConnectionToolHandlers.serial_disconnect({ connectionId });
      results += '✅ Serial disconnected\n\n';

      // Final summary
      results += '=== Transition Summary ===\n\n';
      if (sshWorking) {
        results += `🎉 SUCCESS! SSH is now available.\n\n`;
        results += `Connection Details:\n`;
        results += `  Host: ${ip_address}\n`;
        results += `  Port: 22\n`;
        results += `  Username: ${username}\n\n`;
        results += `Connect using: ssh ${username}@${ip_address}\n\n`;
        results += `You can now:\n`;
        results += `1. Disconnect the USB-to-Serial console cable\n`;
        results += `2. Use SSH for all future management\n`;
        results += `3. Store these credentials securely\n`;
      } else {
        results += `⚠️  PARTIAL SUCCESS\n\n`;
        results += `SSH configuration was applied, but the connection test failed.\n\n`;
        results += `Troubleshooting:\n`;
        results += `1. Wait a few more minutes and try: ssh ${username}@${ip_address}\n`;
        results += `2. Verify network connectivity: ping ${ip_address}\n`;
        results += `3. Check firewall rules allow SSH (port 22)\n`;
        results += `4. Reconnect via console to verify configuration\n`;
      }

      return {
        content: [{
          type: 'text',
          text: results
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Transition workflow error: ${error.message}` }],
        isError: true
      };
    }
  },

  /**
   * Quick SSH Status Check
   * Connects to a switch via serial, checks SSH status, and disconnects
   */
  async quick_ssh_check(params) {
    const { port, baudRate = 9600, enablePassword } = params;

    try {
      const connectionId = `check-${Date.now()}`;

      // Connect
      const connectResult = await serialConnectionToolHandlers.serial_connect({
        port,
        baudRate,
        connectionId
      });

      if (connectResult.isError) {
        throw new Error(`Serial connection failed: ${connectResult.content[0].text}`);
      }

      // Enter enable mode if password provided
      if (enablePassword) {
        await serialConnectionToolHandlers.serial_enter_enable({
          connectionId,
          enablePassword
        });
      }

      // Check SSH status
      const statusResult = await sshSetupToolHandlers.switch_verify_ssh_status({
        serialConnectionId: connectionId
      });

      // Disconnect
      await serialConnectionToolHandlers.serial_disconnect({ connectionId });

      return {
        content: [{
          type: 'text',
          text: `Quick SSH Check via ${port}\n\n${statusResult.content[0].text}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Quick SSH check error: ${error.message}` }],
        isError: true
      };
    }
  }
};

/**
 * Add console transition tools to the MCP SSH server
 */
export function addConsoleTransitionTools(server: McpServer, serialConnections: Map<string, any>) {
  serialConnectionMap = serialConnections;

  console.error("Console transition tools loaded");

  server.tool(
    'console_to_ssh_transition',
    'Complete workflow to transition a network switch from console-only to SSH management',
    {
      port: z.string().describe('Serial port (e.g., COM3, /dev/ttyUSB0)'),
      hostname: z.string().describe('Switch hostname to configure'),
      ip_address: z.string().describe('Management IP address for SSH'),
      subnet_mask: z.string().optional().describe('Subnet mask (default: 255.255.255.0)'),
      gateway: z.string().describe('Default gateway IP'),
      username: z.string().describe('SSH username to create'),
      password: z.string().describe('SSH password'),
      enable_password: z.string().optional().describe('Enable password (optional, defaults to SSH password)'),
      deviceType: z.string().optional().describe('Device type: cisco or aruba (auto-detected if not specified)'),
      securityLevel: z.string().optional().describe('Security level: basic or secure (default: basic)'),
      baudRate: z.number().optional().describe('Serial baud rate (default: 9600)'),
      confirmTransition: z.boolean().optional().describe('Confirm to proceed with transition (required for safety)')
    },
    async (args) => consoleTransitionToolHandlers.console_to_ssh_transition(args)
  );

  server.tool(
    'quick_ssh_check',
    'Quick check of SSH status on a switch via serial connection',
    {
      port: z.string().describe('Serial port (e.g., COM3, /dev/ttyUSB0)'),
      baudRate: z.number().optional().describe('Serial baud rate (default: 9600)'),
      enablePassword: z.string().optional().describe('Enable password (if required)')
    },
    async (args) => consoleTransitionToolHandlers.quick_ssh_check(args)
  );
}
