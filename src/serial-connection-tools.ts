/**
 * Serial Connection Tools for MCP SSH Server
 *
 * Provides USB-to-Serial console connection support for network devices
 * that don't have SSH enabled or for initial configuration.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';

// Serial connection interface
export interface SerialConnection {
  id: string;
  port: string;
  baudRate: number;
  dataBits: 8 | 7 | 6 | 5;
  stopBits: 1 | 2;
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
  flowControl: boolean;
  timeout: number;
  connected: boolean;
  deviceType?: string;
  currentMode?: 'user' | 'enable' | 'config' | 'unknown';
  lastPrompt?: string;
  lastActivity?: Date;
}

// Common serial port settings for network devices
export const SerialPortSettings = {
  cisco: {
    baudRate: 9600,
    dataBits: 8 as const,
    stopBits: 1 as const,
    parity: 'none' as const,
    flowControl: false,
    timeout: 30000
  },
  aruba: {
    baudRate: 9600,
    dataBits: 8 as const,
    stopBits: 1 as const,
    parity: 'none' as const,
    flowControl: false,
    timeout: 30000
  },
  generic: {
    baudRate: 9600,
    dataBits: 8 as const,
    stopBits: 1 as const,
    parity: 'none' as const,
    flowControl: false,
    timeout: 30000
  }
};

// Prompt patterns for different device modes
const PROMPT_PATTERNS = {
  user: /^[\w\-]+>\s*$/m,           // Switch>
  enable: /^[\w\-]+#\s*$/m,         // Switch#
  config: /^[\w\-]+\([^\)]+\)#\s*$/m, // Switch(config)# or Switch(config-if)#
  password: /[Pp]assword:\s*$/m,
  morePrompt: /--[Mm]ore--/,
  confirm: /\[yes\/no\]|\[confirm\]|\(y\/n\)/i
};

/**
 * Real Serial Port wrapper with buffered reading and prompt detection
 */
class RealSerialPort {
  private serialPort: SerialPort;
  private parser: ReadlineParser;
  private buffer: string = '';
  private dataPromiseResolve: ((value: string) => void) | null = null;
  private portPath: string;

  constructor(portPath: string, options: {
    baudRate: number;
    dataBits: 8 | 7 | 6 | 5;
    stopBits: 1 | 2;
    parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
  }) {
    this.portPath = portPath;
    this.serialPort = new SerialPort({
      path: portPath,
      baudRate: options.baudRate,
      dataBits: options.dataBits,
      stopBits: options.stopBits,
      parity: options.parity,
      autoOpen: false
    });

    this.parser = this.serialPort.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    // Collect data into buffer
    this.serialPort.on('data', (data: Buffer) => {
      this.buffer += data.toString();

      // If we're waiting for data, check if we have a complete response
      if (this.dataPromiseResolve) {
        // Check for prompts that indicate response is complete
        if (this.hasCompleteResponse()) {
          const response = this.buffer;
          this.buffer = '';
          this.dataPromiseResolve(response);
          this.dataPromiseResolve = null;
        }
      }
    });
  }

