# whatywahty

A Twitter-like social messaging app for real-time conversations and posts.

## Features

- User authentication & profiles
- Posts, comments & likes
- Real-time messaging via WebSockets
- Notifications
- Role-based access control (RBAC)
- Redis caching

## Tech Stack

- **Backend:** Node.js, Fastify
- **Database:** MongoDB (via plugin)
- **Cache:** Redis
- **Realtime:** Socket.io
- **Views:** EJS

## Quick Start

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env

# Run in development
npm run start:dev

# Run in production
npm start
```

## Configuration

Copy `.env.example` to `.env`. In production set `NODE_ENV=production`, three
random secrets of at least 32 characters (`JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`, `COOKIE_SECRET`) and the connection strings for MongoDB
and Redis.

- `APP_URL` is the public address used in password reset links.
- `SMTP_URL` (for example `smtps://user:pass@smtp.example.com:465`) is required
  for password reset emails. Without it no email is sent; in development the
  link is printed in the server log instead.
- `CORS_ORIGIN` is only needed when the frontend is hosted on another origin.
- Redis is used for caching and for revoking access tokens at logout. If Redis
  is unreachable the app keeps working without those features.

## Tests

The tests start the app on their own ports and need a running MongoDB and
Redis (`TEST_MONGODB_URI` and `TEST_REDIS_URL` override the defaults). They use
a separate database and drop it first.

```bash
npm test
```

## Project Structure

```bash
src/
├── models/       # Database models
├── plugins/      # Auth, RBAC, Redis, Socket
├── routes/       # API endpoints
├── services/     # Business logic (messages, likes, comments, mail)
├── validators/   # Input validation
└── views/        # EJS templates
public/           # Static assets (chat client in js/messages.js)
tests/            # API, socket and chat UI tests
```

## License

```bash
MIT
```
