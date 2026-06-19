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

function getSharp() {
  if (!sharpModule) sharpModule = require("sharp");
  return sharpModule;
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
    storageProvider: cloudinaryEnabled ? "cloudinary" : "local",
    pages
  };
}

async function ensureDirs() {
  await fsp.mkdir(TMP_DIR, { recursive: true });
  if (!(process.env.VERCEL && CATALOG_BACKEND === "cloudinary" && cloudinaryEnabled)) {
    await fsp.mkdir(DATA_DIR, { recursive: true });
  }
  if (!cloudinaryEnabled) {
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
  if (catalogCache) return catalogCache;

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
    if (CATALOG_BACKEND === "cloudinary" && cloudinaryEnabled) {
      await writeCatalog(catalogCache, false);
    }
    return catalogCache;
  } catch {
    const pages = await initialPagesFromAssets();
    catalogCache = createCatalog(pages);
    await writeCatalog(catalogCache, false);
    return catalogCache;
  }
}

async function writeCatalog(catalog, shouldBroadcast = true) {
  catalog.version = Date.now();
  catalog.updatedAt = new Date().toISOString();
  catalog.storageProvider = cloudinaryEnabled ? "cloudinary" : "local";

  if (CATALOG_BACKEND === "cloudinary" && cloudinaryEnabled) {
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
      throw new Error("Online admin changes require Cloudinary environment variables: STORAGE_PROVIDER=cloudinary, CATALOG_BACKEND=cloudinary, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.");
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
  const metadata = await getSharp()(buffer, { failOn: "none" }).metadata();
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

async function saveLocalImage(buffer, label, metadata) {
  const folder = new Date().toISOString().slice(0, 10);
  const targetDir = path.join(UPLOAD_DIR, folder);
  await fsp.mkdir(targetDir, { recursive: true });

  const outputFormat = SUPPORTED_FORMATS.has(IMAGE_OUTPUT_FORMAT)
    ? (IMAGE_OUTPUT_FORMAT === "jpg" ? "jpeg" : IMAGE_OUTPUT_FORMAT)
    : "webp";
  const ext = outputFormat === "jpeg" ? "jpg" : outputFormat;
  const fileName = `${slugify(label)}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
  const targetPath = path.join(targetDir, fileName);

  let pipeline = getSharp()(buffer, { failOn: "none" })
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
  await fsp.writeFile(targetPath, optimized);

  return {
    src: toWebPath(targetPath),
    bytes: optimized.length,
    storageProvider: "local"
  };
}

async function createPageFromBuffer(buffer, options) {
  const metadata = await validateImageBuffer(buffer, options);
  const label = options.label || slugify(options.originalName || options.sourceUrl || "Catalog page").replace(/-/g, " ");
  const stored = cloudinaryEnabled
    ? await uploadToCloudinary(buffer, label, metadata)
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
        console.log(`Storage provider: ${cloudinaryEnabled ? "cloudinary" : "local"}`);
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