  private hasCompleteResponse(): boolean {
    // Check if buffer ends with a known prompt
    return PROMPT_PATTERNS.user.test(this.buffer) ||
      PROMPT_PATTERNS.enable.test(this.buffer) ||
      PROMPT_PATTERNS.config.test(this.buffer) ||
      PROMPT_PATTERNS.password.test(this.buffer) ||
      PROMPT_PATTERNS.morePrompt.test(this.buffer) ||
      PROMPT_PATTERNS.confirm.test(this.buffer);
  }

  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.serialPort.open((err: Error | null) => {
        if (err) {
          reject(new Error(`Failed to open serial port ${this.portPath}: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  async write(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.serialPort.isOpen) {
        reject(new Error('Serial port is not open'));
        return;
      }

      this.serialPort.write(data, (err: Error | null | undefined) => {
        if (err) {
          reject(new Error(`Serial write error: ${err.message}`));
        } else {
          this.serialPort.drain((drainErr: Error | null | undefined) => {
            if (drainErr) {
              reject(new Error(`Serial drain error: ${drainErr.message}`));
            } else {
              resolve();
            }
          });
        }
      });
    });
  }

  async read(timeout: number = 5000): Promise<string> {
    // Clear any existing buffer data first
    this.buffer = '';

    return new Promise((resolve, reject) => {
      if (!this.serialPort.isOpen) {
        reject(new Error('Serial port is not open'));
        return;
      }

      const timeoutId = setTimeout(() => {
        this.dataPromiseResolve = null;
        // Return whatever we have in the buffer, even if incomplete
        const response = this.buffer;
        this.buffer = '';
        resolve(response || '(timeout - no response)');
      }, timeout);

      this.dataPromiseResolve = (data: string) => {
        clearTimeout(timeoutId);
        resolve(data);
      };

      // If we already have a complete response in the buffer, resolve immediately
      if (this.hasCompleteResponse()) {
        clearTimeout(timeoutId);
        const response = this.buffer;
        this.buffer = '';
        this.dataPromiseResolve = null;
        resolve(response);
      }
    });
  }

  /**
   * Read until a specific pattern is found or timeout
   */
  async readUntil(pattern: RegExp, timeout: number = 10000): Promise<string> {
    const startTime = Date.now();
    let accumulated = '';

    while (Date.now() - startTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, 100));
      accumulated += this.buffer;
      this.buffer = '';

      if (pattern.test(accumulated)) {
        return accumulated;
      }
    }

    return accumulated || '(timeout)';
  }

  /**
   * Send command and wait for response with --More-- handling
   */
  async sendCommand(command: string, timeout: number = 10000): Promise<string> {
    await this.write(command + '\r\n');

    let fullResponse = '';
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const response = await this.read(Math.min(timeout - (Date.now() - startTime), 5000));
      fullResponse += response;

      // Handle --More-- prompts
      if (PROMPT_PATTERNS.morePrompt.test(response)) {
        await this.write(' '); // Send space to continue
        continue;
      }

      // Check if we got a command prompt (response complete)
      if (PROMPT_PATTERNS.user.test(response) ||
        PROMPT_PATTERNS.enable.test(response) ||
        PROMPT_PATTERNS.config.test(response)) {
        break;
      }
    }

    return fullResponse;
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.serialPort.isOpen) {
        resolve();
        return;
      }

      this.serialPort.close((err: Error | null) => {
        if (err) {
          reject(new Error(`Failed to close serial port: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  get isConnected(): boolean {
    return this.serialPort.isOpen;
  }

  /**
   * Detect current mode from the last response
   */
  detectMode(response: string): 'user' | 'enable' | 'config' | 'unknown' {
    if (PROMPT_PATTERNS.config.test(response)) return 'config';
    if (PROMPT_PATTERNS.enable.test(response)) return 'enable';
    if (PROMPT_PATTERNS.user.test(response)) return 'user';
    return 'unknown';
  }
}

/**
 * Get available serial ports using serialport's list function
 */
export async function getAvailableSerialPorts(): Promise<Array<{
  path: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
}>> {
  try {
    const ports = await SerialPort.list();
    return ports.map((port: { path: string; manufacturer?: string; vendorId?: string; productId?: string }) => ({
      path: port.path,
      manufacturer: port.manufacturer,
      vendorId: port.vendorId,
      productId: port.productId
    }));
  } catch (error) {
    console.error('Error detecting serial ports:', error);
    return [];
  }
}

// Global serial connections map
let serialConnections: Map<string, { port: RealSerialPort; config: SerialConnection }> = new Map();

// Tool handlers for serial connection operations
type ToolHandler = (params: any) => Promise<any>;

export const serialConnectionToolHandlers: Record<string, ToolHandler> = {
  // 1. List Available Serial Ports
  async serial_list_ports(params) {
    try {
      const availablePorts = await getAvailableSerialPorts();

      if (availablePorts.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No serial ports detected.\n\nTroubleshooting:\n- Make sure USB-to-Serial adapter is connected\n- Check that drivers are installed (FTDI, CH340, CP210x)\n- On Linux, ensure user is in 'dialout' group`
          }]
        };
      }

      const portList = availablePorts.map(p => {
        let info = p.path;
        if (p.manufacturer) info += ` (${p.manufacturer})`;
        return info;
      }).join('\n');

      return {
        content: [{
          type: 'text',
          text: `Available Serial Ports:\n\n${portList}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Serial port detection error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 2. Connect to Serial Port
  async serial_connect(params) {
    const {
      port,
      baudRate = 9600,
      dataBits = 8,
      stopBits = 1,
      parity = 'none',
      flowControl = false,
      timeout = 30000,
      connectionId = `serial-${Date.now()}`,
      deviceType = 'generic'
    } = params;

    try {
      // Check if connection already exists
      if (serialConnections.has(connectionId)) {
        return {
          content: [{ type: 'text', text: `Serial connection with ID ${connectionId} already exists` }],
          isError: true
        };
      }

      // Use predefined settings if deviceType is specified
      const settings = SerialPortSettings[deviceType as keyof typeof SerialPortSettings] || SerialPortSettings.generic;

      const serialConfig: SerialConnection = {
        id: connectionId,
        port,
        baudRate: baudRate || settings.baudRate,
        dataBits: (dataBits || settings.dataBits) as 8 | 7 | 6 | 5,
        stopBits: (stopBits || settings.stopBits) as 1 | 2,
        parity: (parity || settings.parity) as 'none' | 'even' | 'odd' | 'mark' | 'space',
        flowControl: flowControl !== undefined ? flowControl : settings.flowControl,
        timeout: timeout || settings.timeout,
        connected: false,
        deviceType,
        currentMode: 'unknown',
        lastActivity: new Date()
      };

      // Create and open real serial port connection
      const serialPort = new RealSerialPort(port, {
        baudRate: serialConfig.baudRate,
        dataBits: serialConfig.dataBits,
        stopBits: serialConfig.stopBits,
        parity: serialConfig.parity
      });

      await serialPort.open();

      serialConfig.connected = true;
      serialConnections.set(connectionId, { port: serialPort, config: serialConfig });

      // Send a carriage return to wake up the device and detect mode
      await serialPort.write('\r\n');
      const initialResponse = await serialPort.read(3000);
      serialConfig.currentMode = serialPort.detectMode(initialResponse);
      serialConfig.lastPrompt = initialResponse.trim().split('\n').pop() || '';

      return {
        content: [{
          type: 'text',
          text: `Successfully connected to serial port ${port}\nConnection ID: ${connectionId}\nSettings: ${serialConfig.baudRate} baud, ${serialConfig.dataBits}${serialConfig.parity.charAt(0).toUpperCase()}${serialConfig.stopBits}\nDetected Mode: ${serialConfig.currentMode}\nPrompt: ${serialConfig.lastPrompt}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Serial connection failed: ${error.message}` }],
        isError: true
      };
    }
  },

  // 3. Send Command via Serial
  async serial_send_command(params) {
    const { connectionId, command, waitForResponse = true, timeout = 10000 } = params;

    try {
      if (!serialConnections.has(connectionId)) {
        throw new Error(`No active serial connection with ID: ${connectionId}`);
      }

      const { port, config } = serialConnections.get(connectionId)!;

      if (!port.isConnected) {
        throw new Error('Serial port is not connected');
      }

      config.lastActivity = new Date();

      let response = '';
      if (waitForResponse) {
        response = await port.sendCommand(command, timeout);
        config.currentMode = port.detectMode(response);
        config.lastPrompt = response.trim().split('\n').pop() || '';
      } else {
        await port.write(command + '\r\n');
        response = '(command sent, not waiting for response)';
      }

      return {
        content: [{
          type: 'text',
          text: `Command: ${command}\n\nResponse:\n${response}\n\nCurrent Mode: ${config.currentMode}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Serial command error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 4. Enter Enable Mode
  async serial_enter_enable(params) {
    const { connectionId, enablePassword } = params;

    try {
      if (!serialConnections.has(connectionId)) {
        throw new Error(`No active serial connection with ID: ${connectionId}`);
      }

      const { port, config } = serialConnections.get(connectionId)!;

      if (!port.isConnected) {
        throw new Error('Serial port is not connected');
      }

      // Check if already in enable or config mode
      if (config.currentMode === 'enable' || config.currentMode === 'config') {
        return {
          content: [{
            type: 'text',
            text: `Already in ${config.currentMode} mode`
          }]
        };
      }

      // Send enable command
      await port.write('enable\r\n');
      let response = await port.read(5000);

      // Check if password is required
      if (PROMPT_PATTERNS.password.test(response)) {
        if (!enablePassword) {
          return {
            content: [{
              type: 'text',
              text: `Enable password required. Please provide enablePassword parameter.`
            }],
            isError: true
          };
        }

        await port.write(enablePassword + '\r\n');
        response = await port.read(5000);
      }

      config.currentMode = port.detectMode(response);
      config.lastPrompt = response.trim().split('\n').pop() || '';
      config.lastActivity = new Date();

      if (config.currentMode === 'enable') {
        return {
          content: [{
            type: 'text',
            text: `Successfully entered enable mode\nPrompt: ${config.lastPrompt}`
          }]
        };
      } else {
        return {
          content: [{
            type: 'text',
            text: `Failed to enter enable mode. Current mode: ${config.currentMode}\nResponse: ${response}`
          }],
          isError: true
        };
      }
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Enter enable mode error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 5. Enter Config Mode
  async serial_enter_config(params) {
    const { connectionId } = params;

    try {
      if (!serialConnections.has(connectionId)) {
        throw new Error(`No active serial connection with ID: ${connectionId}`);
      }

      const { port, config } = serialConnections.get(connectionId)!;

      if (!port.isConnected) {
        throw new Error('Serial port is not connected');
      }

      // Must be in enable mode first
      if (config.currentMode !== 'enable' && config.currentMode !== 'config') {
        return {
          content: [{
            type: 'text',
            text: `Must be in enable mode to enter config mode. Current mode: ${config.currentMode}`
          }],
          isError: true
        };
      }

      if (config.currentMode === 'config') {
        return {
          content: [{
            type: 'text',
            text: `Already in config mode`
          }]
        };
      }

      // Send configure terminal command
      const response = await port.sendCommand('configure terminal', 5000);
      config.currentMode = port.detectMode(response);
      config.lastPrompt = response.trim().split('\n').pop() || '';
      config.lastActivity = new Date();

      return {
        content: [{
          type: 'text',
          text: `Entered config mode\nPrompt: ${config.lastPrompt}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Enter config mode error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 6. Exit Current Mode
  async serial_exit_mode(params) {
    const { connectionId } = params;

    try {
      if (!serialConnections.has(connectionId)) {
        throw new Error(`No active serial connection with ID: ${connectionId}`);
      }

      const { port, config } = serialConnections.get(connectionId)!;

      if (!port.isConnected) {
        throw new Error('Serial port is not connected');
      }

      const response = await port.sendCommand('exit', 5000);
      config.currentMode = port.detectMode(response);
      config.lastPrompt = response.trim().split('\n').pop() || '';
      config.lastActivity = new Date();

      return {
        content: [{
          type: 'text',
          text: `Exited mode. Current mode: ${config.currentMode}\nPrompt: ${config.lastPrompt}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Exit mode error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 7. Serial Device Discovery
  async serial_discover_device(params) {
    const { connectionId } = params;

    try {
      if (!serialConnections.has(connectionId)) {
        throw new Error(`No active serial connection with ID: ${connectionId}`);
      }

      const { port, config } = serialConnections.get(connectionId)!;

      // Send show version command
      const versionResponse = await port.sendCommand('show version', 15000);

      // Detect device type from response
      const lowerResponse = versionResponse.toLowerCase();
      if (lowerResponse.includes('cisco') && lowerResponse.includes('ios xe')) {
        config.deviceType = 'cisco-ios-xe';
      } else if (lowerResponse.includes('cisco')) {
        config.deviceType = 'cisco-ios';
      } else if (lowerResponse.includes('aruba') || lowerResponse.includes('procurve') || lowerResponse.includes('hewlett')) {
        config.deviceType = 'aruba';
      } else {
        config.deviceType = 'unknown';
      }

      config.currentMode = port.detectMode(versionResponse);
      config.lastActivity = new Date();

      return {
        content: [{
          type: 'text',
          text: `Device Discovery Results:\n\nDetected Device Type: ${config.deviceType}\nCurrent Mode: ${config.currentMode}\n\nShow Version Output:\n${versionResponse}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Serial device discovery error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 8. List Active Serial Connections
  async serial_list_connections(params) {
    try {
      const connections = Array.from(serialConnections.entries()).map(([id, { config }]) => ({
        id,
        port: config.port,
        baudRate: config.baudRate,
        deviceType: config.deviceType,
        currentMode: config.currentMode,
        connected: config.connected,
        lastPrompt: config.lastPrompt,
        lastActivity: config.lastActivity?.toISOString()
      }));

      return {
        content: [{
          type: 'text',
          text: `Active Serial Connections:\n\n${connections.length > 0 ? JSON.stringify(connections, null, 2) : 'No active serial connections'}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Serial connection list error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 9. Disconnect Serial Port
  async serial_disconnect(params) {
    const { connectionId } = params;

    try {
      if (!serialConnections.has(connectionId)) {
        return {
          content: [{ type: 'text', text: `No active serial connection with ID: ${connectionId}` }],
          isError: true
        };
      }

      const { port, config } = serialConnections.get(connectionId)!;

      await port.close();
      serialConnections.delete(connectionId);

      return {
        content: [{
          type: 'text',
          text: `Disconnected from serial port ${config.port} (Connection ID: ${connectionId})`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Serial disconnect error: ${error.message}` }],
        isError: true
      };
    }
  },

  // 10. Send Interactive Command (handles confirmations)
  async serial_send_interactive(params) {
    const { connectionId, command, confirmResponse = 'yes', timeout = 30000 } = params;

    try {
      if (!serialConnections.has(connectionId)) {
        throw new Error(`No active serial connection with ID: ${connectionId}`);
      }

      const { port, config } = serialConnections.get(connectionId)!;

      if (!port.isConnected) {
        throw new Error('Serial port is not connected');
      }

      await port.write(command + '\r\n');

      let fullResponse = '';
      const startTime = Date.now();

      while (Date.now() - startTime < timeout) {
        const response = await port.read(5000);
        fullResponse += response;

        // Handle confirmation prompts
        if (PROMPT_PATTERNS.confirm.test(response)) {
          await port.write(confirmResponse + '\r\n');
          continue;
        }

        // Handle --More-- prompts
        if (PROMPT_PATTERNS.morePrompt.test(response)) {
          await port.write(' ');
          continue;
        }

        // Check if we got a command prompt (response complete)
        if (PROMPT_PATTERNS.user.test(response) ||
          PROMPT_PATTERNS.enable.test(response) ||
          PROMPT_PATTERNS.config.test(response)) {
          break;
        }
      }

      config.currentMode = port.detectMode(fullResponse);
      config.lastPrompt = fullResponse.trim().split('\n').pop() || '';
      config.lastActivity = new Date();

      return {
        content: [{
          type: 'text',
          text: `Interactive Command: ${command}\n\nResponse:\n${fullResponse}\n\nCurrent Mode: ${config.currentMode}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Interactive command error: ${error.message}` }],
        isError: true
      };
    }
  }
};

// Tool schema definitions for serial connection tools
/**
 * Add serial connection tools to the MCP SSH server
 */
export function addSerialConnectionTools(server: McpServer) {
  console.error("Serial connection tools loaded (real serialport implementation)");

  server.tool(
    'serial_list_ports',
    'List available USB-to-Serial ports on the system',
    {},
    async (args) => serialConnectionToolHandlers.serial_list_ports(args)
  );

  server.tool(
    'serial_connect',
    'Connect to a network device via USB-to-Serial console port',
    {
      port: z.string().describe('Serial port name (e.g., COM3, /dev/ttyUSB0)'),
      baudRate: z.number().optional().describe('Baud rate (default: 9600)'),
      dataBits: z.number().optional().describe('Data bits (default: 8)'),
      stopBits: z.number().optional().describe('Stop bits (default: 1)'),
      parity: z.string().optional().describe('Parity (none, even, odd, mark, space - default: none)'),
      flowControl: z.boolean().optional().describe('Enable flow control (default: false)'),
      timeout: z.number().optional().describe('Connection timeout in milliseconds (default: 30000)'),
      connectionId: z.string().optional().describe('Unique identifier for this connection'),
      deviceType: z.string().optional().describe('Device type for optimal settings (cisco, aruba, generic)')
    },
    async (args) => serialConnectionToolHandlers.serial_connect(args)
  );

  server.tool(
    'serial_send_command',
    'Send a command to network device via serial connection',
    {
      connectionId: z.string().describe('ID of an active serial connection'),
      command: z.string().describe('Command to send to the device'),
      waitForResponse: z.boolean().optional().describe('Wait for device response (default: true)'),
      timeout: z.number().optional().describe('Response timeout in milliseconds (default: 10000)')
    },
    async (args) => serialConnectionToolHandlers.serial_send_command(args)
  );

  server.tool(
    'serial_enter_enable',
    'Enter privileged (enable) mode on the switch',
    {
      connectionId: z.string().describe('ID of an active serial connection'),
      enablePassword: z.string().optional().describe('Enable password (if required)')
    },
    async (args) => serialConnectionToolHandlers.serial_enter_enable(args)
  );

  server.tool(
    'serial_enter_config',
    'Enter configuration mode on the switch (must be in enable mode)',
    {
      connectionId: z.string().describe('ID of an active serial connection')
    },
    async (args) => serialConnectionToolHandlers.serial_enter_config(args)
  );

  server.tool(
    'serial_exit_mode',
    'Exit current mode (config -> enable -> user)',
    {
      connectionId: z.string().describe('ID of an active serial connection')
    },
    async (args) => serialConnectionToolHandlers.serial_exit_mode(args)
  );

  server.tool(
    'serial_discover_device',
    'Discover device type and capabilities via serial connection',
    {
      connectionId: z.string().describe('ID of an active serial connection')
    },
    async (args) => serialConnectionToolHandlers.serial_discover_device(args)
  );

  server.tool(
    'serial_list_connections',
    'List all active serial connections',
    {},
    async (args) => serialConnectionToolHandlers.serial_list_connections(args)
  );

  server.tool(
    'serial_disconnect',
    'Disconnect from a serial port',
    {
      connectionId: z.string().describe('ID of an active serial connection')
    },
    async (args) => serialConnectionToolHandlers.serial_disconnect(args)
  );

  server.tool(
    'serial_send_interactive',
    'Send command with automatic handling of confirmations and paging',
    {
      connectionId: z.string().describe('ID of an active serial connection'),
      command: z.string().describe('Command to send'),
      confirmResponse: z.string().optional().describe('Response to confirmation prompts (default: yes)'),
      timeout: z.number().optional().describe('Total timeout in milliseconds (default: 30000)')
    },
    async (args) => serialConnectionToolHandlers.serial_send_interactive(args)
  );

  return {
    toolHandlers: serialConnectionToolHandlers,
    getSerialConnections: () => serialConnections
  };
}
