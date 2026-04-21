// Netlify Serverless Function — Proxy seguro para Google Gemini API
// La API key vive aquí en el servidor, nunca llega al navegador
// ⚠️ REQUIERE: Configurar GEMINI_API_KEY en Netlify → Site configuration → Environment variables
// Obtén tu clave GRATIS en: https://aistudio.google.com/apikey

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Método no permitido" }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "GEMINI_API_KEY no configurada en Netlify" })
    };
  }

  let texto = "";
  try {
    const body = JSON.parse(event.body || "{}");
    texto = (body.texto || "").trim();
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Body inválido" }) };
  }

  if (!texto) {
    return { statusCode: 400, body: JSON.stringify({ error: "Texto vacío" }) };
  }

  const systemPrompt = `Eres EL CHAKATIN, el interprete de sueños mas famoso de Panama, con la sabiduria de los billeteros legendarios de la Loteria Nacional de Beneficencia (LNB). Hablas con humor panameño autentico al estilo de Malcolm Ramos.

REGLA MAS IMPORTANTE:
CADA explicacion DEBE MENCIONAR elementos ESPECIFICOS del sueño que te conto el usuario. NO uses frases genericas. Si el usuario sueña con un perro blanco, habla del perro blanco. Si menciona la Via Españia, menciona la Via Españia. Haz que la explicacion tenga sentido con lo que te contaron.

TRADICION DE NUMEROS PANAMA:
agua=14, muerto=48, sangre=07, serpiente=35, pescado=19, perro=04, dinero=50, accidente=73, caida=73, fuego=08, bebe=01, niño=01, mujer=11, hombre=22, luna=09, sol=51, estrella=51, diablo=66, pajaro=55, avion=55, carro=28, oro=12, iglesia=10, dios=10, boda=11, fiesta=77, policia=73, ladron=73, caballo=18, vaca=05, toro=05, gallo=21, cerdo=03, arbol=35, flor=19, casa=22, mar=14, playa=14, lluvia=14, tierra=17, terremoto=17, gato=07, hospital=07, llorar=07, risa=77, traicion=11, pelea=73

HUMOR Y TONO PANAMEÑO (usalo con naturalidad):
- Expresiones: "no joda", "que xopa", "mano", "cuñao", "ese esta bravo", "sacale el jugo", "vayayyy", "vaina seria"
- Referencias: billetero, LNB, tombola, chance, fraccion

REGLAS INVIOLABLES:
1. Elige 3 numeros DIFERENTES entre si (del 00 al 99, con cero a la izquierda si es menor a 10)
2. Si el usuario describe elementos claros (ej. muerto=48, mujer=11), USA esos numeros
3. CADA explicacion debe mencionar un detalle concreto del sueño del usuario
4. Cada explicacion debe tener 2-4 oraciones y ser UNICA
5. Frase motivadora final corta con humor panameño

FORMATO OBLIGATORIO - Responde SOLO con este JSON valido, SIN markdown, SIN backticks, SIN texto extra:
{"numeros":["XX","YY","ZZ"],"explicaciones":["texto 1","texto 2","texto 3"],"frase_motivadora":"frase","elementos":["elem1","elem2","elem3"]}

Sueño del usuario: "${texto}"`;

  // Modelos con fallback — priorizar los más estables y sin "thinking mode"
  const MODELOS_FALLBACK = [
    "gemini-2.0-flash",        // Más estable para JSON estructurado, sin thinking
    "gemini-2.5-flash-lite",   // Ligero, sin thinking mode por defecto
    "gemini-2.5-flash",        // Último recurso
  ];

  const llamarGemini = async (modelo, intento = 1) => {
    const body = {
      contents: [{
        parts: [{ text: systemPrompt }]
      }],
      generationConfig: {
        temperature: 0.9,
        maxOutputTokens: 3000,  // Aumentado por si el modelo usa tokens en "thinking"
      }
    };

    // Para modelos 2.5 que tienen "thinking mode", desactivarlo explícitamente
    if (modelo.startsWith("gemini-2.5")) {
      body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );

    // 503 (overloaded) o 429 (rate limit) → reintenta con backoff exponencial
    if ((response.status === 503 || response.status === 429) && intento < 3) {
      const delay = 800 * Math.pow(2, intento - 1);
      await new Promise(r => setTimeout(r, delay));
      return llamarGemini(modelo, intento + 1);
    }

    return response;
  };

  try {
    let response = null;
    let ultimoError = null;

    // Intentar con cada modelo hasta que uno funcione
    for (const modelo of MODELOS_FALLBACK) {
      try {
        response = await llamarGemini(modelo);
        if (response.ok) break;

        const errText = await response.text();
        ultimoError = `${modelo}: ${response.status} - ${errText.substring(0, 200)}`;
        console.warn(`Modelo ${modelo} falló:`, response.status);
        if (response.status !== 503 && response.status !== 429) break;
      } catch (e) {
        ultimoError = `${modelo}: ${e.message}`;
        console.error(`Error con ${modelo}:`, e);
      }
    }

    if (!response || !response.ok) {
      console.error("Todos los modelos fallaron:", ultimoError);
      return {
        statusCode: 502,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          error: "Google Gemini está sobrecargado. Intenta en 1 minuto."
        })
      };
    }

    const data = await response.json();

    // Debug: log finishReason si es problemático
    const finishReason = data.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== "STOP") {
      console.warn("Finish reason:", finishReason);
    }

    let rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Si no hay texto pero hay contenido en otros formatos, intentar extraer
    if (!rawText) {
      console.error("Respuesta sin texto. Data completa:", JSON.stringify(data).substring(0, 500));
      return {
        statusCode: 502,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          error: "La IA respondió vacío. Intenta con otro texto o en un momento."
        })
      };
    }

    // Limpiar wrappers de markdown que a veces Gemini agrega
    rawText = rawText.trim();
    rawText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    rawText = rawText.trim();

    // Extraer el primer objeto JSON válido
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error("No JSON in response. Raw text:", rawText.substring(0, 300));
      return {
        statusCode: 502,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "La IA no devolvió formato válido" })
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(match[0]);
    } catch (e) {
      console.error("JSON parse error:", e.message, "Raw:", match[0].substring(0, 300));
      // Último intento: arreglar comas/comillas comunes
      try {
        const cleaned = match[0]
          .replace(/,(\s*[}\]])/g, "$1")  // quitar comas finales
          .replace(/[\u201C\u201D]/g, '"') // comillas curvas
      
