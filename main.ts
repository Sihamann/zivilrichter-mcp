import {
  createMcpHandler,
  McpServer,
} from "npm:@modelcontextprotocol/server@2.0.0";

import * as z from "npm:zod@4/v4";


// ============================================================
// KONFIGURATION
// ============================================================
//
// Hier tragen wir später die URLs Ihrer bereits vorhandenen
// Deno-Proxys ein.
//
// Empfehlenswert: nicht fest in den Code schreiben, sondern
// als Environment Variables in Deno Deploy hinterlegen.
//
// Beispiel:
// LANDESRECHT_SEARCH_URL
// https://.....deno.net/search
//
// LANDESRECHT_DOCUMENT_URL
// https://.....deno.net/document
//

const LANDESRECHT_SEARCH_URL =
  Deno.env.get("LANDESRECHT_SEARCH_URL") ?? "";

const LANDESRECHT_DOCUMENT_URL =
  Deno.env.get("LANDESRECHT_DOCUMENT_URL") ?? "";


// ============================================================
// HILFSFUNKTION
// ============================================================

async function postJson(
  url: string,
  body: Record<string, unknown>,
): Promise<unknown> {

  if (!url) {
    throw new Error(
      "Proxy-URL ist noch nicht konfiguriert.",
    );
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Proxy antwortete mit HTTP ${response.status}: ${text}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      rawText: text,
    };
  }
}


function asToolResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}


function asToolError(error: unknown) {
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
// MCP SERVER
// ============================================================

const handler = createMcpHandler(() => {

  const server = new McpServer(
    {
      name: "zivilrichter-mcp",
      version: "0.2.0",
    },
    {
      instructions: `
Dieser MCP-Server stellt Recherchewerkzeuge für deutsches Recht
und insbesondere deutsches Zivilprozessrecht bereit.

Suchtreffer und Trefferlisten dienen zunächst nur der Recherche.

Soweit eine Gerichtsentscheidung tragend verwendet werden soll,
ist nach Möglichkeit der Volltext abzurufen und zu prüfen.

Bei Landesrecht Baden-Württemberg soll nach einer Suche ein
relevanter Treffer mit get_landesrecht_bw_document vollständig
abgerufen werden.

Unsichere Fundstellen dürfen nicht als verifizierte Primärquelle
behandelt werden.
      `.trim(),
    },
  );


  // ==========================================================
  // 1. PING
  // ==========================================================

  server.registerTool(
    "ping",
    {
      title: "Zivilrichter MCP testen",

      description:
        "Prüft, ob der Zivilrichter-MCP-Server erreichbar und funktionsfähig ist.",

      inputSchema: z.object({
        text: z
          .string()
          .optional()
          .describe("Optionaler Text für den Funktionstest"),
      }),

      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },

    async ({ text }) => {
      return {
        content: [
          {
            type: "text",
            text: text
              ? `Zivilrichter MCP läuft. Eingabe: ${text}`
              : "Zivilrichter MCP läuft.",
          },
        ],
      };
    },
  );


  // ==========================================================
  // 2. LANDESRECHT BW SUCHEN
  // ==========================================================

  server.registerTool(
    "search_landesrecht_bw",
    {
      title: "Landesrecht Baden-Württemberg durchsuchen",

      description: `
Sucht in Landesrecht Baden-Württemberg nach Rechtsprechung,
Gesetzen oder Verwaltungsvorschriften.

Die Trefferliste dient der Recherche. Für eine tragende Aussage
aus einer Gerichtsentscheidung soll anschließend der relevante
Treffer mit get_landesrecht_bw_document im Volltext abgerufen
werden.
      `.trim(),

      inputSchema: z.object({

        query: z
          .string()
          .min(1)
          .describe(
            "Suchtext, zum Beispiel 'Beweiswürdigung Mietmangel'",
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
            "Kategorie der Suche",
          ),

        maxResults: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(5)
          .describe(
            "Maximale Zahl der Treffer pro Seite",
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

        const result = await postJson(
          LANDESRECHT_SEARCH_URL,
          {
            query,
            category,
            maxResults,
            page,
          },
        );

        return asToolResult(result);

      } catch (error) {

        return asToolError(error);

      }
    },
  );


  // ==========================================================
  // 3. LANDESRECHT BW VOLLTEXT
  // ==========================================================

  server.registerTool(
    "get_landesrecht_bw_document",
    {
      title: "Landesrecht-BW-Dokument abrufen",

      description: `
Ruft den Volltext eines zuvor über search_landesrecht_bw
gefundenen Dokuments aus Landesrecht Baden-Württemberg ab.

Die Dokument-ID und docPart müssen exakt aus dem Suchtreffer
übernommen werden.
      `.trim(),

      inputSchema: z.object({

        id: z
          .string()
          .min(1)
          .describe(
            "Dokument-ID aus dem Suchergebnis",
          ),

        docPart: z
          .string()
          .min(1)
          .describe(
            "docPart aus dem Suchergebnis, typischerweise L oder S",
          ),

        maxCharacters: z
          .number()
          .int()
          .min(1000)
          .max(80000)
          .default(30000)
          .describe(
            "Maximale Länge des abzurufenden Volltexts",
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

        const result = await postJson(
          LANDESRECHT_DOCUMENT_URL,
          {
            id,
            docPart,
            maxCharacters,
          },
        );

        return asToolResult(result);

      } catch (error) {

        return asToolError(error);

      }
    },
  );


  return server;
});


// ============================================================
// DENO DEPLOY
// ============================================================

export default handler;
