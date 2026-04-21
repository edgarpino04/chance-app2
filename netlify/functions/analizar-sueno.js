// Netlify Serverless Function — Proxy a Google Gemini API
// ⚠️ REQUIERE: Configurar GEMINI_API_KEY en Netlify → Environment variables
// Obtén tu clave GRATIS en: https://aistudio.google.com/apikey

exports.handler = async (event) => {
  // CORS
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Método no permitido" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonResponse(500, { error: "GEMINI_API_KEY no configurada en Netlify" });
  }

  let texto = "";
  try {
    texto = (JSON.parse(event.body || "{}").texto || "").trim();
  } catch {
    return jsonResponse(400, { error: "Body inválido" });
  }

  if (!texto) return jsonResponse(400, { error: "Texto vacío" });

  // Prompt minimalista y directo — enfocado en que Gemini siempre devuelva JSON
  const prompt = buildPrompt(texto);

  // Intentar con gemini-2.0-flash (modelo estable, sin thinking mode)
  try {
    const result = await callGemini(apiKey, "gemini-2.0-flash", prompt);

    if (result.ok) {
      return jsonResponse(200, result.data);
    }

    // Si falla, intentar con 1.5-flash (más viejo pero aún disponible en algunas cuentas)
    const result2 = await callGemini(apiKey, "gemini-flash-latest", prompt);
    if (result2.ok) {
      return jsonResponse(200, result2.data);
    }

    // Si los dos fallan, devolver error con info de debug
    return jsonResponse(502, {
      error: "No se pudo procesar. Intenta en 1 minuto.",
      debug: result.error || result2.error
    });

  } catch (err) {
    console.error("Function crashed:", err);
    return jsonResponse(500, { error: "Error interno: " + err.message });
  }
};

// ══════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
    body: JSON.stringify(bodyObj)
  };
}

function buildPrompt(textoUsuario) {
  return `Eres EL CHAKATIN, el interprete de sueños mas famoso de Panama. Usas humor panameño al estilo Malcolm Ramos.

TRADICION PANAMA (numeros de la loteria):
agua=14, muerto=48, sangre=07, serpiente=35, pescado=19, perro=04, dinero=50, accidente=73, caida=73, fuego=08, bebe=01, mujer=11, hombre=22, luna=09, sol=51, diablo=66, pajaro=55, carro=28, oro=12, iglesia=10, boda=11, fiesta=77, policia=73, caballo=18, vaca=05, gallo=21, arbol=35, flor=19, casa=22, mar=14, gato=07, traicion=11, pelea=73, beso=11, llorar=07

TAREA:
Analiza el sueño del usuario y da 3 numeros diferentes (del 00 al 99) con explicaciones que mencionen detalles concretos del sueño. Usa humor panameño natural.

SUEÑO DEL USUARIO:
${textoUsuario}

FORMATO DE RESPUESTA (responde SOLO el JSON, sin texto extra, sin markdown, sin backticks):
{"numeros":["XX","YY","ZZ"],"explicaciones":["explicacion 1 con detalle especifico del sueño","explicacion 2 diferente","explicacion 3 diferente"],"frase_motivadora":"frase corta panameña","elementos":["elem1","elem2","elem3"]}`;
}

async function callGemini(apiKey, modelo, prompt) {
  try {
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 2048,
      }
    };

    // Desactivar "thinking" en modelos 2.5
    if (modelo.startsWith("gemini-2.5")) {
      body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;
    console.log(`Llamando a ${modelo}...`);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const statusCode = response.status;
    const rawBody = await response.text();

    if (!response.ok) {
      console.error(`${modelo} error ${statusCode}:`, rawBody.substring(0, 500));
      return { ok: false, error: `${modelo}: HTTP ${statusCode}` };
    }

    let data;
    try {
      data = JSON.parse(rawBody);
    } catch {
      console.error(`${modelo} respuesta no JSON:`, rawBody.substring(0, 300));
      return { ok: false, error: `${modelo}: respuesta no JSON` };
    }

    // Extraer texto del candidate
    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason;

    if (finishReason === "SAFETY") {
      return { ok: false, error: `${modelo}: bloqueado por filtros de seguridad` };
    }

    let responseText = candidate?.content?.parts?.[0]?.text;

    if (!responseText) {
      console.error(`${modelo} sin texto. Data:`, JSON.stringify(data).substring(0, 500));
      return { ok: false, error: `${modelo}: respuesta vacía (finishReason=${finishReason})` };
    }

    // Limpiar markdown
    responseText = responseText.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    // Extraer JSON
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error(`${modelo} sin JSON en texto:`, responseText.substring(0, 300));
      return { ok: false, error: `${modelo}: sin JSON en respuesta` };
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      // Limpieza de emergencia
      try {
        parsed = JSON.parse(
          jsonMatch[0]
            .replace(/,(\s*[}\]])/g, "$1")
            .replace(/[\u201C\u201D]/g, '"')
            .replace(/[\u2018\u2019]/g, "'")
        );
      } catch {
        console.error(`${modelo} JSON inválido:`, jsonMatch[0].substring(0, 300));
        return { ok: false, error: `${modelo}: JSON inválido` };
      }
    }

    // Validar estructura
    if (!Array.isArray(parsed.numeros) || parsed.numeros.length < 3) {
      return { ok: false, error: `${modelo}: sin 3 números` };
    }

    // Normalizar números a 2 dígitos
    parsed.numeros = parsed.numeros.slice(0, 3).map(n => {
      const digitos = String(n).replace(/\D/g, "");
      return digitos.padStart(2, "0").substring(0, 2);
    });

    // Garantizar explicaciones y elementos
    if (!Array.isArray(parsed.explicaciones) || parsed.explicaciones.length < 3) {
      parsed.explicaciones = [
        `El ${parsed.numeros[0]} aparece en tu sueño con fuerza.`,
        `El ${parsed.numeros[1]} complementa la energía del relato.`,
        `El ${parsed.numeros[2]} cierra la jugada con buen pie.`
      ];
    }
    if (!parsed.frase_motivadora) {
      parsed.frase_motivadora = "¡Dale con todo a esos números!";
    }
    if (!Array.isArray(parsed.elementos)) {
      parsed.elementos = ["tu sueño"];
    }

    console.log(`${modelo} OK`);
    return { ok: true, data: parsed };

  } catch (err) {
    console.error(`${modelo} excepción:`, err.message);
    return { ok: false, error: `${modelo}: ${err.message}` };
  }
}
