import {
  createMcpHandler,
  McpServer,
} from "npm:@modelcontextprotocol/server@2.0.0"

import * as z from "npm:zod@4"

import {
  DOMParser,
} from "jsr:@b-fuze/deno-dom@0.1.56"


// ============================================================
// BASIS-URLS
// ============================================================

const LANDESRECHT_BASE =
  "https://laend.sihamann.deno.net"

const ZPOBLOG_BASE =
  "https://100.sihamann.deno.net"

const BGHEUTE_BASE =
  "https://bgheute.de"


const BUZER_BASE =
  "https://www.buzer.de"


// ============================================================
// SECRETS
// ============================================================

// Nur erforderlich, wenn der bestehende ZPO-Blog-Proxy
// ACTION_API_KEY verwendet.
const ZPOBLOG_API_KEY =
  Deno.env.get("ZPOBLOG_API_KEY") ?? ""



// ============================================================
// URL- UND HTTP-HILFSFUNKTIONEN
// ============================================================

function buildUrl(
  base: string,
  path: string,
): URL {
  // Basis immer mit "/" abschließen und führende
  // Slashes des relativen Pfades entfernen.
  const normalizedBase =
    base.endsWith("/")
      ? base
      : `${base}/`

  const normalizedPath =
    path.replace(/^\/+/, "")

  return new URL(
    normalizedPath,
    normalizedBase,
  )
}




