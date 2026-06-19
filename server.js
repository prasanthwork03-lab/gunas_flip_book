require("dotenv").config({ quiet: true });

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const express = require("express");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");
const { createClient } = require("@supabase/supabase-js");

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, "data");
const CATALOG_PATH = path.join(DATA_DIR, "catalog.json");
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(ROOT, "assets", "uploads");
const TMP_DIR = process.env.TMP_DIR || (process.env.VERCEL || process.env.RENDER
  ? path.join(os.tmpdir(), "gunas-flip")
  : path.join(ROOT, "tmp"));
const PORT = Number(process.env.PORT || 4174);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "gunas@2026";
const ADMIN_SESSION_COOKIE = "gunas_admin_session";
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || `${ADMIN_PASSWORD}:gunas-session-secret`;
const ADMIN_SESSION_MAX_AGE_MS = Number(process.env.ADMIN_SESSION_MAX_AGE_HOURS || 12) * 60 * 60 * 1000;
const STORAGE_PROVIDER = (process.env.STORAGE_PROVIDER || "local").toLowerCase();
const CATALOG_BACKEND = (process.env.CATALOG_BACKEND || (STORAGE_PROVIDER === "cloudinary" ? "cloudinary" : "local")).toLowerCase();
const IMAGE_OUTPUT_FORMAT = (process.env.IMAGE_OUTPUT_FORMAT || "webp").toLowerCase();
const IMAGE_MAX_WIDTH = Number(process.env.IMAGE_MAX_WIDTH || 2400);
const IMAGE_MAX_HEIGHT = Number(process.env.IMAGE_MAX_HEIGHT || 2400);
const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || "gunas-craft/catalog";
const CLOUDINARY_MANIFEST_PUBLIC_ID = process.env.CLOUDINARY_MANIFEST_PUBLIC_ID || `${CLOUDINARY_FOLDER}/catalog-manifest.json`;
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY || "";
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "gunas-craft-catalog";
const SUPABASE_FOLDER = (process.env.SUPABASE_FOLDER || "gunas-craft/catalog").replace(/^\/+|\/+$/g, "");
const SUPABASE_MANIFEST_PATH = (process.env.SUPABASE_MANIFEST_PATH || `${SUPABASE_FOLDER}/catalog.json`).replace(/^\/+/g, "");
const MAX_CATALOG_PAGES = Number(process.env.MAX_CATALOG_PAGES || 40);
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_MB || 40) * 1024 * 1024;

const SUPPORTED_FORMATS = new Set(["jpg", "jpeg", "png", "webp", "avif"]);
const SUPPORTED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
const DEFAULT_LABELS = [
  "Cover - Guna's Craft",
  "About the Artist",
  "Sacred Strips of Devotion",
  "Crimson Sentinel",
  "Silent Majesty",
  "The Royal Plume",
  "Strength in Stillness",
  "A Portrait of Strength",
  "Symphony of Nature",
  "Peckaboo Puppy, Tropical Dream and Peacock Pride",
  "Radiant Rooster, Moonlit Ember and Festive Grace",
  "Hidden Melody, Soul Tree and Golden Cockerel",
  "Violet Serenade, Sapphire Dream and Sunburst Bird",
  "Divine Art",
  "Art Made with Devotion Brings Blessings to Every Home",
  "Customized Gifts and Name Boards",
  "Spiritual Collection",
  "Miniature and Table-top Gifts",
  "Awards and Recognitions",
  "Get in Touch"
];

const cloudinaryEnabled = STORAGE_PROVIDER === "cloudinary"
  && process.env.CLOUDINARY_CLOUD_NAME
  && process.env.CLOUDINARY_API_KEY
  && process.env.CLOUDINARY_API_SECRET;
const supabaseEnabled = STORAGE_PROVIDER === "supabase"
  && CATALOG_BACKEND === "supabase"
  && SUPABASE_URL
  && SUPABASE_SERVICE_ROLE_KEY;
const remoteCatalogEnabled = (CATALOG_BACKEND === "cloudinary" && cloudinaryEnabled)
  || (CATALOG_BACKEND === "supabase" && supabaseEnabled);
