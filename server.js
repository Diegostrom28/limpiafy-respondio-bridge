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

function isNumericId(value) {
  return /^\d+$/.test(String(value ?? "").trim());
}

function parseCalendar(value) {
  if (Array.isArray(value)) return value;

  if (typeof value !== "string") {
    throw new Error("calendario debe ser un arreglo o un texto JSON válido");
  }

  const parsed = JSON.parse(value);

  if (!Array.isArray(parsed)) {
    throw new Error("calendario debe contener un arreglo");
  }

  return parsed;
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
  if (!data) return [];
  if (Array.isArray(data)) return data;

  if (typeof data === "object") {
    return Object.values(data).filter(
      (value) => value && typeof value === "object" && !Array.isArray(value)
    );
  }

  return [];
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
    "prm_paquete"
  ];

  for (const key of idKeys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      return String(row[key]);
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
  let score = 0;

  for (const term of searchTerms.filter(Boolean)) {
    const normalized = normalizeText(term);
    if (!normalized) continue;

    if (text === normalized) score += 100;
    else if (text.includes(normalized)) score += 30;

    for (const word of normalized.split(/\s+/).filter(Boolean)) {
      if (text.includes(word)) score += 5;
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
  if (isNumericId(value)) return String(value);

  const rows = await callBuscar("DEPARTAMENTOS_CIUDADES", String(value));
  const ranked = rows
    .map((row) => ({ row, score: scoreRow(row, [value]) }))
    .filter(({ row, score }) => score > 0 && findIdField(row))
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    throw new Error(`No se encontró un ID válido para la ciudad "${value}"`);
  }

  if (
    ranked.length > 1 &&
    ranked[0].score === ranked[1].score &&
    findIdField(ranked[0].row) !== findIdField(ranked[1].row)
  ) {
    throw new Error(`La ciudad "${value}" tiene más de una coincidencia`);
  }

  return findIdField(ranked[0].row);
}

async function resolvePropertyTypeId(value) {
  if (isNumericId(value)) return String(value);

  const rows = await callBuscar("TIPO_INMUEBLE", String(value));
  const ranked = rows
    .map((row) => ({ row, score: scoreRow(row, [value]) }))
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
  if (isNumericId(value)) return String(value);

  const rows = await callBuscar("TODOS_PAQUETES", "");
  const category = expectedPackageCategory(propertyType);

  const ranked = rows
    .map((row) => ({
      row,
      score:
        scoreRow(row, [value]) +
        (category && rowText(row).includes(category) ? 50 : 0)
    }))
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
    endpoints: ["/health", "/cotizar-respondio"]
  });
});

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "limpiafy-respondio-bridge"
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

    const parsedCalendar = parseCalendar(calendario);
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
