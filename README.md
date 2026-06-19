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
- Maximum 8 MB per image

## Production Storage

For free production hosting, use Vercel for the app and Supabase Storage for uploaded catalog images plus the catalog JSON manifest. This avoids paid Render disks and keeps admin changes durable.

Create a public Supabase Storage bucket, then set these Vercel environment variables:

```text
ADMIN_USERNAME=admin
ADMIN_PASSWORD=use-a-strong-password
ADMIN_SESSION_SECRET=use-a-long-random-secret
MAX_CATALOG_PAGES=40
MAX_IMAGE_MB=8

STORAGE_PROVIDER=supabase
CATALOG_BACKEND=supabase
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SECRET_KEY=your-server-secret-key
SUPABASE_BUCKET=gunas-craft-catalog
SUPABASE_FOLDER=gunas-craft/catalog
SUPABASE_MANIFEST_PATH=gunas-craft/catalog/catalog.json
```

## Deploy

### Vercel

1. Push this folder to GitHub.
2. Import the GitHub repository in Vercel.
3. Add the Supabase environment variables above in Vercel Project Settings.
4. Deploy production.

After deployment:

- Admin URL: `https://your-domain/admin.html`
- Public catalog: `https://your-domain/index.html`

Admin changes update the public flipbook automatically through live sync and a polling fallback.