const remoteStorageEnabled = cloudinaryEnabled || supabaseEnabled;
const vercelReadOnlyMode = Boolean(process.env.VERCEL) && !remoteCatalogEnabled;
const activeStorageProvider = cloudinaryEnabled ? "cloudinary" : supabaseEnabled ? "supabase" : "local";
const hostedStorageMessage = "Online admin changes require Supabase environment variables: STORAGE_PROVIDER=supabase, CATALOG_BACKEND=supabase, SUPABASE_URL, SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_BUCKET.";
const supabase = supabaseEnabled
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  })
  : null;

if (cloudinaryEnabled) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: MAX_CATALOG_PAGES
  }
});

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: true }));

let catalogCache = null;
let catalogQueue = Promise.resolve();
const eventClients = new Set();
let sharpModule = null;
let sharpLoadAttempted = false;

function getSharp() {
  if (process.env.DISABLE_SHARP === "1") return null;
  if (!sharpLoadAttempted) {
    sharpLoadAttempted = true;
    try {
      sharpModule = require("sharp");
    } catch {
      sharpModule = null;
    }
  }
  return sharpModule;
}

function detectImageFormat(buffer, hint = {}) {
  const mime = String(hint.mime || "").toLowerCase();
  if (mime === "image/jpeg") return "jpeg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/avif") return "avif";

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buffer.length >= 16 && buffer.toString("ascii", 4, 8) === "ftyp" && /avif|avis/i.test(buffer.toString("ascii", 8, 32))) return "avif";

  const ext = path.extname(hint.originalName || hint.sourceUrl || "").replace(".", "").toLowerCase();
  if (ext === "jpg") return "jpeg";
  if (SUPPORTED_FORMATS.has(ext)) return ext;
  return null;
}

function contentTypeForFormat(format) {
  return `image/${format === "jpg" ? "jpeg" : format}`;
}