async function getJson(
  base: string,
  path: string,
  params: Record<
    string,
    string | number | boolean | undefined
  > = {},
  headers: Record<string, string> = {},
): Promise<any> {
  const url =
    buildUrl(base, path)

  for (
    const [key, value]
    of Object.entries(params)
  ) {
    if (value !== undefined) {
      url.searchParams.set(
        key,
        String(value),
      )
    }
  }

  const response =
    await fetch(
      url,
      {
        method: "GET",

        headers: {
          Accept: "application/json",
          ...headers,
        },

        signal:
          AbortSignal.timeout(30000),
      },
    )

  const text =
    await response.text()

  let data: any

  try {
    data =
      JSON.parse(text)
  } catch {
    throw new Error(
      `Ungültige JSON-Antwort von ${url.toString()}: ` +
      text.slice(0, 1200),
    )
  }

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} von ${url.toString()}: ` +
      text.slice(0, 1800),
    )
  }

  return data
}


// ============================================================
// MCP-RÜCKGABEN
// ============================================================

function toolResult(
  data: unknown,
) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          JSON.stringify(
            data,
            null,
            2,
          ),
      },
    ],
  }
}


function toolError(
  error: unknown,
) {
  const message =
    error instanceof Error
      ? error.message
      : String(error)

  return {
    content: [
      {
        type: "text" as const,
        text:
          `Fehler: ${message}`,
      },
    ],

    isError: true,
  }
}


// ============================================================
// AUTH-HEADER
// ============================================================

function zpoBlogHeaders():
  Record<string, string> {
  if (!ZPOBLOG_API_KEY) {
    return {}
  }

  return {
    "x-api-key":
      ZPOBLOG_API_KEY,
  }
}



// ============================================================
// BGH-DATEN AUFBEREITEN
// ============================================================
//
// BGHeute ist ein privater Rechercheindex.
// Etwaige KI-Zusammenfassungen werden bewusst entfernt.
//

function slimBghDecision(
  decision: any,
  previewCharacters = 2000,
) {
  if (
    !decision ||
    typeof decision !== "object"
  ) {
    return decision
  }

  const text =
    typeof decision.urteilstext
      === "string"
      ? decision.urteilstext
      : ""

  const {
    urteilstext,
    ai_summary,
    ...rest
  } = decision

  return {
    ...rest,

    urteilstextPreview:
      text.length > previewCharacters
        ? text.slice(
            0,
            previewCharacters,
          ) + "…"
        : text,

    urteilstextCharacters:
      text.length,

    urteilstextTruncated:
      text.length > previewCharacters,
  }
}


function slimBghPayload(
  data: any,
) {
  if (
    !data ||
    typeof data !== "object"
  ) {
    return data
  }

  if (
    !Array.isArray(
      data.decisions,
    )
  ) {
    return data
  }

  return {
    ...data,

    decisions:
      data.decisions.map(
        (decision: any) =>
          slimBghDecision(
            decision,
          ),
      ),
  }
}


function fullBghDecision(
  decision: any,
  maxCharacters: number,
) {
  if (
    !decision ||
    typeof decision !== "object"
  ) {
    return decision
  }

  const text =
    typeof decision.urteilstext
      === "string"
      ? decision.urteilstext
      : ""

  const {
    urteilstext,
    ai_summary,
    ...rest
  } = decision

  return {
    ...rest,

    urteilstext:
      text.length > maxCharacters
        ? text.slice(
            0,
            maxCharacters,
          )
        : text,

    totalCharacters:
      text.length,

    truncated:
      text.length > maxCharacters,
  }
}


// ============================================================
// BUZER-HILFSFUNKTIONEN
// ============================================================

function cleanPlainText(
  text: string,
): string {
  return text
    .replace(
      /\u00a0/g,
      " ",
    )
    .replace(
      /[ \t]+/g,
      " ",
    )
    .replace(
      /\n[ \t]+/g,
      "\n",
    )
    .replace(
      /\n{3,}/g,
      "\n\n",
    )
    .trim()
}


function normalizeProvision(
  value: string,
): string {
  return value
    .trim()
    .replace(
      /^(?:§|Art\.?|Artikel)\s*/i,
      "",
    )
}


async function fetchBuzerNorm(
  gesetzInput: string,
  paragraphInput: string,
  maxCharacters: number,
) {
  const gesetz =
    gesetzInput.trim()

  const paragraph =
    normalizeProvision(
      paragraphInput,
    )

  if (
    !/^[A-Za-zÄÖÜäöü0-9-]{1,40}$/
      .test(gesetz)
  ) {
    throw new Error(
      "Ungültige Gesetzesabkürzung.",
    )
  }

  if (
    !/^[0-9]+[A-Za-z]*$/
      .test(paragraph)
  ) {
    throw new Error(
      "Ungültiger Paragraph oder Artikel. Beispiel: 139, 130a oder 44.",
    )
  }

  const url =
    `${BUZER_BASE}/` +
    `${encodeURIComponent(paragraph)}_` +
    `${encodeURIComponent(gesetz)}.htm`

  const response =
    await fetch(
      url,
      {
        method: "GET",

        headers: {
          Accept:
            "text/html,application/xhtml+xml",

          "User-Agent":
            "Zivilrichter-MCP/1.0 legal-research",
        },

        signal:
          AbortSignal.timeout(20000),
      },
    )

  if (!response.ok) {
    throw new Error(
      `Buzer antwortete mit HTTP ${response.status}.`,
    )
  }

  const html =
    await response.text()

  const dom =
    new DOMParser()
      .parseFromString(
        html
          .replace(
            /<\/(p|div|tr|h[1-6]|li)>/gi,
            "</$1>\n",
          )
          .replace(
            /<br\s*\/?>/gi,
            "\n",
          ),
        "text/html",
      )

  if (!dom) {
    throw new Error(
      "Buzer-Seite konnte nicht ausgewertet werden.",
    )
  }

  dom
    .querySelectorAll(
      "script,style,nav,footer,form,aside",
    )
    .forEach(
      (node) =>
        node.remove(),
    )

  const headings =
    Array.from(
      dom.querySelectorAll(
        "h1,h2,h3,h4",
      ),
    ) as any[]

  const possiblePrefixes = [
    `§ ${paragraph}`,
    `Art. ${paragraph}`,
    `Art ${paragraph}`,
    `Artikel ${paragraph}`,
  ]

  const heading =
    headings.find(
      (node) => {
        const text =
          cleanPlainText(
            node.textContent ?? "",
          )

        return possiblePrefixes.some(
          (prefix) =>
            text.startsWith(prefix),
        )
      },
    )

  const headingText =
    heading
      ? cleanPlainText(
          heading.textContent ?? "",
        )
      : ""

  const bodyText =
    cleanPlainText(
      dom.body?.textContent ?? "",
    )

  let normText = ""

  if (headingText) {
    const start =
      bodyText.indexOf(
        headingText,
      )

    if (start >= 0) {
      const fromHeading =
        bodyText.slice(start)

      const markers = [
        "\nText in der Fassung",
        "\nFrühere Fassungen",
        "\nZitierungen von",
        "\nÄnderungen überwachen",
        "\nLink zu dieser Seite",
      ]

      const endings =
        markers
          .map(
            (marker) =>
              fromHeading.indexOf(
                marker,
              ),
          )
          .filter(
            (index) =>
              index > 0,
          )

      const end =
        endings.length > 0
          ? Math.min(
              ...endings,
            )
          : fromHeading.length

      normText =
        fromHeading
          .slice(
            0,
            end,
          )
          .trim()
    }
  }

  if (!normText) {
    throw new Error(
      "Der Normtext konnte auf der Buzer-Seite nicht sicher abgegrenzt werden.",
    )
  }

  const totalCharacters =
    normText.length

  const returnedText =
    normText.length > maxCharacters
      ? normText.slice(
          0,
          maxCharacters,
        )
      : normText

  return {
    ok: true,

    source:
      "buzer.de",

    sourceStatus:
      "nichtamtliche Arbeitsquelle",

    gesetz,
    paragraph,

    sourceUrl:
      url,

    text:
      returnedText,

    totalCharacters,

    truncated:
      totalCharacters > maxCharacters,

    warning:
      "buzer.de ist keine amtliche Rechtsquelle. " +
      "Für tragende gerichtliche Aussagen ist die aktuelle " +
      "Normfassung anhand einer amtlichen Quelle gegenzuprüfen.",
  }
}


// ============================================================
// MCP-SERVER
// ============================================================

const handler =
  createMcpHandler(
    () => {
      const server =
        new McpServer(
          {
            name:
              "zivilrichter-mcp",

            version:
              "0.7.0",
          },
          {
            instructions: `
