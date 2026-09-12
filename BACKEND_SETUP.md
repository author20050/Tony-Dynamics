# Tony Dynamic shared backend

The original HTML used browser `localStorage`. That means every device had its own users and wallet. This backend moves accounts, sessions, wallet balances, transactions, and sports bets into PostgreSQL.

## 1. Install and configure

```bash
npm install
cp .env.example .env
```

Set `DATABASE_URL` in `.env`. Do not put database passwords, Paystack secret keys, or sportsbook keys into the HTML.

## 2. Create the database tables

```bash
psql "$DATABASE_URL" -f schema.sql
```

If your database provider has a SQL editor, paste `schema.sql` there instead.

## 3. Start the server

```bash
npm start
```

Open `http://localhost:3000`, not the HTML file directly. The server serves the HTML and the API from the same origin, allowing secure HTTP-only session cookies.

## API included

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `GET /api/wallet`
- `POST /api/sports-bets`
- `GET /api/sports-bets`
- `POST /api/paystack/webhook`
- `GET /api/health`

## Paystack

Set `PAYSTACK_SECRET_KEY` on the server and configure Paystack’s webhook URL as:

```text
https://your-domain.example/api/paystack/webhook
```

The webhook verifies Paystack’s signature and credits the wallet exactly once per payment reference. The browser must never be allowed to credit itself.

## Important production work

This is the shared-account foundation, not a complete licensed sportsbook. Before accepting real money:

- connect a licensed odds provider on the server;
- validate odds and event status server-side;
- settle bets from provider results;
- add rate limiting, email verification, password reset, admin role checks, audit logs, and HTTPS;
- verify local betting, age, tax, and licensing requirements.