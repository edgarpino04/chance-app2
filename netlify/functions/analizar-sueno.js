// Netlify Serverless Function — Proxy a Google Gemini API con Fallback Local
// Si Gemini está caído (503/429), usa un motor local basado en diccionario panameño
// ⚠️ REQUIERE: Configurar GEMINI_API_KEY en Netlify → Environment variables

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Método no permitido" });
  }

  let texto = "";
  try {
    texto = (JSON.parse(event.body || "{}").texto || "").trim();
  } catch {
    return jsonResponse(400, { error: "Body inválido" });
  }
  if (!texto) return jsonResponse(400, { error: "Texto vacío" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonResponse(200, { ...motorLocal(texto), _source: "local_no_key" });
  }

  const prompt = buildPrompt(texto);
  const modelos = [
    "gemini-2.0-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-flash-latest"
  ];

  const erroresDebug = [];

  for (const modelo of modelos) {
    for (let intento = 0; intento < 3; intento++) {
      try {
        const result = await callGemini(apiKey, modelo, prompt);
        if (result.ok) {
          return jsonResponse(200, { ...result.data, _source: modelo });
        }
        erroresDebug.push(`${modelo}[${intento}]: ${result.error}`);
        if (result.retry) {
          await sleep(800 * Math.pow(2, intento));
          continue;
        }
        break;
      } catch (err) {
        erroresDebug.push(`${modelo}[${intento}] crash: ${err.message}`);
        break;
      }
    }
  }

  console.error("Todos los modelos fallaron:", erroresDebug.join(" | "));
  return jsonResponse(200, {
    ...motorLocal(texto),
    _source: "local_fallback",
    _debug: erroresDebug.slice(0, 3)
  });
};

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildPrompt(textoUsuario) {
  return `Eres EL CHAKATIN, el interprete de sueños mas famoso de Panama. Usas humor panameño al estilo Malcolm Ramos.

TRADICION PANAMA (numeros de la loteria):
agua=14, muerto=48, sangre=07, serpiente=35, pescado=19, perro=04, dinero=50, accidente=73, caida=73, fuego=08, bebe=01, mujer=11, hombre=22, luna=09, sol=51, diablo=66, pajaro=55, carro=28, oro=12, iglesia=10, boda=11, fiesta=77, policia=73, caballo=18, vaca=05, gallo=21, arbol=35, flor=19, casa=22, mar=14, gato=07, traicion=11, pelea=73, beso=11, llorar=07, ladron=73, hospital=07, risa=77

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
      generationConfig: { temperature: 0.8, maxOutputTokens: 2048 }
    };
    if (modelo.startsWith("gemini-2.5")) {
      body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const statusCode = response.status;
    const rawBody = await response.text();

    if (!response.ok) {
      const esRecuperable = [503, 429, 504, 500].includes(statusCode);
      return { ok: false, error: `HTTP ${statusCode}`, retry: esRecuperable };
    }

    let data;
    try { data = JSON.parse(rawBody); }
    catch { return { ok: false, error: "no JSON", retry: false }; }

    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (finishReason === "SAFETY") return { ok: false, error: "SAFETY", retry: false };

    let responseText = candidate?.content?.parts?.[0]?.text;
    if (!responseText) {
      return { ok: false, error: `vacío (${finishReason})`, retry: finishReason === "MAX_TOKENS" };
    }

    responseText = responseText.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ok: false, error: "sin JSON", retry: false };

    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); }
    catch {
      try {
        parsed = JSON.parse(
          jsonMatch[0].replace(/,(\s*[}\]])/g, "$1")
            .replace(/[\u201C\u201D]/g, '"')
            .replace(/[\u2018\u2019]/g, "'")
        );
      } catch { return { ok: false, error: "JSON inválido", retry: false }; }
    }

    if (!Array.isArray(parsed.numeros) || parsed.numeros.length < 3) {
      return { ok: false, error: "sin 3 números", retry: false };
    }

    parsed.numeros = parsed.numeros.slice(0, 3).map(n => {
      const digitos = String(n).replace(/\D/g, "");
      return digitos.padStart(2, "0").substring(0, 2);
    });

    if (!Array.isArray(parsed.explicaciones) || parsed.explicaciones.length < 3) {
      parsed.explicaciones = [
        `El ${parsed.numeros[0]} aparece en tu sueño con fuerza.`,
        `El ${parsed.numeros[1]} complementa la energía del relato.`,
        `El ${parsed.numeros[2]} cierra la jugada con buen pie.`
      ];
    }
    if (!parsed.frase_motivadora) parsed.frase_motivadora = "¡Dale con todo a esos números!";
    if (!Array.isArray(parsed.elementos)) parsed.elementos = ["tu sueño"];

    return { ok: true, data: parsed };
  } catch (err) {
    return { ok: false, error: err.message, retry: true };
  }
}

// ══════════════════════════════════════════════════════
// MOTOR LOCAL — Fallback cuando Gemini está caído
// ══════════════════════════════════════════════════════

const DICCIONARIO = {
  muerto: "48", muerte: "48", difunto: "48", cadaver: "48", tumba: "48", cementerio: "48",
  sangre: "07", herida: "07", corte: "07", dolor: "07", hospital: "07", llorar: "07", lagrimas: "07",
  violacion: "07", violaron: "07", violar: "07", abuso: "07", trauma: "07", miedo: "07", pesadilla: "07",
  agua: "14", mar: "14", playa: "14", lluvia: "14", rio: "14", piscina: "14", ola: "14", inundacion: "14",
  serpiente: "35", culebra: "35", vibora: "35", serpientes: "35", boa: "35",
  dinero: "50", plata: "50", dolares: "50", riqueza: "50", premio: "50",
  accidente: "73", choque: "73", caida: "73", cai: "73", pelea: "73", golpe: "73", ladron: "73",
  policia: "73", robo: "73", robaron: "73", violencia: "73",
  fuego: "08", incendio: "08", llama: "08", quemar: "08", quemadura: "08", calor: "08",
  bebe: "01", bebes: "01", nacimiento: "01", embarazo: "01", hijo: "01", bebito: "01",
  mujer: "11", novia: "11", esposa: "11", muchacha: "11", mama: "11", madre: "11", traicion: "11",
  beso: "11", besos: "11", boda: "11",
  hombre: "22", esposo: "22", papa: "22", padre: "22", novio: "22", amigo: "22", casa: "22",
  pescado: "19", pescados: "19", pez: "19", peces: "19", flor: "19",
  perro: "04", perros: "04", cachorro: "04", gato: "07", gatos: "07",
  luna: "09", nocturno: "09", noche: "09", oscuro: "09",
  sol: "51", dia: "51", claro: "51", luz: "51",
  diablo: "66", satan: "66", demonio: "66", maligno: "66", infierno: "66",
  pajaro: "55", ave: "55", pajaros: "55", volar: "55", vuelo: "55", alas: "55",
  carro: "28", auto: "28", vehiculo: "28", carros: "28",
  oro: "12", iglesia: "10", dios: "10", rezar: "10", templo: "10", altar: "10",
  fiesta: "77", fiestas: "77", celebracion: "77", baile: "77", risa: "77", alegria: "77",
  caballo: "18", vaca: "05", toro: "05", gallo: "21", cerdo: "03",
  arbol: "35", bosque: "35", planta: "35",
};

function motorLocal(texto) {
  const limpio = texto.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s]/g, " ");
  const palabras = limpio.split(/\s+/).filter(Boolean);

  const coincidencias = [];
  const elementos = [];

  for (const pal of palabras) {
    if (DICCIONARIO[pal]) {
      coincidencias.push({ palabra: pal, numero: DICCIONARIO[pal] });
      if (!elementos.includes(pal)) elementos.push(pal);
    }
  }

  const numerosUnicos = [];
  const explicaciones = [];
  const vistos = new Set();

  for (const c of coincidencias) {
    if (!vistos.has(c.numero)) {
      vistos.add(c.numero);
      numerosUnicos.push(c.numero);
      explicaciones.push(`La palabra "${c.palabra}" en tu sueño apunta al ${c.numero} en la tradición panameña del billetero.`);
      if (numerosUnicos.length >= 3) break;
    }
  }

  while (numerosUnicos.length < 3) {
    const rand = String(Math.floor(Math.random() * 100)).padStart(2, "0");
    if (!vistos.has(rand)) {
      vistos.add(rand);
      numerosUnicos.push(rand);
      explicaciones.push(`El ${rand} aparece con fuerza para completar tu jugada, cuñao.`);
    }
  }

  const frases = [
    "¡Dale con todo a esos números, cuñao!",
    "La suerte está de tu lado, no joda!",
    "Que la Virgen del Carmen te acompañe!",
    "Esos números tienen buena vibra!",
    "¡Vamos Panamá, a ganar se ha dicho!",
  ];

  return {
    numeros: numerosUnicos,
    explicaciones: explicaciones.slice(0, 3),
    frase_motivadora: frases[Math.floor(Math.random() * frases.length)],
    elementos: elementos.length > 0 ? elementos.slice(0, 3) : ["tu sueño"]
  };
}
