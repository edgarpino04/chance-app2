// CHANCE - Detector de Tablero con IA (Gemini Vision)
// Cloudflare Pages Function
// Endpoint: POST /api/detectar-tablero
// Requiere: GEMINI_API_KEY como Secret en Cloudflare Pages

export async function onRequestPost(context) {
  const { request, env } = context;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  try {
    const body = await request.json();
    const image = body.image;
    const tipo = body.tipo || "ambos";
    const sorteo = body.sorteo || "MIERCOLITO";

    if (!image || typeof image !== "string") {
      return new Response(
        JSON.stringify({ ok: false, error: "Falta el campo 'image' (base64)" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    let mime = "image/jpeg";
    let base64 = image;
    const match = image.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      mime = match[1];
      base64 = match[2];
    }

    if (base64.length > 14 * 1024 * 1024) {
      return new Response(
        JSON.stringify({ ok: false, error: "Imagen demasiado grande" }),
        { status: 413, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const GEMINI_API_KEY = env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({ ok: false, error: "GEMINI_API_KEY no configurada en Cloudflare Pages" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    let promptText = "";
    if (tipo === "billete") {
      promptText = "Eres un asistente que analiza fotos de tableros de billetes de la Loteria Nacional de Panama. En esta foto hay billetes de 4 cifras organizados en filas. Cada billete muestra claramente su numero impreso. Lista TODOS los numeros de 4 cifras visibles. Si un numero se repite, repitelo en la lista.";
    } else if (tipo === "chance") {
      promptText = "Eres un asistente que analiza fotos de tableros de chances de 2 cifras (00-99) de la Loteria Nacional de Panama. Lista TODOS los numeros visibles. Si un numero aparece varias veces, repitelo.";
    } else {
      promptText = "Eres un asistente que analiza fotos de tableros de billeteria panamena. En la foto hay BILLETES (4 cifras) y/o CHANCES (2 cifras). Identifica cada uno y clasificalo por tipo segun su cantidad de digitos.";
    }

    promptText += "\n\nSorteo de contexto: " + sorteo + ".";
    promptText += "\n\nREGLAS:";
    promptText += "\n1) Responde SOLO con JSON valido, sin markdown.";
    promptText += "\n2) Estructura: {\"billetes\": [\"XXXX\"], \"chances\": [\"XX\"]}";
    promptText += "\n3) Cada billete con exactamente 4 digitos.";
    promptText += "\n4) Cada chance con exactamente 2 digitos.";
    promptText += "\n5) Si no estas seguro de un numero, OMITELO.";
    promptText += "\n6) Repite los numeros que aparecen varias veces.";

    const geminiUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + GEMINI_API_KEY;

    const geminiResp = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: promptText },
            { inline_data: { mime_type: mime, data: base64 } }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 4096,
          responseMimeType: "application/json"
        }
      })
    });

    if (!geminiResp.ok) {
      const errText = await geminiResp.text();
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Gemini HTTP " + geminiResp.status + ": " + errText.slice(0, 300)
        }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const geminiData = await geminiResp.json();
    let rawText = "";
    if (geminiData && geminiData.candidates && geminiData.candidates[0]) {
      const c = geminiData.candidates[0];
      if (c.content && c.content.parts && c.content.parts[0] && c.content.parts[0].text) {
        rawText = c.content.parts[0].text;
      }
    }

    let parsed = null;
    try {
      const clean = rawText.replace(/```json\s*/gi, "").replace(/```\s*$/g, "").trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "No se pudo parsear la respuesta de Gemini",
          raw: rawText.slice(0, 500)
        }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const billetes = (Array.isArray(parsed.billetes) ? parsed.billetes : [])
      .map(function(n) { return String(n).replace(/\D/g, ""); })
      .filter(function(n) { return n.length >= 1 && n.length <= 4; })
      .map(function(n) { return n.padStart(4, "0"); });

    const chances = (Array.isArray(parsed.chances) ? parsed.chances : [])
      .map(function(n) { return String(n).replace(/\D/g, ""); })
      .filter(function(n) { return n.length >= 1 && n.length <= 2; })
      .map(function(n) { return n.padStart(2, "0"); });

    return new Response(
      JSON.stringify({
        ok: true,
        billetes: billetes,
        chances: chances,
        total: billetes.length + chances.length,
        warning: parsed.error || null
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

// Handler GET para verificar deploy
// Al abrir https://chanceloteria.pages.dev/api/detectar-tablero en el navegador
// veras este JSON en lugar de la app de login.
export async function onRequestGet() {
  return new Response(
    JSON.stringify({
      ok: true,
      status: "Detector de tablero activo",
      message: "Esta function requiere POST con { image, tipo, sorteo }",
      version: "1.0.1"
    }, null, 2),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    }
  );
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400"
    }
  });
}
