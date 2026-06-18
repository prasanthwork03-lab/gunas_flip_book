# Gunas Craft Digital Catalog

Production-ready flipbook catalog with a simple admin panel.

## Local URLs

- Public catalog: `http://127.0.0.1:4173/index.html`
- Admin panel: `http://127.0.0.1:4173/admin.html`

## Admin Features

- Username/password login
- Upload catalog images
- Import public image URLs in bulk
- Replace and delete pages
- Drag/drop reorder
- Move up, down, first and last
- Live public flipbook sync
- Maximum 40 catalog pages

## Production Storage

For Vercel production, use Cloudinary. This is required because Vercel serverless functions do not keep local uploads or JSON changes permanently.

Set these Vercel environment variables:

```text
ADMIN_USERNAME=admin
ADMIN_PASSWORD=use-a-strong-password
ADMIN_SESSION_SECRET=use-a-long-random-secret
MAX_CATALOG_PAGES=40

STORAGE_PROVIDER=cloudinary
CATALOG_BACKEND=cloudinary
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=your-api-key
CLOUDINARY_API_SECRET=your-api-secret
CLOUDINARY_FOLDER=gunas-craft/catalog
CLOUDINARY_MANIFEST_PUBLIC_ID=gunas-craft/catalog/catalog-manifest.json
```

## Deploy

1. Push this folder to GitHub.
2. Import the GitHub repository in Vercel.
3. Add the environment variables above in Vercel Project Settings.
4. Deploy production.

After deployment:

- Admin URL: `https://your-domain/admin.html`
- Public catalog: `https://your-domain/index.html`

Admin changes update the public flipbook automatically through live sync and a polling fallback.
