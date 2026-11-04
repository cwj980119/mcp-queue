import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const server=new McpServer({name:'fixture-documents',version:'1'});
server.registerTool('read',{},async()=>({content:[{type:'text',text:'DOC-42 fixture document'}]}));
server.registerTool('delete_document',{},async()=>({content:[{type:'text',text:'Forbidden write was executed'}]}));
await server.connect(new StdioServerTransport());
