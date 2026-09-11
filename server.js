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

const VERSION = "2.2.6";

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

async function resolveDocumentTypeId(value) {
  if (isNumericId(value)) return Number(value);

  const normalized = compactText(value);
  const aliases = new Set([
    "cc", "cedula", "cedulaciudadania", "ceduladeciudadania"
  ]);

  // Intento 1: resolver contra tablas de parametros si el backend expone alguno
  // de estos tipos de busqueda. Si no existe, seguimos con el fallback seguro.
  const searchTypes = [
    "TIPO_IDENTIFICACION",
    "TIPO_DOCUMENTO",
    "TIPOS_IDENTIFICACION",
    "PRM_TIPO_IDENTIFICACION"
  ];

  for (const tipo of searchTypes) {
    try {
      const response = await buscar(tipo, String(value ?? ""));
      const rows = objectRows(response);
      const ranked = rows.map((row) => ({
        id: pickNumeric(row, [
          "id", "idTipoIdentificacion", "id_tipo_identificacion",
          "prm_tipo_identificacion", "tipo_identificacion_id"
        ]),
        score: scoreText(
          row.nombre ?? row.descripcion ?? row.tipo_identificacion ??
          row.nombreTipoIdentificacion ?? row.nombre_tipo_identificacion ?? "",
          value
        )
      })).filter(x => x.id && x.score > 0).sort((a,b) => b.score-a.score);

      if (ranked.length) {
        console.log(`Tipo de documento resuelto por ${tipo}: ${value} -> ${ranked[0].id}`);
        return Number(ranked[0].id);
      }
    } catch (error) {
      console.log(`Busqueda ${tipo} no disponible para tipo_documento`);
    }
  }

  // Fallback documentado por la coleccion suministrada para persona natural.
  if (aliases.has(normalized)) {
    console.log(`Tipo de documento resuelto por alias: ${value} -> 1`);
    return 1;
  }

  throw new Error(`tipo_documento no reconocido: "${value}". Envia un ID numerico o Cedula de Ciudadania.`);
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

function getBogotaNowParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function formatYmdUtc(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getBogotaTomorrow(now = new Date()) {
  const p = getBogotaNowParts(now);
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day));
  base.setUTCDate(base.getUTCDate() + 1);
  return formatYmdUtc(base);
}

function shouldApply4PM(calendar, now = new Date()) {
  const p = getBogotaNowParts(now);
  const atOrAfterFourPm = (p.hour * 60 + p.minute) >= (16 * 60);
  if (!atOrAfterFourPm) return false;

  const tomorrow = getBogotaTomorrow(now);
  return calendar.some((item) => String(item?.fecha ?? "").trim() === tomorrow);
}

function normalizeAdditionalServices(value) {
  const parsed = parseJsonIfNeeded(value, "servicios_adicionales");
  if (parsed === undefined || parsed === null || parsed === "") return [];
  if (!Array.isArray(parsed)) throw new Error("servicios_adicionales debe ser un arreglo");
  return parsed
    .map((item) => {
      if (item && typeof item === "object" && item.prm_servicios !== undefined) {
        return { ...item, prm_servicios: Number(item.prm_servicios) };
      }
      if (/^\d+$/.test(String(item ?? "").trim())) {
        return { prm_servicios: Number(item) };
      }
      return item;
    })
    .filter(Boolean);
}

function add4PMTaskIfNeeded(payload, input, calendar, now = new Date()) {
  const services = normalizeAdditionalServices(input?.servicios_adicionales);

  if (shouldApply4PM(calendar, now)) {
    const alreadyAdded = services.some((item) => Number(item?.prm_servicios) === 66);
    if (!alreadyAdded) services.push({ prm_servicios: 66 });
    console.log(`Regla 4PM aplicada: tarea 66 agregada. Fecha mañana en Colombia: ${getBogotaTomorrow(now)}`);
  }

  if (services.length) payload.servicios_adicionales = services;
  return payload;
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
      horario: horaInicial,
      hora_inicial: horaInicial,
      hora_final: horaFinal,
      hora_adicional: horaAdicional
    };
  });
}