function toWebPath(filePath) {
  const uploadRelativePath = path.relative(UPLOAD_DIR, filePath);
  if (uploadRelativePath && !uploadRelativePath.startsWith("..") && !path.isAbsolute(uploadRelativePath)) {
    return ["assets", "uploads", ...uploadRelativePath.split(path.sep)].join("/");
  }
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function slugify(value) {
  return String(value || "page")
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "page";
}

function pageId() {
  return `page_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
}

function createCatalog(pages) {
  return {
    version: Date.now(),
    updatedAt: new Date().toISOString(),
    storageProvider: activeStorageProvider,
    pages
  };
}

async function ensureDirs() {
  await fsp.mkdir(TMP_DIR, { recursive: true });
  if (!vercelReadOnlyMode && !(process.env.VERCEL && remoteCatalogEnabled)) {
    await fsp.mkdir(DATA_DIR, { recursive: true });
  }
  if (!remoteStorageEnabled && !vercelReadOnlyMode) {
    await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  }
}

async function initialPagesFromAssets() {
  const pageDir = path.join(ROOT, "assets", "pages");
  const entries = await fsp.readdir(pageDir).catch(() => []);
  return entries
    .filter((name) => /^page-\d+\.(jpe?g|png|webp|avif)$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name, index) => ({
      id: `seed_${index + 1}`,
      src: `assets/pages/${name}`,
      label: DEFAULT_LABELS[index] || `Catalog page ${index + 1}`,
      source: "seed",
      storageProvider: "local",
      originalName: name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
}

async function loadCatalog() {
  if (catalogCache && !remoteCatalogEnabled) return catalogCache;

  if (CATALOG_BACKEND === "supabase" && supabaseEnabled) {
    try {
      const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(SUPABASE_MANIFEST_PATH);
      if (error) throw error;
      const raw = typeof data.text === "function"
        ? await data.text()
        : Buffer.from(await data.arrayBuffer()).toString("utf8");
      catalogCache = JSON.parse(raw);
      return catalogCache;
    } catch {
      // First run creates the manifest from bundled assets below.
    }
  }

  if (CATALOG_BACKEND === "cloudinary" && cloudinaryEnabled) {
    try {
      const resource = await cloudinary.api.resource(CLOUDINARY_MANIFEST_PUBLIC_ID, { resource_type: "raw" });
      const response = await fetch(`${resource.secure_url}?v=${resource.version}`, { cache: "no-store" });
      if (response.ok) {
        catalogCache = await response.json();
        return catalogCache;
      }
    } catch {
      // First run creates the manifest from bundled assets below.
    }
  }

  try {
    const raw = await fsp.readFile(CATALOG_PATH, "utf8");
    catalogCache = JSON.parse(raw);
    if (remoteCatalogEnabled) {
      await writeCatalog(catalogCache, false);
    }
    return catalogCache;
  } catch {
    const pages = await initialPagesFromAssets();
    catalogCache = createCatalog(pages);
    if (vercelReadOnlyMode) return catalogCache;
    await writeCatalog(catalogCache, false);
    return catalogCache;
  }
}

async function writeCatalog(catalog, shouldBroadcast = true) {
  catalog.version = Date.now();
  catalog.updatedAt = new Date().toISOString();
  catalog.storageProvider = activeStorageProvider;

  if (CATALOG_BACKEND === "supabase" && supabaseEnabled) {
    const payload = Buffer.from(JSON.stringify(catalog, null, 2));
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(SUPABASE_MANIFEST_PATH, payload, {
      contentType: "application/json",
      cacheControl: "0",
      upsert: true
    });
    if (error) throw error;
  } else if (CATALOG_BACKEND === "cloudinary" && cloudinaryEnabled) {
    const manifestPath = path.join(TMP_DIR, `catalog-${Date.now()}.json`);
    await fsp.writeFile(manifestPath, JSON.stringify(catalog, null, 2));
    await cloudinary.uploader.upload(manifestPath, {
      resource_type: "raw",
      public_id: CLOUDINARY_MANIFEST_PUBLIC_ID,
      overwrite: true,
      invalidate: true
    });
    await fsp.rm(manifestPath, { force: true }).catch(() => {});
  } else {
    if (process.env.VERCEL) {
      throw new Error(hostedStorageMessage);
    }
    const tempPath = `${CATALOG_PATH}.tmp`;
    await fsp.writeFile(tempPath, JSON.stringify(catalog, null, 2));
    await fsp.rename(tempPath, CATALOG_PATH);
  }

  catalogCache = catalog;
  if (shouldBroadcast) broadcastCatalog(catalog);
}

function withCatalog(mutator) {
  catalogQueue = catalogQueue.then(async () => {
    const catalog = await loadCatalog();
    const result = await mutator(catalog);
    await writeCatalog(catalog);
    return { catalog, result };
  });
  return catalogQueue;
}

function publicCatalog(catalog) {
  return {
    version: catalog.version,
    updatedAt: catalog.updatedAt,
    storageProvider: catalog.storageProvider,
    readOnly: vercelReadOnlyMode,
    maxPages: MAX_CATALOG_PAGES,
    pages: catalog.pages
  };
}

function assertCanAddPages(catalog, count) {
  if (catalog.pages.length + count > MAX_CATALOG_PAGES) {
    const remaining = Math.max(0, MAX_CATALOG_PAGES - catalog.pages.length);
    throw new Error(`Catalog limit is ${MAX_CATALOG_PAGES} pages. You can add ${remaining} more page(s).`);
  }
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastCatalog(catalog) {
  const payload = publicCatalog(catalog);
  eventClients.forEach((res) => sendEvent(res, "catalog", payload));
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        if (index === -1) return [item, ""];
        return [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
      })
  );
}

function signSession(payload) {
  return crypto
    .createHmac("sha256", ADMIN_SESSION_SECRET)
    .update(payload)
    .digest("base64url");
}

function createSessionCookieValue(username) {
  const payload = Buffer.from(JSON.stringify({
    u: username,
    exp: Date.now() + ADMIN_SESSION_MAX_AGE_MS
  })).toString("base64url");
  return `${payload}.${signSession(payload)}`;
}

function verifySessionCookie(value) {
  if (!value || !value.includes(".")) return false;
  const [payload, signature] = value.split(".");
  if (!payload || !signature || !timingSafeEqualText(signature, signSession(payload))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.u === ADMIN_USERNAME && data.exp > Date.now();
  } catch {
    return false;
  }
}

function setAdminCookie(res, value) {
  const maxAge = Math.floor(ADMIN_SESSION_MAX_AGE_MS / 1000);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`);
}

