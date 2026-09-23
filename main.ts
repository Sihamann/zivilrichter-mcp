import {
  createMcpHandler,
  McpServer,
} from "npm:@modelcontextprotocol/server@2.0.0";

import * as z from "npm:zod@4";

const handler = createMcpHandler(() => {
  const server = new McpServer(
    {
      name: "zivilrichter-mcp",
      version: "0.1.0",
    },
    {
      instructions:
        "MCP-Server für juristische Recherchetools des Zivilrichter-Plugins.",
    },
  );

  server.registerTool(
    "ping",
    {
      description:
        "Prüft, ob der Zivilrichter-MCP-Server erreichbar und funktionsfähig ist.",
      inputSchema: z.object({
        text: z.string().optional(),
      }),
    },
    async ({ text }) => ({
      content: [
        {
          type: "text",
          text: text
            ? `Zivilrichter MCP läuft. Eingabe: ${text}`
            : "Zivilrichter MCP läuft.",
        },
      ],
    }),
  );

  return server;
});

export default handler;