Dieser MCP-Server dient der juristischen Recherche für deutsches
Recht und insbesondere deutsches Zivilprozessrecht.

Quellen sind nach ihrem Quellenwert zu behandeln.

Landesrecht Baden-Württemberg kann amtliche beziehungsweise
justizielle Primärtexte bereitstellen.

BGHeute ist ein privater Rechercheindex für Entscheidungen des
Bundesgerichtshofs. BGHeute dient zum Auffinden von Entscheidungen.
KI-generierte Zusammenfassungen sollen nicht als Rechtsquelle
verwendet werden und werden durch diesen MCP-Server nach Möglichkeit
nicht ausgegeben.

Für tragende Aussagen aus BGH-Entscheidungen sind Aktenzeichen,
Datum, Senat, Volltext und nach Möglichkeit die amtliche BGH-
beziehungsweise Juris-Quelle zu prüfen.

Der ZPO-Blog ist eine praxisnahe Sekundärquelle. Er darf Recherche,
Problemaufriss und Argumentationsstruktur unterstützen.
Tragende Rechtsaussagen sind anhand von Gesetz und belastbaren
Primärquellen gegenzuprüfen.

buzer.de ist eine nichtamtliche Arbeitsquelle für konsolidierte
Normtexte und Änderungshinweise. Für tragende gerichtliche Aussagen
ist eine amtliche Normquelle maßgeblich.

Suchtreffer und Snippets allein sind nicht als vollständig
verifizierter Entscheidungsinhalt zu behandeln.
            `.trim(),
          },
        )


      // ======================================================
      // 1. PING
      // ======================================================

      server.registerTool(
        "ping",
        {
          description:
            "Prüft, ob der Zivilrichter-MCP-Server erreichbar ist.",

          inputSchema:
            z.object({
              text:
                z.string()
                  .optional(),
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

              text:
                text
                  ? `Zivilrichter MCP läuft. Eingabe: ${text}`
                  : "Zivilrichter MCP läuft.",
            },
          ],
        }),
      )


      // ======================================================
      // 2. LANDESRECHT BW - HEALTH
      // ======================================================

      server.registerTool(
        "health_landesrecht_bw",
        {
          description:
            "Prüft, ob der vorhandene Landesrecht-BW-Proxy erreichbar ist.",

          inputSchema:
            z.object({}),

          annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            openWorldHint: true,
          },
        },

        async () => {
          try {
            const result =
              await getJson(
                LANDESRECHT_BASE,
                "/health",
              )

            return toolResult(
              result,
            )

          } catch (error) {
            return toolError(
              error,
            )
          }
        },
      )


      // ======================================================
      // 3. LANDESRECHT BW - SUCHE
      // ======================================================

      server.registerTool(
        "search_landesrecht_bw",
        {
          description: `
