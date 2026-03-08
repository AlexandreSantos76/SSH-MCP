/**
 * Ubuntu Website Management Tools for MCP SSH Server
 *
 * Extended tools specifically for managing Ubuntu web servers
 * and website deployments. This module provides specialized tools for managing
 * Nginx, system packages, SSL certificates, website deployments, and firewalls
 * on Ubuntu servers.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from "ssh2";
export declare const ubuntuToolHandlers: Record<string, (params: any) => Promise<any>>;
/**
 * Add Ubuntu website management tools to the MCP SSH server
 */
export declare function addUbuntuTools(server: McpServer, connections: Map<string, {
    conn: Client;
    config: any;
}>): void;
