import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const {
  PORT = "3000",
  LIMPIAFY_API_URL,
  LIMPIAFY_X_APP,
  LIMPIAFY_X_TOKEN,
  LIMPIAFY_X_KEY
} = process.env;

function validateEnvironment() {
  const required = {
    LIMPIAFY_API_URL,
    LIMPIAFY_X_APP,
    LIMPIAFY_X_TOKEN,
    LIMPIAFY_X_KEY
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Faltan variables de entorno: ${missing.join(", ")}`);
  }
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function compactText(value) {
  return normalizeText(value)
    .replace(/\uFFFD/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function textMatches(candidate, search) {
  const candidateCompact = compactText(candidate);
  const searchCompact = compactText(search);

  if (!candidateCompact || !searchCompact) {
    return false;
  }

  return (
    candidateCompact === searchCompact ||
    candidateCompact.includes(searchCompact) ||
    searchCompact.includes(candidateCompact)
  );
}

function isNumericId(value) {
  return /^\d+$/.test(String(value ?? "").trim());
}

const CITY_ID_ALIASES = new Map([
  ["bogota", "12688"],
  ["bogota d.c.", "12688"],
  ["bogotadc", "12688"]
]);

function resolveKnownCityAlias(value) {
  const normalized = compactText(value);

  for (const [name, id] of CITY_ID_ALIASES.entries()) {
    if (compactText(name) === normalized) {
      return id;
    }
  }

  return null;
}

function parseCalendar(value) {
  let current = value;

  // Respond.io puede enviar el arreglo como JSON serializado una o dos veces.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (Array.isArray(current)) {
      return current;
    }

    if (typeof current !== "string") {
      break;
    }

    const trimmed = current.trim();

    if (!trimmed) {
      throw new Error("calendario está vacío");
    }

    try {
      current = JSON.parse(trimmed);
    } catch {
      throw new Error("calendario no contiene un JSON válido");
    }
  }

  if (!Array.isArray(current)) {
    throw new Error(
      `calendario debe contener un arreglo; se recibió ${typeof current}`
    );
  }

  return current;
}

function validateCalendar(calendar, requiredDays) {
  if (calendar.length !== requiredDays) {
    throw new Error(
      `dias_requeridos es ${requiredDays}, pero calendario contiene ${calendar.length} elementos`
    );
  }

  return calendar.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`El elemento ${index + 1} de calendario no es válido`);
    }

    if (!item.fecha) {
      throw new Error(`Falta fecha en el elemento ${index + 1} del calendario`);
    }

    if (!item.horario) {
      throw new Error(`Falta horario en el elemento ${index + 1} del calendario`);
    }

    return {
      fecha: String(item.fecha),
      horario: String(item.horario),
      hora_adicional:
        item.hora_adicional === undefined ||
        item.hora_adicional === null ||
        item.hora_adicional === ""
          ? "0"
          : String(item.hora_adicional)
    };
  });
}

function extractRows(data) {
  const rows = [];
  const seen = new Set();

  function visit(value) {
    if (!value || typeof value !== "object") {
      return;
    }

    if (seen.has(value)) {
      return;
    }

    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    // Conserva cada objeto como posible registro y sigue recorriendo
    // sus propiedades para soportar respuestas anidadas.
    rows.push(value);

    for (const child of Object.values(value)) {
      visit(child);
    }
  }

  visit(data);

  return rows;
}

function findIdField(row) {
  const idKeys = [
    "id",
    "id_ciudad",
    "ciudad_id",
    "id_tipo_inmueble",
    "tipo_inmueble_id",
    "id_paquete",
    "paquete_id",
    "prm_ciudad",
    "prm_tipo_inmueble",
    "prm_paquete",
    "codigo",
    "code",
    "value",
    "valor"
  ];

  for (const key of idKeys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      const candidate = String(row[key]).trim();

      if (/^\d+$/.test(candidate)) {
        return candidate;
      }
    }
  }

  // Respaldo genérico: encuentra cualquier propiedad cuyo nombre sugiera
  // identificador o código y cuyo valor sea numérico.
  for (const [key, value] of Object.entries(row)) {
    if (
      /(id|codigo|code|value|valor)/i.test(key) &&
      value !== undefined &&
      value !== null &&
      /^\d+$/.test(String(value).trim())
    ) {
      return String(value).trim();
    }
  }

  return null;
}

function rowText(row) {
  return normalizeText(
    Object.entries(row)
      .filter(([key]) => !/^(id|estado|iva|valor|fecha|cantidad|min|max)/i.test(key))
      .map(([, value]) => value)
      .join(" ")
  );
}

function scoreRow(row, searchTerms) {
  const text = rowText(row);
  const compactRow = compactText(text);
  let score = 0;

  for (const term of searchTerms.filter(Boolean)) {
    const normalized = normalizeText(term);
    const compactTerm = compactText(term);

    if (!normalized || !compactTerm) {
      continue;
    }

    if (text === normalized) {
      score += 100;
    } else if (text.includes(normalized)) {
      score += 30;
    }

    if (compactRow === compactTerm) {
      score += 120;
    } else if (compactRow.includes(compactTerm)) {
      score += 60;
    }

    for (const word of normalized.split(/\s+/).filter(Boolean)) {
      if (text.includes(word)) {
        score += 5;
      }
    }
  }

  return score;
}

async function callBuscar(tipo, valor = "") {
  const response = await fetch(
    `${LIMPIAFY_API_URL.replace(/\/$/, "")}/clientes/agenteIA/buscar`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-APP": LIMPIAFY_X_APP,
        "X-TOKEN": LIMPIAFY_X_TOKEN,
        "X-KEY": LIMPIAFY_X_KEY
      },
      body: JSON.stringify({ tipo, valor })
    }
  );

  const raw = await response.text();
  let body;

  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(`Respuesta inválida al consultar ${tipo}: ${raw}`);
  }

  if (!response.ok || body?.success === 0) {
    throw new Error(
      body?.message || body?.error || `No fue posible consultar ${tipo}`
    );
  }

  return extractRows(body?.data);
}

async function resolveCityId(value) {
  if (isNumericId(value)) {
    return String(value);
  }

  const original = String(value ?? "").trim();

  if (!original) {
    throw new Error("La ciudad está vacía");
  }

  const candidates = [
    original,
    original.replace(/\uFFFD/g, ""),
    normalizeText(original),
    compactText(original)
  ].filter(Boolean);

  const uniqueCandidates = [...new Set(candidates)];

  for (const candidate of uniqueCandidates) {
    const rows = await callBuscar("DEPARTAMENTOS_CIUDADES", candidate);

    console.log(
      `Consulta de ciudad "${candidate}" devolvió:`,
      rows.length,
      "registros"
    );

    console.log(
      "Muestra de ciudad:",
      JSON.stringify(rows.slice(0, 5))
    );

    const ranked = rows
      .map((row) => {
        const text = rowText(row);
        const tolerantBonus = textMatches(text, original) ? 100 : 0;

        return {
          row,
          score: scoreRow(row, [original, candidate]) + tolerantBonus
        };
      })
      .filter(({ row, score }) => score > 0 && findIdField(row))
      .sort((a, b) => b.score - a.score);

    if (ranked.length > 0) {
      if (
        ranked.length > 1 &&
        ranked[0].score === ranked[1].score &&
        findIdField(ranked[0].row) !== findIdField(ranked[1].row)
      ) {
        throw new Error(
          `La ciudad "${original}" tiene más de una coincidencia`
        );
      }

      const id = findIdField(ranked[0].row);

      console.log(`Ciudad resuelta: ${original} -> ${id}`);
      return id;
    }
  }

  const knownAliasId =
    typeof resolveKnownCityAlias === "function"
      ? resolveKnownCityAlias(original)
      : null;

  if (knownAliasId) {
    console.log(`Ciudad resuelta por alias: ${original} -> ${knownAliasId}`);
    return knownAliasId;
  }

  throw new Error(
    `No se encontró un ID válido para la ciudad "${original}"`
  );
}

async function resolvePropertyTypeId(value) {
  if (isNumericId(value)) {
    return String(value);
  }

  const rows = await callBuscar("TIPO_INMUEBLE", String(value));
  console.log("Registros de tipo de inmueble encontrados:", rows.length);

  const ranked = rows
    .map((row) => ({
      row,
      score: scoreRow(row, [value])
    }))
    .filter(({ row, score }) => score > 0 && findIdField(row))
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    throw new Error(
      `No se encontró un ID válido para el tipo de inmueble "${value}"`
    );
  }

  return findIdField(ranked[0].row);
}

function expectedPackageCategory(propertyType) {
  const normalized = normalizeText(propertyType);

  if (
    normalized.includes("oficina") ||
    normalized.includes("empresa") ||
    normalized.includes("corporativo")
  ) {
    return "empresas oficinas";
  }

  if (
    normalized.includes("casa") ||
    normalized.includes("apartamento") ||
    normalized.includes("hogar")
  ) {
    return "hogar";
  }

  return "";
}

async function resolvePackageId(value, propertyType) {
  if (isNumericId(value)) {
    return String(value);
  }

  const rows = await callBuscar("TODOS_PAQUETES", "");
  console.log("Registros de paquetes encontrados:", rows.length);
  const category = expectedPackageCategory(propertyType);

  const ranked = rows
    .map((row) => {
      const rowNormalizedText = rowText(row);

      return {
        row,
        score:
          scoreRow(row, [value]) +
          (
            category &&
            compactText(rowNormalizedText).includes(compactText(category))
              ? 50
              : 0
          )
      };
    })
    .filter(({ row, score }) => score > 0 && findIdField(row))
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    throw new Error(`No se encontró un ID válido para el paquete "${value}"`);
  }

  return findIdField(ranked[0].row);
}

app.get("/", (_request, response) => {
  response.json({
    status: "ok",
    service: "limpiafy-respondio-bridge",
    version: "1.6.0",
    endpoints: ["/health", "/cotizar-respondio"]
  });
});

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "limpiafy-respondio-bridge",
    version: "1.6.0"
  });
});

app.post("/cotizar-respondio", async (request, response) => {
  try {
    const {
      prm_ciudad,
      dias_requeridos,
      direccion,
      dni_cliente,
      prm_paquete,
      calendario,
      prm_tipo_inmueble
    } = request.body ?? {};

    const requiredFields = {
      prm_ciudad,
      dias_requeridos,
      direccion,
      dni_cliente,
      prm_paquete,
      calendario,
      prm_tipo_inmueble
    };

    const missingFields = Object.entries(requiredFields)
      .filter(([, value]) => value === undefined || value === null || value === "")
      .map(([key]) => key);

    if (missingFields.length > 0) {
      return response.status(400).json({
        success: 0,
        code: "MISSING_FIELDS",
        message: `Faltan campos: ${missingFields.join(", ")}`
      });
    }

    const numberOfDays = Number(dias_requeridos);

    if (!Number.isInteger(numberOfDays) || numberOfDays < 1) {
      return response.status(400).json({
        success: 0,
        code: "INVALID_DAYS",
        message: "dias_requeridos debe ser un número entero mayor que cero"
      });
    }

    console.log("Calendario recibido:", { tipo: typeof calendario, valor: calendario });
    const parsedCalendar = parseCalendar(calendario);
    console.log("Calendario convertido:", { esArray: Array.isArray(parsedCalendar), elementos: parsedCalendar.length });
    const validatedCalendar = validateCalendar(parsedCalendar, numberOfDays);

    const [cityId, propertyTypeId, packageId] = await Promise.all([
      resolveCityId(prm_ciudad),
      resolvePropertyTypeId(prm_tipo_inmueble),
      resolvePackageId(prm_paquete, prm_tipo_inmueble)
    ]);

    const payload = {
      prm_ciudad: cityId,
      dias_requeridos: String(numberOfDays),
      direccion: String(direccion),
      dni_cliente: String(dni_cliente),
      prm_paquete: packageId,
      calendario: validatedCalendar,
      prm_tipo_inmueble: propertyTypeId
    };

    console.log("Payload enviado a Limpiafy:", JSON.stringify(payload));

    const upstreamResponse = await fetch(
      `${LIMPIAFY_API_URL.replace(/\/$/, "")}/clientes/agenteIA/cotizar`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-APP": LIMPIAFY_X_APP,
          "X-TOKEN": LIMPIAFY_X_TOKEN,
          "X-KEY": LIMPIAFY_X_KEY
        },
        body: JSON.stringify(payload)
      }
    );

    const rawBody = await upstreamResponse.text();

    let body;

    try {
      body = JSON.parse(rawBody);
    } catch {
      body = {
        success: 0,
        code: "INVALID_UPSTREAM_RESPONSE",
        message: rawBody || "La API de Limpiafy devolvió una respuesta vacía"
      };
    }

    return response.status(upstreamResponse.status).json(body);
  } catch (error) {
    console.error("Bridge error:", error);

    return response.status(400).json({
      success: 0,
      code: "BRIDGE_ERROR",
      message:
        error instanceof Error
          ? error.message
          : "No fue posible procesar la cotización"
    });
  }
});

try {
  validateEnvironment();

  app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`Servidor activo en el puerto ${PORT}`);
  });
} catch (error) {
  console.error(error);
  process.exit(1);
}