Sucht in Landesrecht Baden-Württemberg nach Rechtsprechung,
Gesetzen oder Verwaltungsvorschriften.

Für eine tragende Verwendung einer Gerichtsentscheidung soll
anschließend der Volltext mit get_landesrecht_bw_document
abgerufen werden.
          `.trim(),

          inputSchema:
            z.object({
              query:
                z.string()
                  .min(1)
                  .max(500),

              category:
                z.enum([
                  "all",
                  "Rechtsprechung",
                  "Gesetze",
                  "VV",
                ])
                  .default("all"),

              maxResults:
                z.number()
                  .int()
                  .min(1)
                  .max(20)
                  .default(5),

              page:
                z.number()
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
            const result =
              await getJson(
                LANDESRECHT_BASE,
                "/search",
                {
                  query,
                  category,
                  maxResults,
                  page,
                },
              )

            return toolResult(
              result,
            )

          } catch (error) {
            return toolError(
              error,
            )
          }
        },
      )


      // ======================================================
      // 4. LANDESRECHT BW - VOLLTEXT
      // ======================================================

      server.registerTool(
        "get_landesrecht_bw_document",
        {
          description: `
Ruft den Volltext eines zuvor mit search_landesrecht_bw
gefundenen Dokuments ab.

id und docPart müssen aus dem Suchtreffer übernommen werden.
          `.trim(),

          inputSchema:
            z.object({
              id:
                z.string()
                  .min(1)
                  .max(180),

              docPart:
                z.string()
                  .min(1)
                  .max(8)
                  .default("L"),

              maxCharacters:
                z.number()
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
            const result =
              await getJson(
                LANDESRECHT_BASE,
                "/document",
                {
                  id,
                  docPart,
                  maxCharacters,
                },
              )

            return toolResult(
              result,
            )

          } catch (error) {
            return toolError(
              error,
            )
          }
        },
      )


      // ======================================================
      // 5. ZPO-BLOG - HEALTH
      // ======================================================

      server.registerTool(
        "health_zpo_blog",
        {
          description:
            "Prüft, ob der vorhandene ZPO-Blog-Proxy erreichbar ist.",

          inputSchema:
            z.object({}),

          annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            openWorldHint: true,
          },
        },

        async () => {
          try {
            const result =
              await getJson(
                ZPOBLOG_BASE,
                "/health",
              )

            return toolResult(
              result,
            )

          } catch (error) {
            return toolError(
              error,
            )
          }
        },
      )


      // ======================================================
      // 6. ZPO-BLOG - SUCHE
      // ======================================================

      server.registerTool(
        "search_zpo_blog",
        {
          description: `
Sucht über die ZPO-Blog-Suchfunktion des Anwaltsblatts.

Der ZPO-Blog ist eine Sekundärquelle.

Für die erste Recherche regelmäßig mit mode="all" und ein bis
zwei Ergebnisseiten beginnen.

Mit includeFullText=true werden zusätzlich Artikeltexte,
Autor und Beitragsdatum geladen.
          `.trim(),

          inputSchema:
            z.object({
              query:
                z.string()
                  .min(2)
                  .max(500),

              mode:
                z.enum([
                  "all",
                  "any",
                  "or",
                  "literal",
                ])
                  .default("all"),

              maxPages:
                z.number()
                  .int()
                  .min(1)
                  .max(5)
                  .default(2),

              maxResults:
                z.number()
                  .int()
                  .min(1)
                  .max(80)
                  .default(25),

              includeFullText:
                z.boolean()
                  .default(false),

              maxFullTextCharacters:
                z.number()
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
            const result =
              await getJson(
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
              )

            return toolResult(
              result,
            )

          } catch (error) {
            return toolError(
              error,
            )
          }
        },
      )


      // ======================================================
      // 7. ZPO-BLOG - ARTIKEL
      // ======================================================

      server.registerTool(
        "get_zpo_blog_article",
        {
          description: `
