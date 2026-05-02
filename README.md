# WibuStream API — Deploy Guide

## Deploy ke Railway (gratis)

1. Buat akun di https://railway.app
2. Klik **New Project → Deploy from GitHub**
3. Upload folder `wibustream-api` ini ke GitHub repo baru
4. Railway otomatis detect Node.js dan deploy
5. Setelah deploy, copy URL-nya (contoh: `https://wibustream-api.up.railway.app`)

## Hubungkan ke WibuStream (InfinityFree)

Buka `inc/config.php`, isi:
```php
define('WIBU_API_URL', 'https://wibustream-api.up.railway.app');
```

## Test API

- Health check: `https://your-url.railway.app/health`
- Watch test: `https://your-url.railway.app/watch?id=mal-51553-1|jikan`