function clearAdminCookie(res) {
  res.setHeader("Set-Cookie", `${ADMIN_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

function hasAdminAccess(req) {
  const cookies = parseCookies(req.get("cookie") || "");
  if (verifySessionCookie(cookies[ADMIN_SESSION_COOKIE])) return true;

  const token = req.get("x-admin-token") || req.query.token || "";
  if (ADMIN_TOKEN && token && timingSafeEqualText(token, ADMIN_TOKEN)) return true;

  const auth = req.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("basic ")) return false;
  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) return false;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return timingSafeEqualText(username, ADMIN_USERNAME) && timingSafeEqualText(password, ADMIN_PASSWORD);
}

function requireAdmin(req, res, next) {
  if (hasAdminAccess(req)) return next();
  if (req.accepts("html") && !req.accepts("json")) {
    res.set("WWW-Authenticate", 'Basic realm="Gunas Craft Admin"');
    return res.status(401).send("Admin login required.");
  }
  return res.status(401).json({ error: "Admin login required" });
}

function isSupportedByName(name) {
  const ext = path.extname(name || "").replace(".", "").toLowerCase();
  return SUPPORTED_FORMATS.has(ext);
}

async function validateImageBuffer(buffer, hint = {}) {
  if (!buffer || buffer.length === 0) {
    throw new Error("Empty image file");
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image is larger than ${process.env.MAX_IMAGE_MB || 40}MB`);
  }

  const sharp = getSharp();
  if (!sharp) {
    const format = detectImageFormat(buffer, hint);
    if (!SUPPORTED_FORMATS.has(format)) {
      throw new Error(`Unsupported image format: ${hint.mime || hint.originalName || "unknown"}`);
    }
    return {
      format,
      width: null,
      height: null
    };
  }

  const metadata = await sharp(buffer, { failOn: "none" }).metadata();
  const format = metadata.format === "jpg" ? "jpeg" : metadata.format;
  if (!SUPPORTED_FORMATS.has(format)) {
    throw new Error(`Unsupported image format: ${metadata.format || hint.mime || "unknown"}`);
  }
  return metadata;
}