function parseJsonIfNeeded(value, fieldName) {
  if (value === undefined || value === null || value === "") return value;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!(trimmed.startsWith("[") || trimmed.startsWith("{"))) return value;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${fieldName} contiene JSON inválido: ${error.message}`);
  }
}

function coerceCommonFields(input = {}) {
  const body = { ...input };
  const numericFields = [
    "prm_ciudad", "prm_paquete", "prm_tipo_inmueble", "tipo_documento",
    "id_partner", "id_direccion", "id_reserva", "empleada_domestica_asociada",
    "horas_adicionales", "cantidad_m2", "cantidad_banos", "cantidad_pisos"
  ];

  for (const key of numericFields) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== "" && /^-?\d+(?:\.\d+)?$/.test(String(body[key]).trim())) {
      body[key] = Number(body[key]);
    }
  }

  if (body.limpiapay !== undefined && typeof body.limpiapay === "string") {
    const value = body.limpiapay.trim().toLowerCase();
    if (["true", "1", "si", "sí"].includes(value)) body.limpiapay = true;
    if (["false", "0", "no"].includes(value)) body.limpiapay = false;
  }

  body.servicios_adicionales = parseJsonIfNeeded(body.servicios_adicionales, "servicios_adicionales");
  return body;
}

async function proxyToLimpiafy(path, input = {}, transform = null) {
  let body = coerceCommonFields(input);
  if (transform) body = await transform(body);
  console.log(`Proxy ${path}:`, JSON.stringify(body));
  const result = await callApi(path, body);
  console.log(`Respuesta ${path}:`, JSON.stringify(result));
  return result;
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
  endpoints: [
    "/health", "/debug-respondio",
    "/consultar", "/gestionar-cuenta", "/gestionar-direcciones", "/modificar-reserva",
    "/consultar-paquetes", "/consultar-detalle-paquete", "/consultar-ciudades",
    "/consultar-tipos-inmueble", "/consultar-cliente", "/consultar-direcciones", "/consultar-cupon",
    "/estado-servicio", "/disponibilidad-partner", "/cotizar-respondio", "/pagar",
    "/crear-usuario", "/confirmar-crear-usuario", "/solicitar-actualizacion-usuario", "/confirmar-actualizacion-usuario",
    "/listar-direcciones", "/solicitar-crear-direccion", "/confirmar-crear-direccion",
    "/solicitar-actualizar-direccion", "/confirmar-actualizar-direccion",
    "/simular-modificacion-reserva", "/confirmar-modificacion-reserva"
  ]
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


function removeEmptyFields(input = {}) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

app.post("/consultar", async (req, res) => {
  try {
    const operacion = String(req.body?.operacion ?? "").trim().toUpperCase();
    const valor = req.body?.valor ?? req.body?.ciudad ?? req.body?.cupon ?? req.body?.prm_paquete ?? "";

    const tipos = {
      PAQUETES: "TODOS_PAQUETES",
      DETALLE_PAQUETE: "DETALLE_PAQUETE",
      CIUDAD: "DEPARTAMENTOS_CIUDADES",
      CLIENTE: "CLIENTE_EXISTE",
      DIRECCIONES: "DIRECCIONES_CLIENTE",
      CUPON: "CONSULTAR_CUPON",
      TIPO_INMUEBLE: "TIPO_INMUEBLE"
    };

    const tipo = tipos[operacion];
    if (!tipo) {
      throw new Error(`operacion inválida. Usa: ${Object.keys(tipos).join(", ")}`);
    }

    const valorFinal = ["PAQUETES", "TIPO_INMUEBLE"].includes(operacion) ? "" : valor;
    return res.json(await buscar(tipo, valorFinal));
  } catch (error) { return bridgeError(res, error); }
});

function clientIdentifierCandidates(body = {}) {
  const out = [];
  const add = (key, raw) => {
    const value = raw === undefined || raw === null ? "" : String(raw).trim();
    if (!value) return;
    const sig = `${key}:${value}`;
    if (!out.some(item => item.sig === sig)) out.push({ sig, payload: { [key]: value } });
  };

  // Respetar primero el identificador que realmente envio Respond.io.
  add("dni_cliente", body.dni_cliente);
  add("numero_documento", body.numero_documento);
  add("celular", body.celular);
  add("email", body.email);
  add("valor", body.valor);

  // Para documento, agregamos variantes compatibles con los endpoints historicos.
  const doc = String(body.numero_documento ?? body.dni_cliente ?? "").trim();
  if (doc) {
    add("numero_documento", doc);
    add("dni_cliente", doc);
    add("valor", doc);
  }

  if (!out.length) throw new Error("Falta identificador del Usuario (documento, celular o correo)");
  return out.map(x => x.payload);
}

function firstClientIdentifier(body = {}) {
  return clientIdentifierCandidates(body)[0];
}

async function proxyWithIdentifierFallback(path, body = {}) {
  const candidates = clientIdentifierCandidates(body);
  let lastError;
  for (const identifier of candidates) {
    try {
      console.log(`Intentando ${path} con identificador:`, JSON.stringify(identifier));
      return await proxyToLimpiafy(path, identifier);
    } catch (error) {
      lastError = error;
      console.log(`Fallo ${path} con identificador ${JSON.stringify(identifier)}: ${error?.message}`);
    }
  }
  throw lastError ?? new Error(`No fue posible ejecutar ${path}`);
}

function pickAllowed(body = {}, keys = []) {
  const out = {};
  for (const key of keys) {
    const value = body[key];
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

function normalizeAddressAliases(input = {}) {
  const body = { ...input };

  if (body.informacion_datos_llegada === undefined && body.informacion_llegada !== undefined) {
    body.informacion_datos_llegada = body.informacion_llegada;
  }
  if (body.nombre_edificio === undefined && body.edificio !== undefined) {
    body.nombre_edificio = body.edificio;
  }
  if (body.detalle_piso === undefined && body.piso !== undefined) {
    body.detalle_piso = body.piso;
  }
  if (body.cantidad_m2 === undefined && body.m2 !== undefined) body.cantidad_m2 = body.m2;
  if (body.cantidad_banos === undefined && body.banos !== undefined) body.cantidad_banos = body.banos;
  if (body.cantidad_pisos === undefined && body.pisos !== undefined) body.cantidad_pisos = body.pisos;

  delete body.informacion_llegada;
  delete body.edificio;
  delete body.piso;
  delete body.m2;
  delete body.banos;
  delete body.pisos;

  return removeEmptyFields(body);
}

app.post("/gestionar-cuenta", async (req, res) => {
  try {
    const operacion = String(req.body?.operacion ?? "").trim().toUpperCase();
    let body = removeEmptyFields({ ...req.body });
    delete body.operacion;

    if (operacion === "CREAR_SOLICITAR_OTP") {
      const required = ["tipo_cliente", "tipo_documento", "numero_documento", "email", "celular"];
      const missing = required.filter((key) => body[key] === undefined || body[key] === null || String(body[key]).trim() === "");
      if (missing.length) throw new Error(`Faltan campos para crear Usuario: ${missing.join(", ")}`);

      body.tipo_documento = await resolveDocumentTypeId(body.tipo_documento);
      body.tipo_cliente = String(body.tipo_cliente).trim().toUpperCase();

      // Construir el payload canonico documentado por Limpiafy.
      // Para PERSONA NATURAL nunca enviamos razon_social, aunque Respond.io
      // la incluya vacia en la peticion visible del agente.
      const payload = pickAllowed(body, [
        "tipo_cliente", "tipo_documento", "numero_documento",
        "nombres", "apellidos", "email", "celular",
        "actividad_comercial"
      ]);

      if (payload.tipo_cliente === "PERSONA NATURAL") {
        // El contrato documentado de /agenteIA/crear-usuario incluye
        // razon_social:"" aun para PERSONA NATURAL. No se solicita al
        // Usuario ni se interpreta como dato empresarial; se envia vacio
        // solo por compatibilidad con validadores legacy del backend.
        payload.razon_social = "";
        delete payload.actividad_comercial;
      } else if (payload.tipo_cliente === "PERSONA JURIDICO" || payload.tipo_cliente === "PERSONA JURIDICA") {
        payload.tipo_cliente = "PERSONA JURIDICO";
        if (body.razon_social) payload.razon_social = String(body.razon_social).trim();
      }

      // Aunque aparecen como opcionales en la coleccion, son los valores
      // canonicos usados por el flujo de Agente IA y evitan diferencias con
      // el alta realizada desde los clientes oficiales.
      payload.canal_origen = "AGENTE_IA";
      payload.envio_notificaciones_wsp = 1;

      console.log("Gestion cuenta CREAR_SOLICITAR_OTP normalizado:", JSON.stringify(payload));

      try {
        return res.json(await proxyToLimpiafy("agenteIA/crear-usuario", payload));
      } catch (firstError) {
        // Compatibilidad con implementaciones historicas del controlador que
        // consultan dni_cliente durante el alta aunque el contrato actual use
        // numero_documento. Solo reintentamos ante error del backend.
        const fallbackPayload = { ...payload, dni_cliente: payload.numero_documento };
        console.log("Reintento crear-usuario con dni_cliente compatible:", JSON.stringify(fallbackPayload));
        try {
          return res.json(await proxyToLimpiafy("agenteIA/crear-usuario", fallbackPayload));
        } catch (secondError) {
          // Preservar el error mas informativo del segundo intento y adjuntar
          // el primero para facilitar diagnostico en EasyPanel.
          if (secondError && typeof secondError === "object") {
            secondError.firstPayload = firstError?.payload;
          }
          throw secondError;
        }
      }
    }

    if (operacion === "CREAR_CONFIRMAR_OTP") {
      const payload = pickAllowed(body, ["numero_documento", "otp"]);
      if (!payload.numero_documento || !payload.otp) throw new Error("Faltan numero_documento u otp para confirmar Usuario");
      return res.json(await proxyToLimpiafy("agenteIA/confirmar-crear-usuario", payload));
    }

    if (operacion === "ACTUALIZAR_SOLICITAR_OTP") {
      const identifier = firstClientIdentifier(body);
      return res.json(await proxyToLimpiafy("agenteIA/solicitar-actualizacion-usuario", identifier));
    }

    if (operacion === "ACTUALIZAR_CONFIRMAR_OTP") {
      if (!body.otp) throw new Error("Falta otp para confirmar actualización de Usuario");
      if (body.tipo_documento !== undefined) body.tipo_documento = await resolveDocumentTypeId(body.tipo_documento);
      const identifier = firstClientIdentifier(body);
      const payload = {
        ...identifier,
        ...pickAllowed(body, [
          "otp", "tipo_documento", "tipo_cliente", "dni_cliente", "actividad_comercial",
          "canal_origen", "envio_notificaciones_wsp", "aplicar_rtf", "nombres", "apellidos",
          "razon_social", "email", "celular", "email2", "celular2"
        ])
      };
      return res.json(await proxyToLimpiafy("agenteIA/confirmar-actualizacion-usuario", payload));
    }

    throw new Error("operacion inválida. Usa: CREAR_SOLICITAR_OTP, CREAR_CONFIRMAR_OTP, ACTUALIZAR_SOLICITAR_OTP o ACTUALIZAR_CONFIRMAR_OTP");
  } catch (error) { return bridgeError(res, error); }
});

app.post("/gestionar-direcciones", async (req, res) => {
  try {
    const operacion = String(req.body?.operacion ?? "").trim().toUpperCase();
    let body = normalizeAddressAliases(removeEmptyFields({ ...req.body }));
    delete body.operacion;

    if (operacion === "LISTAR") {
      const identifier = firstClientIdentifier(body);
      return res.json(await proxyToLimpiafy("agenteIA/listar-direcciones", identifier));
    }

    if (operacion === "CREAR_SOLICITAR_OTP") {
      // Este endpoint SOLO necesita identificar al Usuario. No reenviamos ciudad,
      // inmueble o dirección todavía; esos datos pertenecen a la confirmación OTP.
      console.log("Gestion direccion CREAR_SOLICITAR_OTP recibido:", JSON.stringify(body));
      return res.json(await proxyWithIdentifierFallback("agenteIA/solicitar-crear-direccion", body));
    }

    if (operacion === "CREAR_CONFIRMAR_OTP") {
      const identifier = firstClientIdentifier(body);
      const required = ["otp", "prm_ciudad", "prm_tipo_inmueble", "nombre_referencia", "direccion"];
      const missing = required.filter((key) => body[key] === undefined || body[key] === null || String(body[key]).trim() === "");
      if (missing.length) throw new Error(`Faltan campos para confirmar dirección: ${missing.join(", ")}`);

      const payload = {
        ...identifier,
        ...pickAllowed(body, [
          "otp", "prm_ciudad", "prm_tipo_inmueble", "nombre_referencia", "direccion",
          "informacion_datos_llegada", "nombre_edificio", "detalle_piso", "cantidad_m2",
          "cantidad_banos", "cantidad_pisos", "minuta", "coordenada_longitud", "coordenada_latitud"
        ])
      };
      payload.prm_ciudad = Number(await resolveCityId(payload.prm_ciudad));
      payload.prm_tipo_inmueble = Number(await resolvePropertyTypeId(payload.prm_tipo_inmueble));
      return res.json(await proxyToLimpiafy("agenteIA/confirmar-crear-direccion", payload));
    }

    if (operacion === "ACTUALIZAR_SOLICITAR_OTP") {
      if (!body.id_direccion) throw new Error("Falta id_direccion para solicitar actualización");
      const identifier = firstClientIdentifier(body);
      const payload = { ...identifier, id_direccion: Number(body.id_direccion) };
      return res.json(await proxyToLimpiafy("agenteIA/solicitar-actualizar-direccion", payload));
    }

    if (operacion === "ACTUALIZAR_CONFIRMAR_OTP") {
      if (!body.id_direccion || !body.otp) throw new Error("Faltan id_direccion u otp para confirmar actualización");
      const identifier = firstClientIdentifier(body);
      const payload = {
        ...identifier,
        ...pickAllowed(body, [
          "otp", "prm_ciudad", "prm_tipo_inmueble", "estado", "nombre_referencia", "direccion",
          "informacion_datos_llegada", "nombre_edificio", "detalle_piso", "cantidad_m2",
          "cantidad_banos", "cantidad_pisos", "minuta", "coordenada_longitud", "coordenada_latitud"
        ]),
        id_direccion: Number(body.id_direccion)
      };
      if (payload.prm_ciudad) payload.prm_ciudad = Number(await resolveCityId(payload.prm_ciudad));
      if (payload.prm_tipo_inmueble) payload.prm_tipo_inmueble = Number(await resolvePropertyTypeId(payload.prm_tipo_inmueble));
      return res.json(await proxyToLimpiafy("agenteIA/confirmar-actualizar-direccion", payload));
    }

    throw new Error("operacion inválida. Usa: LISTAR, CREAR_SOLICITAR_OTP, CREAR_CONFIRMAR_OTP, ACTUALIZAR_SOLICITAR_OTP o ACTUALIZAR_CONFIRMAR_OTP");
  } catch (error) { return bridgeError(res, error); }
});

app.post("/modificar-reserva", async (req, res) => {
  try {
    const operacion = String(req.body?.operacion ?? "").trim().toUpperCase();
    const rutas = {
      SIMULAR: "agenteIA/simular-modificacion-reserva",
      CONFIRMAR: "agenteIA/confirmar-modificacion-reserva"
    };
    const path = rutas[operacion];
    if (!path) throw new Error(`operacion inválida. Usa: ${Object.keys(rutas).join(", ")}`);

    const body = removeEmptyFields({ ...req.body });
    delete body.operacion;
    return res.json(await proxyToLimpiafy(path, body));
  } catch (error) { return bridgeError(res, error); }
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

app.post("/consultar-detalle-paquete", async (req, res) => {
  try {
    const valor = req.body?.prm_paquete ?? req.body?.valor ?? "";
    return res.json(await buscar("DETALLE_PAQUETE", valor));
  } catch (error) { return bridgeError(res, error); }
});

app.post("/consultar-cliente", async (req, res) => {
  try {
    const valor = req.body?.valor ?? req.body?.dni_cliente ?? req.body?.celular ?? req.body?.email ?? "";
    return res.json(await buscar("CLIENTE_EXISTE", valor));
  } catch (error) { return bridgeError(res, error); }
});

app.post("/consultar-direcciones", async (req, res) => {
  try {
    const valor = req.body?.valor ?? req.body?.dni_cliente ?? req.body?.celular ?? req.body?.email ?? "";
    return res.json(await buscar("DIRECCIONES_CLIENTE", valor));
  } catch (error) { return bridgeError(res, error); }
});

app.post("/consultar-cupon", async (req, res) => {
  try {
    const valor = req.body?.cupon ?? req.body?.valor ?? "";
    return res.json(await buscar("CONSULTAR_CUPON", valor));
  } catch (error) { return bridgeError(res, error); }
});

app.post("/estado-servicio", async (req, res) => {
  try { return res.json(await proxyToLimpiafy("agenteIA/estado-servicio", req.body)); }
  catch (error) { return bridgeError(res, error); }
});

app.post("/disponibilidad-partner", async (req, res) => {
  try {
    const result = await proxyToLimpiafy("agenteIA/disponibilidad-partner", req.body, async (body) => {
      if (!body.prm_ciudad) throw new Error("Falta prm_ciudad");
      body.prm_ciudad = Number(await resolveCityId(body.prm_ciudad));
      if (body.prm_paquete) body.prm_paquete = Number(await resolvePackageId(body.prm_paquete, body.prm_tipo_inmueble ?? ""));
      body.calendario = normalizeCalendar(body.calendario);
      return body;
    });
    return res.json(result);
  } catch (error) { return bridgeError(res, error); }
});

app.post("/pagar", async (req, res) => {
  try { return res.json(await proxyToLimpiafy("agenteIA/pagar", req.body)); }
  catch (error) { return bridgeError(res, error); }
});

app.post("/crear-usuario", async (req, res) => {
  try {
    const body = removeEmptyFields({ ...req.body });
    if (body.tipo_documento !== undefined) body.tipo_documento = await resolveDocumentTypeId(body.tipo_documento);
    return res.json(await proxyToLimpiafy("agenteIA/crear-usuario", body));
  } catch (error) { return bridgeError(res, error); }
});

app.post("/confirmar-crear-usuario", async (req, res) => {
  try { return res.json(await proxyToLimpiafy("agenteIA/confirmar-crear-usuario", req.body)); }
  catch (error) { return bridgeError(res, error); }
});

app.post("/solicitar-actualizacion-usuario", async (req, res) => {
  try { return res.json(await proxyToLimpiafy("agenteIA/solicitar-actualizacion-usuario", req.body)); }
  catch (error) { return bridgeError(res, error); }
});

app.post("/confirmar-actualizacion-usuario", async (req, res) => {
  try {
    const body = removeEmptyFields({ ...req.body });
    if (body.tipo_documento !== undefined) body.tipo_documento = await resolveDocumentTypeId(body.tipo_documento);
    return res.json(await proxyToLimpiafy("agenteIA/confirmar-actualizacion-usuario", body));
  } catch (error) { return bridgeError(res, error); }
});

app.post("/listar-direcciones", async (req, res) => {
  try { return res.json(await proxyToLimpiafy("agenteIA/listar-direcciones", req.body)); }
  catch (error) { return bridgeError(res, error); }
});

app.post("/solicitar-crear-direccion", async (req, res) => {
  try { return res.json(await proxyToLimpiafy("agenteIA/solicitar-crear-direccion", req.body)); }
  catch (error) { return bridgeError(res, error); }
});

app.post("/confirmar-crear-direccion", async (req, res) => {
  try {
    const result = await proxyToLimpiafy("agenteIA/confirmar-crear-direccion", req.body, async (body) => {
      if (body.prm_ciudad) body.prm_ciudad = Number(await resolveCityId(body.prm_ciudad));
      if (body.prm_tipo_inmueble) body.prm_tipo_inmueble = Number(await resolvePropertyTypeId(body.prm_tipo_inmueble));
      return body;
    });
    return res.json(result);
  } catch (error) { return bridgeError(res, error); }
});

app.post("/solicitar-actualizar-direccion", async (req, res) => {
  try { return res.json(await proxyToLimpiafy("agenteIA/solicitar-actualizar-direccion", req.body)); }
  catch (error) { return bridgeError(res, error); }
});

app.post("/confirmar-actualizar-direccion", async (req, res) => {
  try {
    const result = await proxyToLimpiafy("agenteIA/confirmar-actualizar-direccion", req.body, async (body) => {
      if (body.prm_ciudad) body.prm_ciudad = Number(await resolveCityId(body.prm_ciudad));
      if (body.prm_tipo_inmueble) body.prm_tipo_inmueble = Number(await resolvePropertyTypeId(body.prm_tipo_inmueble));
      return body;
    });
    return res.json(result);
  } catch (error) { return bridgeError(res, error); }
});

app.post("/simular-modificacion-reserva", async (req, res) => {
  try { return res.json(await proxyToLimpiafy("agenteIA/simular-modificacion-reserva", req.body)); }
  catch (error) { return bridgeError(res, error); }
});

app.post("/confirmar-modificacion-reserva", async (req, res) => {
  try { return res.json(await proxyToLimpiafy("agenteIA/confirmar-modificacion-reserva", req.body)); }
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

    add4PMTaskIfNeeded(payload, input, calendario);

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
