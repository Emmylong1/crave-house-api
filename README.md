# Crave House API

REST backend for the Crave House food ordering platform.

## Features

- Public menu/category endpoints
- Authenticated customer orders
- Admin product CRUD and pricing
- Admin order management/status updates
- Supabase Auth + PostgreSQL integration
- Docker-ready deployment

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

The server defaults to `http://localhost:4000`.

## Security

`SUPABASE_SERVICE_ROLE_KEY` is server-only. Never expose it in the frontend or commit a real `.env` file.