async function uploadToCloudinary(buffer, label, metadata) {
  const publicId = `${slugify(label)}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const dataUri = `data:image/${metadata.format};base64,${buffer.toString("base64")}`;
  const result = await cloudinary.uploader.upload(dataUri, {
    folder: CLOUDINARY_FOLDER,
    public_id: publicId,
    overwrite: false,
    resource_type: "image",
    tags: ["gunas-craft", "catalog-page"],
    context: {
      label
    }
  });
  const src = cloudinary.url(result.public_id, {
    secure: true,
    transformation: [{ quality: "auto", fetch_format: "auto" }],
    version: result.version
  });
  return {
    src,
    publicId: result.public_id,
    bytes: result.bytes,
    storageProvider: "cloudinary"
  };
}

async function optimizeImageBuffer(buffer, metadata = {}) {
  const sharp = getSharp();
  if (!sharp) {
    const format = metadata.format || detectImageFormat(buffer, metadata) || "jpeg";
    const ext = format === "jpeg" ? "jpg" : format;
    return {
      buffer,
      format,
      ext,
      contentType: contentTypeForFormat(format)
    };
  }

  const outputFormat = SUPPORTED_FORMATS.has(IMAGE_OUTPUT_FORMAT)
    ? (IMAGE_OUTPUT_FORMAT === "jpg" ? "jpeg" : IMAGE_OUTPUT_FORMAT)
    : "webp";
  const ext = outputFormat === "jpeg" ? "jpg" : outputFormat;

  let pipeline = sharp(buffer, { failOn: "none" })
    .rotate()
    .resize({
      width: IMAGE_MAX_WIDTH,
      height: IMAGE_MAX_HEIGHT,
      fit: "inside",
      withoutEnlargement: true
    });

  if (outputFormat === "jpeg") pipeline = pipeline.jpeg({ quality: 86, mozjpeg: true });
  if (outputFormat === "png") pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
  if (outputFormat === "webp") pipeline = pipeline.webp({ quality: 84 });
  if (outputFormat === "avif") pipeline = pipeline.avif({ quality: 72 });

  const optimized = await pipeline.toBuffer();
  return {
    buffer: optimized,
    format: outputFormat,
    ext,
    contentType: contentTypeForFormat(outputFormat)
  };
}

async function saveSupabaseImage(buffer, label, metadata) {
  const folder = new Date().toISOString().slice(0, 10);
  const optimized = await optimizeImageBuffer(buffer, metadata);
  const fileName = `${slugify(label)}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${optimized.ext}`;
  const objectPath = `${SUPABASE_FOLDER}/${folder}/${fileName}`;
  const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(objectPath, optimized.buffer, {
    contentType: optimized.contentType,
    cacheControl: "31536000",
    upsert: false
  });
  if (error) throw error;

  const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(objectPath);
  if (!data || !data.publicUrl) {
    throw new Error("Supabase upload succeeded but no public URL was returned. Make the bucket public.");
  }

  return {
    src: data.publicUrl,
    publicId: objectPath,
    bytes: optimized.buffer.length,
    storageProvider: "supabase"
  };
}

async function saveLocalImage(buffer, label, metadata) {
  const folder = new Date().toISOString().slice(0, 10);
  const targetDir = path.join(UPLOAD_DIR, folder);
  await fsp.mkdir(targetDir, { recursive: true });

  const optimized = await optimizeImageBuffer(buffer, metadata);
  const fileName = `${slugify(label)}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${optimized.ext}`;
  const targetPath = path.join(targetDir, fileName);

  await fsp.writeFile(targetPath, optimized.buffer);

  return {
    src: toWebPath(targetPath),
    bytes: optimized.buffer.length,
    storageProvider: "local"
  };
}

async function createPageFromBuffer(buffer, options) {
  if (vercelReadOnlyMode) {
    throw new Error(hostedStorageMessage);
  }
  const metadata = await validateImageBuffer(buffer, options);
  const label = options.label || slugify(options.originalName || options.sourceUrl || "Catalog page").replace(/-/g, " ");
  const stored = cloudinaryEnabled
    ? await uploadToCloudinary(buffer, label, metadata)
    : supabaseEnabled
      ? await saveSupabaseImage(buffer, label, metadata)
      : await saveLocalImage(buffer, label, metadata);

  return {
    id: pageId(),
    src: stored.src,
    label,
    source: options.source,
    storageProvider: stored.storageProvider,
    publicId: stored.publicId || null,
    sourceUrl: options.sourceUrl || null,
    originalName: options.originalName || null,
    width: metadata.width || null,
    height: metadata.height || null,
    format: metadata.format || null,
    bytes: stored.bytes || buffer.length,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

async function deleteStoredAsset(page) {
  if (!page) return;
  if (page.storageProvider === "cloudinary" && page.publicId && cloudinaryEnabled) {
    await cloudinary.uploader.destroy(page.publicId).catch(() => {});
    return;
  }
  if (page.storageProvider === "supabase" && page.publicId && supabaseEnabled) {
    await supabase.storage.from(SUPABASE_BUCKET).remove([page.publicId]).catch(() => {});
    return;
  }
  if (page.storageProvider === "local" && page.src && page.src.startsWith("assets/uploads/")) {
    const uploadRelativePath = page.src.replace(/^assets\/uploads\//, "").split("/").join(path.sep);
    const filePath = path.join(UPLOAD_DIR, uploadRelativePath);
    await fsp.unlink(filePath).catch(() => {});
  }
}

async function fetchImageUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Only public http/https image URLs are supported: ${url}`);
  }

  const extensionLooksValid = isSupportedByName(parsed.pathname);
  const response = await fetch(parsed.href, {
    redirect: "follow",
    headers: {
      "user-agent": "GunasCraftCatalogImporter/1.0"
    }
  });
  if (!response.ok) {
    throw new Error(`Could not download ${url} (${response.status})`);
  }
  const contentType = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (contentType && !SUPPORTED_MIME.has(contentType) && !extensionLooksValid) {
    throw new Error(`URL is not a supported image: ${url}`);
  }
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image is too large: ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function parseUrls(body) {
  if (Array.isArray(body.urls)) return body.urls.map(String).filter(Boolean);
  return String(body.urls || body.text || "")
    .split(/\r?\n|,/)
    .map((url) => url.trim())
    .filter(Boolean);
}