Ruft einen einzelnen ZPO-Blog-Beitrag ab.

Der Abruf liefert insbesondere Titel, Beitragsdatum, Autor,
Schlagwörter und Text.

truncated=true bedeutet, dass der Text wegen der
Zeichenbegrenzung gekürzt wurde.
          `.trim(),

          inputSchema:
            z.object({
              url:
                z.string()
                  .min(5),

              maxCharacters:
                z.number()
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
            const result =
              await getJson(
                ZPOBLOG_BASE,
                "/article",
                {
                  url,
                  maxCharacters,
                },
                zpoBlogHeaders(),
              )

            return toolResult(
              result,
            )

          } catch (error) {
            return toolError(
              error,
            )
          }
        },
      )


      // ======================================================
      // 8. BGH - VOLLTEXTSUCHE
      // ======================================================

      server.registerTool(
        "search_bgh_decisions",
        {
          description: `
Sucht im privaten Rechercheindex BGHeute nach Entscheidungen
des Bundesgerichtshofs.

Geeignet für eine thematische Volltextsuche.

BGHeute dient zum Auffinden einschlägiger Entscheidungen.
KI-generierte Zusammenfassungen werden durch dieses Tool
nicht ausgegeben.

Eine relevante Entscheidung soll anschließend anhand des
Aktenzeichens mit get_bgh_decision abgerufen werden.

Für tragende Rechtsaussagen sind Aktenzeichen, Datum, Senat,
Volltext und nach Möglichkeit die amtliche BGH-/Juris-Quelle
zu verifizieren.
          `.trim(),

          inputSchema:
            z.object({
              q:
                z.string()
                  .min(1)
                  .max(500),

              fields:
                z.string()
                  .default(
                    "titel,urteilstext,aktenzeichen",
                  ),

              limit:
                z.number()
                  .int()
                  .min(1)
                  .max(10)
                  .default(5),

              offset:
                z.number()
                  .int()
                  .min(0)
                  .max(100000)
                  .default(0),
            }),

          annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            openWorldHint: true,
          },
        },

        async ({
          q,
          fields,
          limit,
          offset,
        }) => {
          try {
            const result =
              await getJson(
                BGHEUTE_BASE,
                "/api/decisions/search",
                {
                  q,
                  fields,
                  limit,
                  offset,
                },
              )

            return toolResult(
              slimBghPayload(
                result,
              ),
            )

          } catch (error) {
            return toolError(
              error,
            )
          }
        },
      )


      // ======================================================
      // 9. BGH - STRUKTURIERTE SUCHE
      // ======================================================

      server.registerTool(
        "find_bgh_decisions",
        {
          description: `
Filtert Entscheidungen des Bundesgerichtshofs über BGHeute.

Geeignet insbesondere für eine Suche nach Senat, Zeitraum,
Aktenzeichen oder zusätzlichem Suchbegriff.

BGHeute ist ein privater Rechercheindex.
          `.trim(),

          inputSchema:
            z.object({
              query:
                z.string()
                  .max(500)
                  .optional(),

              senat:
                z.string()
                  .max(200)
                  .optional(),

              aktenzeichen:
                z.string()
                  .max(100)
                  .optional(),

              startDate:
                z.string()
                  .max(10)
                  .optional(),

              endDate:
                z.string()
                  .max(10)
                  .optional(),

              sort:
                z.enum([
                  "date_desc",
                  "date_asc",
                  "lesezeit_asc",
                  "lesezeit_desc",
                ])
                  .default(
                    "date_desc",
                  ),

              limit:
                z.number()
                  .int()
                  .min(1)
                  .max(20)
                  .default(5),

              offset:
                z.number()
                  .int()
                  .min(0)
                  .max(100000)
                  .default(0),
            }),

          annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            openWorldHint: true,
          },
        },

        async ({
          query,
          senat,
          aktenzeichen,
          startDate,
          endDate,
          sort,
          limit,
          offset,
        }) => {
          try {
            const result =
              await getJson(
                BGHEUTE_BASE,
                "/api/decisions",
                {
                  query,
                  senat,
                  aktenzeichen,
                  start_date:
                    startDate,
                  end_date:
                    endDate,
                  sort,
                  limit,
                  offset,
                },
              )

            return toolResult(
              slimBghPayload(
                result,
              ),
            )

          } catch (error) {
            return toolError(
              error,
            )
          }
        },
      )


      // ======================================================
      // 10. BGH - EINZELENTSCHEIDUNG
      // ======================================================

      server.registerTool(
        "get_bgh_decision",
        {
          description: `
