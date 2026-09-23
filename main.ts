import {
  createMcpHandler,
  McpServer,
} from "npm:@modelcontextprotocol/server@2.0.0";

import * as z from "npm:zod@4";


const LANDESRECHT_BASE =
  "https://laend.sihamann.deno.net";


// ============================================================
// Hilfsfunktion für vorhandenen Landesrecht-BW-Proxy
// ============================================================

async function getJson(
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<unknown> {
  const url = new URL(path, LANDESRECHT_BASE);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(30000),
  });

  const text = await response.text();

  let data: unknown;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Ungültige Antwort des Landesrecht-BW-Proxys: ${text}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Landesrecht-BW-Proxy: HTTP ${response.status}: ${text}`,
    );
  }

  return data;
}


function toolResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}


function toolError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  return {
    content: [
      {
        type: "text" as const,
        text: `Fehler: ${message}`,
      },
    ],
    isError: true,
  };
}


// ============================================================
// MCP Server
// ============================================================

const handler = createMcpHandler(() => {
  const server = new McpServer(
    {
      name: "zivilrichter-mcp",
      version: "0.2.0",
    },
    {
      instructions: `
Dieser MCP-Server stellt Recherchewerkzeuge für den
Zivilrichter bereit.

Trefferlisten und Snippets aus Landesrecht Baden-Württemberg
dienen zunächst nur der Recherche.

Soll eine Gerichtsentscheidung tragend verwendet werden,
ist nach Möglichkeit anschließend der Volltext mit
get_landesrecht_bw_document abzurufen.

Gericht, Datum, Aktenzeichen und Entscheidungskontext sind
vor einer tragenden Verwendung zu prüfen.
      `.trim(),
    },
  );


  // ==========================================================
  // 1. MCP-Funktionstest
  // ==========================================================

  server.registerTool(
    "ping",
    {
      description:
        "Prüft, ob der Zivilrichter-MCP-Server erreichbar ist.",

      inputSchema: z.object({
        text: z.string().optional(),
      }),

      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
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


  // ==========================================================
  // 2. Landesrecht-BW Healthcheck
  // ==========================================================

  server.registerTool(
    "health_landesrecht_bw",
    {
      description:
        "Prüft, ob der vorhandene Landesrecht-BW-Proxy erreichbar ist.",

      inputSchema: z.object({}),

      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },

    async () => {
      try {
        const result = await getJson("/health");
        return toolResult(result);
      } catch (error) {
        return toolError(error);
      }
    },
  );


  // ==========================================================
  // 3. Landesrecht Baden-Württemberg durchsuchen
  // ==========================================================

  server.registerTool(
    "search_landesrecht_bw",
    {
      description: `
Sucht in Landesrecht Baden-Württemberg nach Rechtsprechung,
Gesetzen oder Verwaltungsvorschriften.

Für eine tragende Verwendung einer Gerichtsentscheidung soll
anschließend der Volltext mit
get_landesrecht_bw_document abgerufen werden.
      `.trim(),

      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "Suchtext, z. B. '§ 139 ZPO' oder 'Beweiswürdigung Mietmangel'",
          ),

        category: z
          .enum([
            "all",
            "Rechtsprechung",
            "Gesetze",
            "VV",
          ])
          .default("all")
          .describe(
            "Kategorie: all, Rechtsprechung, Gesetze oder VV",
          ),

        maxResults: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(5)
          .describe(
            "Maximale Zahl der Treffer",
          ),

        page: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(1)
          .describe(
            "Trefferseite",
          ),
      }),

      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },

    async ({
      query,
      category,
      maxResults,
      page,
    }) => {
      try {
        const result = await getJson(
          "/search",
          {
            query,
            category,
            maxResults,
            page,
          },
        );

        return toolResult(result);
      } catch (error) {
        return toolError(error);
      }
    },
  );


  // ==========================================================
  // 4. Dokument aus Landesrecht BW abrufen
  // ==========================================================

  server.registerTool(
    "get_landesrecht_bw_document",
    {
      description: `
Ruft den Volltext eines zuvor mit search_landesrecht_bw
gefundenen Dokuments ab.

id und docPart müssen aus dem Suchtreffer übernommen werden.
      `.trim(),

      inputSchema: z.object({
        id: z
          .string()
          .min(1)
          .max(180)
          .describe(
            "Dokument-ID aus dem Suchtreffer",
          ),

        docPart: z
          .string()
          .min(1)
          .max(8)
          .default("L")
          .describe(
            "Dokumentteil aus dem Suchtreffer, häufig L",
          ),

        maxCharacters: z
          .number()
          .int()
          .min(1000)
          .max(80000)
          .default(30000)
          .describe(
            "Maximale Zahl zurückzugebender Zeichen",
          ),
      }),

      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },

    async ({
      id,
      docPart,
      maxCharacters,
    }) => {
      try {
        const result = await getJson(
          "/document",
          {
            id,
            docPart,
            maxCharacters,
          },
        );

        return toolResult(result);
      } catch (error) {
        return toolError(error);
      }
    },
  );


  return server;
});


export default handler;
