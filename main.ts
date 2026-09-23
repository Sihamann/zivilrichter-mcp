import {
  createMcpHandler,
  McpServer,
} from "npm:@modelcontextprotocol/server@2.0.0";

import * as z from "npm:zod@4";


const LANDESRECHT_BASE =
  "https://laend.sihamann.deno.net";

const ZPOBLOG_BASE =
  "https://100.sihamann.deno.net";


// Falls Ihr ZPO-Blog-Proxy ACTION_API_KEY verwendet:
// denselben Wert im MCP-Projekt als ZPOBLOG_API_KEY hinterlegen.
const ZPOBLOG_API_KEY =
  Deno.env.get("ZPOBLOG_API_KEY") ?? "";


// ============================================================
// HTTP-Hilfsfunktion
// ============================================================

async function getJson(
  base: string,
  path: string,
  params: Record<
    string,
    string | number | boolean | undefined
  > = {},
  headers: Record<string, string> = {},
): Promise<unknown> {

  const url = new URL(path, base);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...headers,
    },
    signal: AbortSignal.timeout(30000),
  });

  const text = await response.text();

  let data: unknown;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Ungültige JSON-Antwort von ${url}: ${text}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} von ${url}: ${text}`,
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


function zpoBlogHeaders(): Record<string, string> {
  if (!ZPOBLOG_API_KEY) {
    return {};
  }

  return {
    "x-api-key": ZPOBLOG_API_KEY,
  };
}


// ============================================================
// MCP-SERVER
// ============================================================

const handler = createMcpHandler(() => {

  const server = new McpServer(
    {
      name: "zivilrichter-mcp",
      version: "0.3.0",
    },
    {
      instructions: `
Dieser MCP-Server stellt Recherchewerkzeuge für deutsches Recht
und insbesondere deutsches Zivilprozessrecht bereit.

Quellen sind nach ihrem Quellenwert zu behandeln.

Landesrecht Baden-Württemberg kann Primärtexte und amtliche
beziehungsweise justizielle Inhalte bereitstellen.

Der ZPO-Blog ist eine praxisnahe Sekundärquelle. Aussagen daraus
dürfen die Recherche und Argumentationsstruktur unterstützen,
sollen aber für tragende Rechtsaussagen nach Möglichkeit anhand
von Gesetz und Primärquellen gegengeprüft werden.

Suchtreffer und Snippets allein sind nicht als vollständig
verifizierter Entscheidungsinhalt zu behandeln.

Bei Gerichtsentscheidungen sollen Gericht, Datum, Aktenzeichen
und tragender Entscheidungskontext vor einer tragenden Verwendung
geprüft werden.
      `.trim(),
    },
  );


  // ==========================================================
  // 1. PING
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
  // LANDESRECHT BADEN-WÜRTTEMBERG
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
        const result = await getJson(
          LANDESRECHT_BASE,
          "/health",
        );

        return toolResult(result);

      } catch (error) {
        return toolError(error);
      }
    },
  );


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
          .max(500),

        category: z
          .enum([
            "all",
            "Rechtsprechung",
            "Gesetze",
            "VV",
          ])
          .default("all"),

        maxResults: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(5),

        page: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(1),
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
          LANDESRECHT_BASE,
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
          .max(180),

        docPart: z
          .string()
          .min(1)
          .max(8)
          .default("L"),

        maxCharacters: z
          .number()
          .int()
          .min(1000)
          .max(80000)
          .default(30000),
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
          LANDESRECHT_BASE,
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


  // ==========================================================
  // ZPO-BLOG
  // ==========================================================

  server.registerTool(
    "health_zpo_blog",
    {
      description:
        "Prüft, ob der vorhandene ZPO-Blog-Proxy erreichbar ist.",

      inputSchema: z.object({}),

      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },

    async () => {

      try {

        const result = await getJson(
          ZPOBLOG_BASE,
          "/health",
        );

        return toolResult(result);

      } catch (error) {
        return toolError(error);
      }
    },
  );


  server.registerTool(
    "search_zpo_blog",
    {
      description: `
Sucht über die offizielle ZPO-Blog-Suchseite des Anwaltsblatts.

Der ZPO-Blog ist eine Sekundärquelle.

Mit includeFullText=true werden zusätzlich Artikeltexte,
Autor und Beitragsdatum geladen. Bei vielen Treffern kann dies
deutlich aufwendiger sein.

Für die erste Recherche regelmäßig mit mode="all" und wenigen
Ergebnisseiten beginnen.
      `.trim(),

      inputSchema: z.object({

        query: z
          .string()
          .min(2)
          .max(500)
          .describe(
            "Suchbegriff oder mehrere Suchwörter",
          ),

        mode: z
          .enum([
            "all",
            "any",
            "or",
            "literal",
          ])
          .default("all")
          .describe(
            "all = alle Wörter; any/or = mindestens eines; literal = genaue Wortfolge",
          ),

        maxPages: z
          .number()
          .int()
          .min(1)
          .max(5)
          .default(2),

        maxResults: z
          .number()
          .int()
          .min(1)
          .max(80)
          .default(25),

        includeFullText: z
          .boolean()
          .default(false),

        maxFullTextCharacters: z
          .number()
          .int()
          .min(1000)
          .max(20000)
          .default(8000),
      }),

      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },

    async ({
      query,
      mode,
      maxPages,
      maxResults,
      includeFullText,
      maxFullTextCharacters,
    }) => {

      try {

        const result = await getJson(
          ZPOBLOG_BASE,
          "/search",
          {
            query,
            mode,
            maxPages,
            maxResults,
            includeFullText,
            maxFullTextCharacters,
          },
          zpoBlogHeaders(),
        );

        return toolResult(result);

      } catch (error) {
        return toolError(error);
      }
    },
  );


  server.registerTool(
    "get_zpo_blog_article",
    {
      description: `
Ruft einen einzelnen ZPO-Blog-Beitrag ab.

Die URL muss von anwaltsblatt.anwaltverein.de stammen und auf
einen konkreten ZPO-Blog-Beitrag zeigen.

Der Abruf liefert insbesondere Titel, Beitragsdatum, Autor,
Schlagwörter und Text. truncated=true bedeutet, dass der
zurückgegebene Text wegen der Zeichenbegrenzung gekürzt wurde.
      `.trim(),

      inputSchema: z.object({

        url: z
          .string()
          .min(5)
          .describe(
            "Vollständige URL eines ZPO-Blog-Beitrags",
          ),

        maxCharacters: z
          .number()
          .int()
          .min(1000)
          .max(20000)
          .default(8000),
      }),

      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },

    async ({
      url,
      maxCharacters,
    }) => {

      try {

        const result = await getJson(
          ZPOBLOG_BASE,
          "/article",
          {
            url,
            maxCharacters,
          },
          zpoBlogHeaders(),
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
