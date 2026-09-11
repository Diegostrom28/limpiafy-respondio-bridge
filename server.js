import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const {
  PORT = "3000",
  LIMPIAFY_API_URL = "https://r394ip4mkf.execute-api.us-east-1.amazonaws.com/clientes",
  LIMPIAFY_X_APP,
  LIMPIAFY_X_TOKEN,
  LIMPIAFY_X_KEY
} = process.env;

const VERSION = "2.0.0";

function validateEnvironment() {
  const missing = [];
  if (!LIMPIAFY_API_URL) missing.push("LIMPIAFY_API_URL");
  if (!LIMPIAFY_X_APP) missing.push("LIMPIAFY_X_APP");
  if (!LIMPIAFY_X_TOKEN) missing.push("LIMPIAFY_X_TOKEN");
  if (!LIMPIAFY_X_KEY) missing.push("LIMPIAFY_X_KEY");
  if (missing.length) throw new Error(`Faltan variables de entorno: ${missing.join(", ")}`);
}

function apiHeaders() {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-APP": LIMPIAFY_X_APP,
    "X-TOKEN": LIMPIAFY_X_TOKEN,
    "X-KEY": LIMPIAFY_X_KEY
  };
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\uFFFD/g, "")
    .toLowerCase()
    .trim();
}

function compactText(value) {
  return normalizeText(value).replace(/[^a-z0-9]/g, "");
}

function isNumericId(value) {
  return /^\d+$/.test(String(value ?? "").trim());
}

