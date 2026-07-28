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

function parseCalendar(value) {
  if (Array.isArray(value)) {
    return value;
  }

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

    const payload = {
      prm_ciudad: String(prm_ciudad),
      dias_requeridos: String(numberOfDays),
      direccion: String(direccion),
      dni_cliente: String(dni_cliente),
      prm_paquete: String(prm_paquete),
      calendario: validatedCalendar,
      prm_tipo_inmueble: String(prm_tipo_inmueble)
    };

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
