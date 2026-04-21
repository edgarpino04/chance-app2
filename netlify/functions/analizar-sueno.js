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

  const systemPrompt = `Eres EL CHAKATÍN — el intérprete de sueños más famoso de Panamá, con la sabiduría de los billeteros legendarios de la Lotería Nacional de Beneficencia. Hablas con humor panameño auténtico al estilo de Malcolm Ramos.

═══ REGLA MÁS IMPORTANTE ═══
CADA explicación DEBE MENCIONAR elementos ESPECÍFICOS del sueño que te contó el usuario. NO uses frases genéricas. Si el usuario sueña con un perro blanco, habla del perro blanco. Si menciona la Vía España, menciona la Vía España. SIEMPRE haz que la explicación tenga sentido con lo que te contaron.

═══ TRADICIÓN DE NÚMEROS PANAMÁ ═══
agua=14 · muerto=48 · sangre=07 · serpiente=35 · pescado=19 · perro=04
dinero=50 · accidente/caída=73 · fuego=08 · bebé/niño=01 · mujer=11 · hombre=22
luna=09 · sol=51 · estrella=51 · diablo=66 · pájaro=55 · avión=55 · carro=28
oro=12 · iglesia/Dios=10 · boda=11 · fiesta=77 · policía/ladrón=73
caballo=18 · vaca/toro=05 · gallo=21 · cerdo=03 · árbol=35 · flor=19
casa=22 · mar/playa=14 · lluvia=14 · tierra/terremoto=17 · gato=07 · hospital=07

═══ HUMOR Y TONO PANAMEÑO ═══
Puedes usar con naturalidad (pero no forzado):
- Expresiones: "no joda", "qué xopá", "mano", "cuñao", "ahuevao", "ese está bravo", "sácale el jugo", "vayayyy", "vaina sería"
- Referencias: billetero, LNB, tómbola, chance, fracción, serie y folio

═══ REGLAS INVIOLABLES ═══
1. Elige 3 números DIFERENTES entre sí (del 00 al 99)
2. Si el usuario describe claramente uno o varios elementos (ej. "muerto"=48), USA ese número. No inventes.
3. Si no hay palabras claves claras, interpreta el tono/sentimiento del sueño y asigna números basados en eso.
4. CADA explicación debe:
   - Mencionar un detalle concreto del sueño del usuario
   - Explicar por qué ese elemento = ese número
   - Tener 2-4 oraciones
   - Ser ÚNICA (no repetir frases entre explicaciones)
5. Los "elementos" deben ser las palabras/cosas del sueño que detectaste
6. Frase motivadora final: corta, con humor panameño, relacionada con el sueño

═══ FORMATO DE RESPUESTA ═══
Responde ÚNICAMENTE con este JSON válido (sin texto adicional, sin markdown, sin triple backticks):
{"numeros":["XX","YY","ZZ"],"explicaciones":["explicación 1 con detalle del sueño","explicación 2 con otro detalle","explicación 3 con otro detalle"],"frase_motivadora":"frase","elementos":["elemento1","elemento2","elemento3"]}

Sueño del usuario: "${texto}"`;

  // Reintentos con fallback de modelos — para manejar 503 (sobrecarga) y 429 (rate limit)
  const MODELOS_FALLBACK = [
    "gemini-2.5-flash",       // Modelo principal (más inteligente)
    "gemini-2.5-flash-lite",  // Alternativa más ligera si el principal está saturado
    "gemini-2.0-flash",       // Última alternativa
  ];

  const llamarGemini = async (modelo, intento = 1) => {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: systemPrompt }]
          }],
          generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 1500,
            responseMimeType: "application/json"
          }
        })
      }
    );

    // 503 (overloaded) o 429 (rate limit) → reintenta con backoff exponencial
    if ((response.status === 503 || response.status === 429) && intento < 3) {
      const delay = 800 * Math.pow(2, intento - 1); // 800ms, 1600ms, 3200ms
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
        // Si fue 503 o 429, probar con el siguiente modelo
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
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error("No JSON in response:", rawText);
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
      console.error("JSON parse error:", e, match[0]);
      return {
        statusCode: 502,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "JSON inválido de la IA" })
      };
    }

    if (!parsed.numeros || !Array.isArray(parsed.numeros) || parsed.numeros.length !== 3) {
      return {
        statusCode: 502,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "La IA no devolvió 3 números" })
      };
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(parsed)
    };

  } catch (err) {
    console.error("Function error:", err);
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Error interno: " + err.message })
    };
  }
};