function addHours(time, hoursToAdd) {
  const match = String(time ?? "").match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const h = Number(match[1]), m = Number(match[2]), s = Number(match[3] ?? 0);
  if (h > 23 || m > 59 || s > 59) return null;
  const total = (h * 3600 + m * 60 + s + Number(hoursToAdd) * 3600) % 86400;
  const hh = String(Math.floor(total / 3600)).padStart(2, "0");
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

async function callApi(path, body) {
  const url = `${LIMPIAFY_API_URL.replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
  const apiResponse = await fetch(url, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify(body)
  });

  const raw = await apiResponse.text();
  let parsed;
  try { parsed = raw ? JSON.parse(raw) : {}; }
  catch { parsed = { raw }; }

  if (!apiResponse.ok) {
    const error = new Error(`Limpiafy API respondió HTTP ${apiResponse.status}`);
    error.status = apiResponse.status;
    error.payload = parsed;
    throw error;
  }
  return parsed;
}

function unwrapData(response) {
  return response && typeof response === "object" && "data" in response ? response.data : response;
}

function objectRows(value) {
  const data = unwrapData(value);
  const rows = [];
  const visit = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object") return;

    const keys = Object.keys(node);
    const looksLikeRow = keys.some((key) =>
      /^(id|id[A-Z_]|nombre|nombre[A-Z_]|categoria|departamento|ciudad|valor_|habilitada_)/i.test(key)
    );
    if (looksLikeRow) rows.push(node);

    for (const [key, child] of Object.entries(node)) {
      if (key === "fecha_actual") continue;
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(data);

  const seen = new Set();
  return rows.filter((row) => {
    const sig = JSON.stringify(row);
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

function pickNumeric(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && /^\d+$/.test(String(value).trim())) {
      return String(value).trim();
    }
  }
  return null;
}

function scoreText(haystack, needle) {
  const h = compactText(haystack), n = compactText(needle);
  if (!h || !n) return 0;
  if (h === n) return 1000;
  if (h.includes(n)) return 500;
  if (n.includes(h)) return 250;
  return 0;
}

async function buscar(tipo, valor = "") {
  return callApi("agenteIA/buscar", { tipo, valor });
}

async function resolveCityId(value) {
  if (isNumericId(value)) return String(value);
  const candidates = [...new Set([
    String(value ?? "").trim(),
    String(value ?? "").replace(/\uFFFD/g, "").trim(),
    normalizeText(value)
  ].filter(Boolean))];

  for (const candidate of candidates) {
    const response = await buscar("DEPARTAMENTOS_CIUDADES", candidate);
    const rows = objectRows(response);
    const ranked = rows.map((row) => ({
      row,
      id: pickNumeric(row, ["idCiudad", "id_ciudad", "ciudad_id"]),
      score: scoreText(row.nombreCiudad ?? row.nombre_ciudad ?? row.ciudad ?? "", candidate) +
        (String(row.habilitada_para_limpiafy ?? "1") === "1" ? 50 : -1000)
    })).filter(x => x.id && x.score > 0).sort((a,b) => b.score-a.score);

    if (ranked.length) {
      console.log(`Ciudad resuelta: ${value} -> ${ranked[0].id}`);
      return ranked[0].id;
    }
  }
  throw new Error(`No se encontró una ciudad válida para "${value}"`);
}

async function resolvePropertyTypeId(value) {
  if (isNumericId(value)) return String(value);
  const rows = objectRows(await buscar("TIPO_INMUEBLE", ""));
  const ranked = rows.map((row) => ({
    id: pickNumeric(row, ["id", "idTipoInmueble", "id_tipo_inmueble", "tipo_inmueble_id"]),
    score: scoreText(row.nombre ?? row.nombreTipoInmueble ?? row.tipo_inmueble ?? row.descripcion ?? "", value)
  })).filter(x => x.id && x.score > 0).sort((a,b) => b.score-a.score);

  if (!ranked.length) throw new Error(`No se encontró el tipo de inmueble "${value}"`);
  console.log(`Tipo de inmueble resuelto: ${value} -> ${ranked[0].id}`);
  return ranked[0].id;
}

function expectedPackageCategory(propertyType) {
  const t = normalizeText(propertyType);
  if (/(oficina|empresa|corporativo)/.test(t)) return "empresas oficinas";
  if (/(casa|apartamento|hogar)/.test(t)) return "hogar";
  return "";
}

async function resolvePackageId(value, propertyType) {
  if (isNumericId(value)) return String(value);
  const rows = objectRows(await buscar("TODOS_PAQUETES", ""));
  const expected = compactText(expectedPackageCategory(propertyType));

  const ranked = rows.map((row) => {
    const name = row.nombre_paquete ?? row.nombrePaquete ?? row.nombre ?? "";
    const category = row.categoria_servicio ?? row.categoria ?? "";
    let score = scoreText(name, value);
    if (expected && compactText(category).includes(expected)) score += 200;
    return {
      id: pickNumeric(row, ["id", "idPaquete", "id_paquete", "paquete_id"]),
      score
    };
  }).filter(x => x.id && x.score > 0).sort((a,b) => b.score-a.score);

  if (!ranked.length) throw new Error(`No se encontró el paquete "${value}"`);
  if (ranked.length > 1 && ranked[0].score === ranked[1].score && ranked[0].id !== ranked[1].id) {
    throw new Error(`El paquete "${value}" tiene más de una coincidencia`);
  }
  console.log(`Paquete resuelto: ${value} -> ${ranked[0].id}`);
  return ranked[0].id;
}

function parseCalendar(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("calendario no es un arreglo");
    return parsed;
  }
  throw new Error("calendario debe ser un arreglo o un JSON de texto");
}

function normalizeCalendar(rawCalendar) {
  return parseCalendar(rawCalendar).map((item, index) => {
    const fecha = String(item?.fecha ?? "").trim();
    const horaInicial = String(item?.hora_inicial ?? item?.horario ?? item?.hora ?? "").trim();

    const horaAdicional =
      item?.hora_adicional === undefined || item?.hora_adicional === null || item?.hora_adicional === ""
        ? 0
        : Number(item.hora_adicional);

    if (!fecha) throw new Error(`Falta fecha en calendario[${index}]`);
    if (!horaInicial) throw new Error(`Falta hora en calendario[${index}]`);
    if (!Number.isFinite(horaAdicional) || horaAdicional < 0) {
      throw new Error(`hora_adicional inválida en calendario[${index}]`);
    }

    const horasBase =
      item?.horas === undefined || item?.horas === null || item?.horas === ""
        ? 8
        : Number(item.horas);

    const horaFinal = String(item?.hora_final ?? "").trim() || addHours(horaInicial, horasBase + horaAdicional);

    return {
      fecha,
      hora_inicial: horaInicial,
      hora_final: horaFinal,
      hora_adicional: horaAdicional
    };
  });
}

function bridgeError(response, error) {
  console.error("Bridge error:", error);
  if (error?.payload) console.error("Respuesta API:", JSON.stringify(error.payload));
  return response.status(500).json({
    success: 0,
    code: "BRIDGE_ERROR",
    message: error?.message ?? "Error procesando la solicitud",
    api: error?.payload ?? undefined
  });
}

app.get("/", (_req, res) => res.json({
  status: "ok",
  service: "limpiafy-respondio-bridge",
  version: VERSION,
  environment: "production",
  endpoints: ["/health", "/debug-respondio", "/consultar-paquetes", "/consultar-ciudades", "/consultar-tipos-inmueble", "/cotizar-respondio"]
}));

app.get("/health", (_req, res) => res.json({
  status: "ok",
  service: "limpiafy-respondio-bridge",
  version: VERSION
}));

app.post("/debug-respondio", (req, res) => {
  console.log("DEBUG RESPOND.IO:", JSON.stringify({ headers: req.headers, body: req.body }));
  res.json({ success: 1, source: "LIMPIAFY_BRIDGE", version: VERSION, receivedBody: req.body });
});

app.post("/consultar-paquetes", async (_req, res) => {
  try { return res.json(await buscar("TODOS_PAQUETES", "")); }
  catch (error) { return bridgeError(res, error); }
});

app.post("/consultar-ciudades", async (req, res) => {
  try {
    const valor = req.body?.valor ?? req.body?.ciudad ?? "";
    return res.json(await buscar("DEPARTAMENTOS_CIUDADES", valor));
  } catch (error) { return bridgeError(res, error); }
});

app.post("/consultar-tipos-inmueble", async (_req, res) => {
  try { return res.json(await buscar("TIPO_INMUEBLE", "")); }
  catch (error) { return bridgeError(res, error); }
});

app.post("/cotizar-respondio", async (req, res) => {
  try {
    const input = req.body ?? {};
    const dniCliente = String(input.dni_cliente ?? "").trim();
    const direccion = String(input.direccion ?? "").trim();

    if (!dniCliente) throw new Error("Falta dni_cliente");
    if (!direccion) throw new Error("Falta direccion");
    if (!input.prm_ciudad) throw new Error("Falta prm_ciudad");
    if (!input.prm_paquete) throw new Error("Falta prm_paquete");
    if (!input.prm_tipo_inmueble) throw new Error("Falta prm_tipo_inmueble");

    const calendario = normalizeCalendar(input.calendario);
    const diasRequeridos = Number(input.dias_requeridos ?? calendario.length);

    if (!Number.isInteger(diasRequeridos) || diasRequeridos <= 0) {
      throw new Error("dias_requeridos debe ser un entero mayor que 0");
    }
    if (diasRequeridos !== calendario.length) {
      throw new Error(`dias_requeridos (${diasRequeridos}) no coincide con calendario (${calendario.length})`);
    }

    const [prmCiudad, prmTipoInmueble, prmPaquete] = await Promise.all([
      resolveCityId(input.prm_ciudad),
      resolvePropertyTypeId(input.prm_tipo_inmueble),
      resolvePackageId(input.prm_paquete, input.prm_tipo_inmueble)
    ]);

    const payload = {
      dni_cliente: dniCliente,
      prm_paquete: Number(prmPaquete),
      dias_requeridos: diasRequeridos,
      prm_ciudad: Number(prmCiudad),
      direccion,
      prm_tipo_inmueble: Number(prmTipoInmueble),
      calendario
    };

    if (input.cupon) payload.cupon = String(input.cupon).trim();
    if (input.id_partner && isNumericId(input.id_partner)) payload.id_partner = Number(input.id_partner);
    else if (input.dni_empleada) payload.dni_empleada = String(input.dni_empleada).trim();

    console.log("Payload enviado a Limpiafy:", JSON.stringify(payload));
    const apiResponse = await callApi("agenteIA/cotizar", payload);
    console.log("Respuesta cotización:", JSON.stringify(apiResponse));
    return res.status(200).json(apiResponse);
  } catch (error) {
    return bridgeError(res, error);
  }
});

try {
  validateEnvironment();
  app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`Servidor ${VERSION} activo en el puerto ${PORT} usando ${LIMPIAFY_API_URL}`);
  });
} catch (error) {
  console.error(error);
  process.exit(1);
}
