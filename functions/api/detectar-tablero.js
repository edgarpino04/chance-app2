// ═══════════════════════════════════════════════════════════════════════════
// CHANCE — Detector de Tablero con IA (Gemini Vision)
// ───────────────────────────────────────────────────────────────────────────
// Cloudflare Pages Function que recibe una foto del tablero de billetes/chances
// y devuelve los números detectados separados por tipo.
//
// Endpoint: POST /api/detectar-tablero
//
// Body esperado (JSON):
//   {
//     "image": "data:image/jpeg;base64,/9j/4AAQ...",   // base64 con prefijo data:
//     "tipo":  "billete" | "chance" | "ambos",
//     "sorteo": "MIERCOLITO" | "DOMINICAL" | etc       // (opcional, contexto)
//   }
//
// Respuesta:
//   {
//     "ok": true,
//     "billetes": ["4567", "8488", "0101", ...],   // 4 cifras
//     "chances":  ["07", "45", "98", ...],         // 2 cifras
//     "raw": "texto de Gemini para debug"
//   }
//
// Requiere variable de entorno: GEMINI_API_KEY (configurada en Cloudflare Pages)
// ═══════════════════════════════════════════════════════════════════════════

export async function onRequestPost({ request, env }) {
  // CORS preflight automático para fetch desde claudeapps.pages.dev
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  try {
    const body = await request.json();
    const { image, tipo = "ambos", sorteo = "MIERCOLITO" } = body || {};

    if (!image || typeof image !== "string") {
      return new Response(
        JSON.stringify({ ok: false, error: "Falta el campo 'image' (base64)" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Separar el mime y el base64 puro
    // Formato esperado: "data:image/jpeg;base64,/9j/4AAQ..."
    let mime = "image/jpeg";
    let base64 = image;
    const match = image.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      mime   = match[1];
      base64 = match[2];
    }

    // Validar tamaño aproximado (max ~10MB de imagen → ~13MB de base64)
    if (base64.length > 14 * 1024 * 1024) {
      return new Response(
        JSON.stringify({ ok: false, error: "Imagen demasiado grande. Reduce calidad/tamaño." }),
        { status: 413, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const GEMINI_API_KEY = env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "GEMINI_API_KEY no configurada en Cloudflare Pages.",
        }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // ───────────────────────────────────────────────────────────────────────
    // Prompt cuidadosamente diseñado para tableros de billetería panameña
    // ───────────────────────────────────────────────────────────────────────
    const promptParts = [];

    if (tipo === "billete") {
      promptParts.push(
        "Eres un asistente que analiza fotos de tableros de billetes de la Lotería Nacional de Panamá."
      );
      promptParts.push(
        "En esta foto hay billetes de 4 cifras de la LNB organizados en filas. Cada billete muestra " +
        "claramente su número impreso en grande sobre un fondo de papel."
      );
      promptParts.push(
        "Lista TODOS los números de 4 cifras visibles en el tablero. Algunos pueden repetirse " +
        "(varios billetes con el mismo número) — en ese caso, repítelos en la lista."
      );
    } else if (tipo === "chance") {
      promptParts.push(
        "Eres un asistente que analiza fotos de tableros de chances (números de 2 cifras) " +
        "de la Lotería Nacional de Panamá."
      );
      promptParts.push(
        "En esta foto hay chances de 2 cifras (00 a 99). Lista TODOS los números visibles. " +
        "Si un número aparece varias veces, repítelo."
      );
    } else {
      // ambos
      promptParts.push(
        "Eres un asistente que analiza fotos de tableros de billetería panameña (Lotería Nacional)."
      );
      promptParts.push(
        "En la foto hay BILLETES (números de 4 cifras) y/o CHANCES (números de 2 cifras). " +
        "Identifica cada uno y clasifícalo por tipo según su cantidad de dígitos."
      );
    }

    promptParts.push(
      `Sorteo de contexto: ${sorteo}.`
    );
    promptParts.push(
      "REGLAS CRÍTICAS de respuesta:"
    );
    promptParts.push(
      "1) Responde SOLO con un objeto JSON válido, sin markdown ni texto antes o después.\n" +
      "2) Estructura obligatoria:\n" +
      '   {"billetes": ["XXXX", "XXXX", ...], "chances": ["XX", "XX", ...]}\n' +
      "3) Cada billete debe tener exactamente 4 dígitos (rellena con ceros a la izquierda si fuera necesario).\n" +
      "4) Cada chance debe tener exactamente 2 dígitos (rellena con ceros a la izquierda si fuera necesario).\n" +
      "5) Si no estás 100% seguro de un número porque está borroso, tapado o cortado, OMÍTELO. " +
      "Es mejor faltar uno que inventarlo.\n" +
      "6) Repite los números que aparecen varias veces en el tablero.\n" +
      "7) Si la foto no muestra un tablero de billetes/chances, responde " +
      '{"billetes": [], "chances": [], "error": "No es un tablero de billetería"}.'
    );

    const fullPrompt = promptParts.join("\n\n");

    // ───────────────────────────────────────────────────────────────────────
    // Llamada a Gemini 2.0 Flash (multimodal, rápido, barato)
    // ───────────────────────────────────────────────────────────────────────
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    const geminiResp = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: fullPrompt },
            { inline_data: { mime_type: mime, data: base64 } },
          ],
        }],
        generationConfig: {
          temperature: 0.1,       // baja para ser determinista en lectura
          maxOutputTokens: 4096,  // suficiente para tableros densos (~200 números)
          responseMimeType: "application/json",
        },
      }),
    });

    if (!geminiResp.ok) {
      const errText = await geminiResp.text();
      return new Response(
        JSON.stringify({
          ok: false,
          error: `Gemini respondió ${geminiResp.status}: ${errText.slice(0, 300)}`,
        }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const geminiData = await geminiResp.json();
    const rawText =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // ───────────────────────────────────────────────────────────────────────
    // Parsear la respuesta JSON con tolerancia a markdown accidental
    // ───────────────────────────────────────────────────────────────────────
    let parsed = null;
    try {
      // Si Gemini envolvió en ```json ... ``` lo limpiamos
      const clean = rawText
        .replace(/```json\s*/gi, "")
        .replace(/```\s*$/g, "")
        .trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "No se pudo parsear la respuesta de Gemini",
          raw: rawText.slice(0, 500),
        }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // ───────────────────────────────────────────────────────────────────────
    // Sanitizar: garantizar formato de cifras y filtrar basura
    // ───────────────────────────────────────────────────────────────────────
    const billetes = (Array.isArray(parsed.billetes) ? parsed.billetes : [])
      .map(n => String(n).replace(/\D/g, ""))
      .filter(n => n.length >= 1 && n.length <= 4)
      .map(n => n.padStart(4, "0"));

    const chances = (Array.isArray(parsed.chances) ? parsed.chances : [])
      .map(n => String(n).replace(/\D/g, ""))
      .filter(n => n.length >= 1 && n.length <= 2)
      .map(n => n.padStart(2, "0"));

    return new Response(
      JSON.stringify({
        ok: true,
        billetes,
        chances,
        total: billetes.length + chances.length,
        warning: parsed.error || null,
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );

  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: e.message || "Error inesperado" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
}

// Manejo de CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