Ruft eine konkrete BGH-Entscheidung anhand ihres Aktenzeichens
über BGHeute ab.

Der Abruf verwendet den Aktenzeichenfilter und prüft
anschließend auf exakte Übereinstimmung.

KI-generierte Zusammenfassungen werden nicht ausgegeben.

Für eine tragende Verwendung ist insbesondere die im Datensatz
enthaltene amtliche BGH-/Juris-URL zur Verifikation
heranzuziehen, soweit verfügbar.
          `.trim(),

          inputSchema:
            z.object({
              aktenzeichen:
                z.string()
                  .min(2)
                  .max(100),

              maxCharacters:
                z.number()
                  .int()
                  .min(1000)
                  .max(100000)
                  .default(30000),
            }),

          annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            openWorldHint: true,
          },
        },

        async ({
          aktenzeichen,
          maxCharacters,
        }) => {
          try {
            const result =
              await getJson(
                BGHEUTE_BASE,
                "/api/decisions",
                {
                  aktenzeichen,
                  limit: 20,
                  offset: 0,
                },
              )

            const decisions =
              Array.isArray(
                result?.decisions,
              )
                ? result.decisions
                : []

            const normalizeAz =
              (value: unknown) =>
                String(
                  value ?? "",
                )
                  .trim()
                  .replace(
                    /\s+/g,
                    " ",
                  )
                  .toLowerCase()

            const wanted =
              normalizeAz(
                aktenzeichen,
              )

            const exact =
              decisions.find(
                (decision: any) =>
                  normalizeAz(
                    decision
                      ?.aktenzeichen,
                  ) === wanted,
              )

            if (!exact) {
              return toolResult({
                ok: false,

                error:
                  "Keine Entscheidung mit exakt diesem Aktenzeichen gefunden.",

                searchedAktenzeichen:
                  aktenzeichen,

                candidates:
                  decisions
                    .slice(0, 5)
                    .map(
                      (
                        decision:
                          any
                      ) =>
                        slimBghDecision(
                          decision,
                        ),
                    ),
              })
            }

            return toolResult(
              fullBghDecision(
                exact,
                maxCharacters,
              ),
            )

          } catch (error) {
            return toolError(
              error,
            )
          }
        },
      )



      // ======================================================
      // 11. BUZER - NORMTEXT
      // ======================================================

      server.registerTool(
        "get_buzer_norm",
        {
          description: `
Ruft eine deutsche Bundesrechtsnorm über buzer.de ab.

buzer.de ist eine nichtamtliche Arbeitsquelle.

Das Tool eignet sich zur schnellen Recherche konsolidierter
Normtexte. Für tragende gerichtliche Aussagen ist die aktuelle
Normfassung anhand einer amtlichen Quelle gegenzuprüfen.
          `.trim(),

          inputSchema:
            z.object({
              gesetz:
                z.string()
                  .min(1)
                  .max(40)
                  .describe(
                    "Gesetzesabkürzung, z. B. ZPO, BGB, StGB, FamFG oder GVG",
                  ),

              paragraph:
                z.string()
                  .min(1)
                  .max(20)
                  .describe(
                    "Paragraph oder Artikel, z. B. 139, 130a oder 44",
                  ),

              maxCharacters:
                z.number()
                  .int()
                  .min(1000)
                  .max(30000)
                  .default(10000),
            }),

          annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            openWorldHint: true,
          },
        },

        async ({
          gesetz,
          paragraph,
          maxCharacters,
        }) => {
          try {
            const result =
              await fetchBuzerNorm(
                gesetz,
                paragraph,
                maxCharacters,
              )

            return toolResult(
              result,
            )

          } catch (error) {
            return toolError(
              error,
            )
          }
        },
      )


      return server
    },
  )


// ============================================================
// DENO DEPLOY
// ============================================================

export default handler