async function importFiles(files, source) {
  const pages = [];
  for (const file of files) {
    if (!SUPPORTED_MIME.has(file.mimetype) && !isSupportedByName(file.originalname)) {
      throw new Error(`Unsupported image: ${file.originalname}`);
    }
    const label = file.originalname ? file.originalname.replace(/\.[^.]+$/, "") : "Catalog page";
    pages.push(await createPageFromBuffer(file.buffer, {
      label,
      source,
      originalName: file.originalname,
      mime: file.mimetype
    }));
  }
  return pages;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `${command} exited with code ${code}`));
    });
  });
}

async function importPdfPages(file) {
  if (!file || (!/pdf/i.test(file.mimetype) && !/\.pdf$/i.test(file.originalname || ""))) {
    throw new Error("Please upload a PDF file");
  }
  const batchId = `pdf-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const batchDir = path.join(TMP_DIR, batchId);
  await fsp.mkdir(batchDir, { recursive: true });
  const pdfPath = path.join(batchDir, "catalog.pdf");
  await fsp.writeFile(pdfPath, file.buffer);
  const pattern = path.join(batchDir, "page-%03d.jpg");

  await runCommand("magick", [
    "-density", process.env.PDF_DENSITY || "160",
    pdfPath,
    "-alpha", "remove",
    "-background", "white",
    "-quality", process.env.PDF_JPEG_QUALITY || "88",
    pattern
  ]);

  const generated = (await fsp.readdir(batchDir))
    .filter((name) => /^page-\d+\.jpg$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!generated.length) {
    throw new Error("PDF conversion produced no images. Check ImageMagick/Ghostscript PDF support.");
  }

  const pages = [];
  for (const [index, name] of generated.entries()) {
    const buffer = await fsp.readFile(path.join(batchDir, name));
    pages.push(await createPageFromBuffer(buffer, {
      label: `${file.originalname.replace(/\.pdf$/i, "")} page ${index + 1}`,
      source: "pdf",
      originalName: `${file.originalname} / ${name}`
    }));
  }
  await fsp.rm(batchDir, { recursive: true, force: true }).catch(() => {});
  return pages;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get(["/admin", "/admin.html"], (req, res) => {
  res.sendFile(path.join(ROOT, "admin.html"));
});

app.use("/assets/uploads", express.static(UPLOAD_DIR, {
  etag: false,
  maxAge: 0
}));

app.use(express.static(ROOT, {
  extensions: ["html"],
  etag: false,
  maxAge: 0
}));

app.get("/api/catalog", asyncHandler(async (req, res) => {
  res.json(publicCatalog(await loadCatalog()));
}));

app.post("/api/admin/login", asyncHandler(async (req, res) => {
  const { username = "", password = "" } = req.body || {};
  if (!timingSafeEqualText(username, ADMIN_USERNAME) || !timingSafeEqualText(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  setAdminCookie(res, createSessionCookieValue(username));
  res.json({
    ok: true,
    username: ADMIN_USERNAME,
    maxPages: MAX_CATALOG_PAGES
  });
}));

app.post("/api/admin/logout", (req, res) => {
  clearAdminCookie(res);
  res.json({ ok: true });
});

app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({
    ok: true,
    username: ADMIN_USERNAME,
    maxPages: MAX_CATALOG_PAGES
  });
});

app.get("/api/events", asyncHandler(async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  eventClients.add(res);
  sendEvent(res, "catalog", publicCatalog(await loadCatalog()));
  const keepAlive = setInterval(() => sendEvent(res, "ping", { at: Date.now() }), 25000);
  req.on("close", () => {
    clearInterval(keepAlive);
    eventClients.delete(res);
  });
}));

app.post("/api/images/upload", requireAdmin, upload.array("images", MAX_CATALOG_PAGES), asyncHandler(async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "No images uploaded" });
  assertCanAddPages(await loadCatalog(), files.length);
  const pages = await importFiles(files, "upload");
  const { catalog } = await withCatalog((draft) => {
    assertCanAddPages(draft, pages.length);
    draft.pages.push(...pages);
  });
  res.json({ added: pages, catalog: publicCatalog(catalog) });
}));

app.post("/api/images/import-urls", requireAdmin, asyncHandler(async (req, res) => {
  const urls = parseUrls(req.body);
  if (!urls.length) return res.status(400).json({ error: "No image URLs provided" });
  assertCanAddPages(await loadCatalog(), urls.length);
  const pages = [];
  const errors = [];
  for (const url of urls) {
    try {
      const buffer = await fetchImageUrl(url);
      pages.push(await createPageFromBuffer(buffer, {
        label: path.basename(new URL(url).pathname).replace(/\.[^.]+$/, "") || "URL image",
        source: "url",
        sourceUrl: url
      }));
    } catch (error) {
      errors.push({ url, error: error.message });
    }
  }
  if (!pages.length) return res.status(400).json({ error: "No URLs imported", errors });
  const { catalog } = await withCatalog((draft) => {
    assertCanAddPages(draft, pages.length);
    draft.pages.push(...pages);
  });
  res.json({ added: pages, errors, catalog: publicCatalog(catalog) });
}));

app.post("/api/pdf/upload", requireAdmin, upload.single("pdf"), asyncHandler(async (req, res) => {
  assertCanAddPages(await loadCatalog(), 1);
  const pages = await importPdfPages(req.file);
  const { catalog } = await withCatalog((draft) => {
    assertCanAddPages(draft, pages.length);
    draft.pages.push(...pages);
  });
  res.json({ added: pages, catalog: publicCatalog(catalog) });
}));

app.post("/api/pages/:id/replace", requireAdmin, upload.single("image"), asyncHandler(async (req, res) => {
  const id = req.params.id;
  let replacement;
  if (req.file) {
    replacement = await createPageFromBuffer(req.file.buffer, {
      label: req.body.label || req.file.originalname.replace(/\.[^.]+$/, ""),
      source: "replace-upload",
      originalName: req.file.originalname,
      mime: req.file.mimetype
    });
  } else if (req.body.url) {
    const buffer = await fetchImageUrl(req.body.url);
    replacement = await createPageFromBuffer(buffer, {
      label: req.body.label || path.basename(new URL(req.body.url).pathname).replace(/\.[^.]+$/, "") || "URL replacement",
      source: "replace-url",
      sourceUrl: req.body.url
    });
  } else {
    return res.status(400).json({ error: "Upload an image or provide a URL" });
  }

  const { catalog } = await withCatalog(async (draft) => {
    const index = draft.pages.findIndex((page) => page.id === id);
    if (index === -1) throw new Error("Page not found");
    const oldPage = draft.pages[index];
    draft.pages[index] = {
      ...replacement,
      id,
      label: req.body.label || oldPage.label || replacement.label,
      createdAt: oldPage.createdAt,
      updatedAt: new Date().toISOString()
    };
    await deleteStoredAsset(oldPage);
  });
  res.json({ catalog: publicCatalog(catalog) });
}));

app.post("/api/pages/:id/replace-url", requireAdmin, asyncHandler(async (req, res) => {
  if (!req.body.url) return res.status(400).json({ error: "Provide an image URL" });
  const buffer = await fetchImageUrl(req.body.url);
  const replacement = await createPageFromBuffer(buffer, {
    label: req.body.label || path.basename(new URL(req.body.url).pathname).replace(/\.[^.]+$/, "") || "URL replacement",
    source: "replace-url",
    sourceUrl: req.body.url
  });

  const { catalog } = await withCatalog(async (draft) => {
    const index = draft.pages.findIndex((page) => page.id === req.params.id);
    if (index === -1) throw new Error("Page not found");
    const oldPage = draft.pages[index];
    draft.pages[index] = {
      ...replacement,
      id: req.params.id,
      label: req.body.label || oldPage.label || replacement.label,
      createdAt: oldPage.createdAt,
      updatedAt: new Date().toISOString()
    };
    await deleteStoredAsset(oldPage);
  });
  res.json({ catalog: publicCatalog(catalog) });
}));

app.patch("/api/pages/:id", requireAdmin, asyncHandler(async (req, res) => {
  const { catalog } = await withCatalog((draft) => {
    const page = draft.pages.find((item) => item.id === req.params.id);
    if (!page) throw new Error("Page not found");
    if (typeof req.body.label === "string") {
      page.label = req.body.label.trim() || page.label;
      page.updatedAt = new Date().toISOString();
    }
  });
  res.json({ catalog: publicCatalog(catalog) });
}));

app.patch("/api/catalog/reorder", requireAdmin, asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const { catalog } = await withCatalog((draft) => {
    const pageById = new Map(draft.pages.map((page) => [page.id, page]));
    const reordered = ids.map((id) => pageById.get(id)).filter(Boolean);
    if (reordered.length !== draft.pages.length) {
      throw new Error("Reorder list must include every page exactly once");
    }
    draft.pages = reordered;
  });
  res.json({ catalog: publicCatalog(catalog) });
}));

app.patch("/api/pages/:id/move", requireAdmin, asyncHandler(async (req, res) => {
  const action = String(req.body.action || "");
  const { catalog } = await withCatalog((draft) => {
    const pages = draft.pages;
    const index = pages.findIndex((page) => page.id === req.params.id);
    if (index === -1) throw new Error("Page not found");
    const [page] = pages.splice(index, 1);
    if (action === "up") pages.splice(Math.max(0, index - 1), 0, page);
    else if (action === "down") pages.splice(Math.min(pages.length, index + 1), 0, page);
    else if (action === "first") pages.unshift(page);
    else if (action === "last") pages.push(page);
    else throw new Error("Unsupported move action");
  });
  res.json({ catalog: publicCatalog(catalog) });
}));

app.delete("/api/pages/:id", requireAdmin, asyncHandler(async (req, res) => {
  const { catalog } = await withCatalog(async (draft) => {
    if (draft.pages.length <= 1) throw new Error("Catalog must keep at least one page");
    const index = draft.pages.findIndex((page) => page.id === req.params.id);
    if (index === -1) throw new Error("Page not found");
    const [removed] = draft.pages.splice(index, 1);
    await deleteStoredAsset(removed);
  });
  res.json({ catalog: publicCatalog(catalog) });
}));

app.post("/api/catalog/publish", requireAdmin, asyncHandler(async (req, res) => {
  const catalog = await loadCatalog();
  broadcastCatalog(catalog);
  res.json({ ok: true, catalog: publicCatalog(catalog) });
}));

app.use((error, req, res, next) => {
  console.error(error);
  res.status(400).json({
    error: error.message || "Request failed"
  });
});

async function start() {
  await ensureDirs();
  await loadCatalog();
  return app;
}

let appPromise = null;

function getApp() {
  if (!appPromise) appPromise = start();
  return appPromise;
}

async function handler(req, res) {
  const readyApp = await getApp();
  return readyApp(req, res);
}

if (require.main === module) {
  getApp()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Gunas Craft flipbook running at http://127.0.0.1:${PORT}`);
        console.log(`Admin panel: http://127.0.0.1:${PORT}/admin.html`);
        console.log(`Username: ${ADMIN_USERNAME}`);
        console.log(`Storage provider: ${activeStorageProvider}`);
        console.log(`Catalog backend: ${CATALOG_BACKEND}`);
        console.log(`Max pages: ${MAX_CATALOG_PAGES}`);
      });
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = handler;
module.exports.appPromise = getApp();
